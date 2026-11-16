/**
 * lib/channels/publicacao-de-status.ts — o Status do WhatsApp PELO adapter (#3397).
 *
 * ─── O que havia antes ──────────────────────────────────────────────────────
 *
 * A ideia nasceu no #2668 como ferramenta MCP que publicava Status chamando o
 * cliente do provedor direto (`getWahaClient().sendStatusImage`). Três coisas
 * tornavam aquele caminho caro, e todas as três são de ARQUITETURA, não de
 * gosto:
 *
 *  1. **Nomeava o provedor fora do seam.** Era a única operação de saída que
 *     não passava pelo contrato do adapter — e o lint de canal
 *     (`scripts/lint-channels.ts`) existe justamente para impedir que uma
 *     feature saiba QUAL transporte está do outro lado.
 *  2. **Ligava o acervo do NOWEB em toda sessão.** A #999 decidiu o contrário:
 *     o acervo fica desligado por padrão e liga por conexão, na tela. Feature
 *     nenhuma liga sozinha.
 *  3. **Não reservava a idempotência antes do envio**, então um retry podia
 *     publicar em dobro — e Status é peça de marketing, onde a duplicata tem
 *     custo de imagem, não de mensagem.
 *
 * ─── O desenho de agora ─────────────────────────────────────────────────────
 *
 * Este módulo é o único caminho para publicar Status, e ele não conhece
 * provedor nenhum:
 *
 *  - a SESSÃO diz qual é o canal, e `capabilitiesOf` diz se ele publica Status
 *    (`statusUpdates`). Quem não publica responde `false` — não é erro, é a
 *    operação que não existe ali, e a mensagem da recusa diz isso em português;
 *  - quem executa é `adapter.publishStatus`, opcional no contrato: o adapter
 *    traduz o público (telefones em dígitos) para o dialeto do canal;
 *  - `canalDesativado()` é conferido antes, como nos demais envios: canal
 *    desligado pelo operador não publica;
 *  - o público é uma ESCOLHA declarada (`todos` ou lista), nunca deduzida de um
 *    array vazio — no transporte, lista vazia e "sem lista" são a mesma coisa;
 *  - quem pediu para sair, foi apagado a pedido ou é contato pessoal fica fora
 *    da lista (`semQuemSaiu`), e a resposta diz quantos saíram;
 *  - a lista é validada sobre os DÍGITOS, não sobre a string crua: `+55 (15)
 *    99999-9999` é um telefone, e recusá-lo por causa da máscara seria recusar
 *    o formato em que as pessoas escrevem número;
 *  - a chave de idempotência é RESERVADA antes do efeito (`comIdempotencia`),
 *    com o hash gravado no formato da coluna (`hashDaColuna`).
 *
 * ─── O acervo do histórico ──────────────────────────────────────────────────
 *
 * Quem depende do acervo é `todos`, não a lista. Na fonte do WAHA, na tag que o
 * kit fixa (2026.7.2, `prepareJidsForStatus` em `session.noweb.core.ts`), a
 * LISTA vira JID direto e não consulta nada; SEM lista ele busca os contatos no
 * acervo (`store.getContacts`), e com o `noweb.store` desligado essa busca
 * responde 400. Lido na fonte, não medido num número pareado.
 *
 * Este módulo lê a opção por conexão (`lerGuardarHistorico`, chave
 * `guardar_historico` do `metadata`) e, quando `todos` a encontra desligada,
 * EXPLICA o que falta em vez de ligar por conta própria: a decisão da #999 é que
 * quem liga é o operador, na tela. A lista segue valendo sem o acervo.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { comIdempotencia } from "@/lib/api/idempotency";
import { ehContatoPessoal, type MarcaDePessoal } from "@/lib/contacts/contato-pessoal";
import { lotesDeIds } from "@/lib/kanban/selecao";

import { lerGuardarHistorico } from "./acervo-do-historico";
import { capabilitiesOf } from "./capabilities";
import { canalDesativado } from "./desativado";
import { getAdapter } from "./index";
import { phoneLookupVariants } from "./phone-variants";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  resolveSessionRef,
  type ChannelSessionRef,
} from "./session-ref";
import type { ChannelProvider, PublicoDoStatus } from "./types";

/**
 * O `endpoint` da chave de idempotência. É o MESMO nome da ferramenta MCP de
 * propósito: a chave que o chamador manda vale para a operação que ele chamou,
 * e um cliente que repete a chamada com a mesma chave recebe a publicação
 * anterior em vez de publicar de novo.
 */
export const ENDPOINT_DA_PUBLICACAO_DE_STATUS = "mcp:crm_publish_whatsapp_status";

/** Limite de legenda do Status, medido no app (não é o do envio de mensagem). */
export const LEGENDA_MAXIMA = 1000;

/**
 * O código gravado no recibo da publicação sem resposta do canal. Recibo, e não
 * erro: é a linha terminal em `idempotency_keys` que faz o retry com a mesma
 * chave saber que pode já ter saído, em vez de publicar de novo.
 */
const STATUS_INCERTO = 504;

/**
 * Um telefone em dígitos: 8 a 15 (E.164 é até 15; 8 cobre fixo local com DDI).
 *
 * A validação roda sobre a string JÁ normalizada — é o que permite aceitar
 * `+55 (15) 99999-9999` sem aceitar `abc`. Aplicar o regex na string crua
 * recusaria o formato em que as pessoas escrevem telefone.
 */
const Telefone = z.string().regex(/^\d{8,15}$/);

/** Tira tudo que não é dígito — a máscara é de quem digita, não do canal. */
export function digitosDoTelefone(valor: string): string {
  return valor.replace(/\D/g, "");
}

/**
 * Valida a lista de público DEPOIS de normalizar. Devolve os dígitos na ordem
 * recebida e sem repetição (mandar o mesmo número duas vezes é ruído, não
 * público).
 *
 * Recusa dizendo QUAL entrada está errada pela POSIÇÃO, nunca pelo valor: quem
 * chama é outro sistema, e "lista inválida" não dá o que consertar, mas esta
 * mensagem vai para `metadata.error` da auditoria, e o valor recusado pode ser
 * um telefone com um dígito a menos ou o nome de alguém.
 */
export function lerPublico(contatos: readonly string[] | undefined): PublicoDoStatus {
  if (!contatos || contatos.length === 0) {
    throw new Error(
      "publico_ausente: informe a lista de contatos ou `todos: true`. O Status nunca sai para todos por omissão.",
    );
  }
  const numeros: string[] = [];
  for (const [posicao, bruto] of contatos.entries()) {
    const lido = Telefone.safeParse(digitosDoTelefone(bruto));
    if (!lido.success) {
      throw new Error(
        `contato_invalido: a entrada ${posicao + 1} da lista não é um telefone em dígitos (8 a 15, com DDI).`,
      );
    }
    if (!numeros.includes(lido.data)) numeros.push(lido.data);
  }
  return { tipo: "contatos", numeros };
}

/** O que da ficha decide se ela sai do público. */
type FichaDoPublico = MarcaDePessoal & {
  is_blocked?: boolean | null;
  is_anonymized?: boolean | null;
};

function fichaForaDoPublico(ficha: FichaDoPublico | null): boolean {
  return Boolean(ficha?.is_blocked || ficha?.is_anonymized || ehContatoPessoal(ficha));
}

/**
 * Pergunta à marca de apagamento, com a régua da importação do histórico. Quem
 * chama lança `opt_out_ilegivel` em vez de ler a dúvida como "não foi apagado".
 */
async function foiApagadoAPedido(
  db: SupabaseClient,
  organizationId: string,
  numero: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("fn_titular_apagado_a_pedido", {
    p_org: organizationId,
    p_telefone: numero,
    p_lid: null,
  });
  if (error) throw new Error(`opt_out_ilegivel: ${error.message}`);
  if (typeof data !== "boolean") throw new Error("opt_out_ilegivel: resposta sem booleano");
  return data;
}

/**
 * Tira da lista quem não pode ser alcançado, pelas duas grafias do número (nono
 * dígito) e também pelos telefones extras da ficha: contato bloqueado (pediu para
 * sair), anonimizado ou marcado como pessoal. A lista vem de fora, e essas regras
 * valem para qualquer saída do número. Em `todos` não há lista a filtrar: quem vê
 * é decidido pelo WhatsApp, e o interruptor do módulo diz isso.
 *
 * O apagado a pedido não aparece nas duas leituras: a cascata de LGPD zera
 * `contacts.phone_number` e apaga as linhas de `contact_phones`, então o número
 * deixa de casar com qualquer ficha. O que sobra dele é a marca da anonimização
 * (`lgpd_marcas_de_apagamento`, telefone principal e lid), e por isso a pergunta é
 * a `fn_titular_apagado_a_pedido`. A supressão de `lib/prospecting/store.ts` não
 * serve aqui: ela mora em `prospecting_candidates` e só existe para quem foi
 * candidato de prospecção.
 *
 * Falha fechada: sem saber quem saiu, nada é publicado.
 */
async function semQuemSaiu(
  db: SupabaseClient,
  organizationId: string,
  numeros: readonly string[],
): Promise<string[]> {
  const fora = new Set<string>();
  for (const lote of lotesDeIds(numeros)) {
    const grafias = lote.flatMap((numero) => phoneLookupVariants(numero));
    const [principais, extras, apagados] = await Promise.all([
      db
        .from("contacts")
        .select("phone_number, is_blocked, is_anonymized, is_personal")
        .eq("organization_id", organizationId)
        .in("phone_number", grafias),
      db
        .from("contact_phones")
        .select("phone_number, contacts:contact_id(is_blocked, is_anonymized, is_personal)")
        .eq("organization_id", organizationId)
        .in("phone_number", grafias),
      // ponytail: uma pergunta por número (no máximo 500 na ferramenta); uma versão em lote da função quando a lista crescer.
      Promise.all(lote.map((numero) => foiApagadoAPedido(db, organizationId, numero))),
    ]);
    const erro = principais.error ?? extras.error;
    if (erro) throw new Error(`opt_out_ilegivel: ${erro.message}`);
    const linhas = (principais.data ?? []) as Array<FichaDoPublico & { phone_number: string }>;
    for (const linha of linhas) {
      if (fichaForaDoPublico(linha)) fora.add(linha.phone_number);
    }
    const linhasExtras = (extras.data ?? []) as unknown as Array<{
      phone_number: string;
      contacts: FichaDoPublico | null;
    }>;
    for (const { phone_number, contacts } of linhasExtras) {
      if (fichaForaDoPublico(contacts)) fora.add(phone_number);
    }
    lote.forEach((numero, posicao) => {
      if (apagados[posicao]) phoneLookupVariants(numero).forEach((grafia) => fora.add(grafia));
    });
  }
  return numeros.filter((numero) => !phoneLookupVariants(numero).some((grafia) => fora.has(grafia)));
}

export interface PublicacaoDeStatusInput {
  db: SupabaseClient;
  organizationId: string;
  /** `channel_sessions.id` do número que publica. */
  canalId: string;
  imagem: { mime: "image/jpeg" | "image/png"; base64: string };
  legenda?: string;
  /** Telefones como vieram; a normalização acontece aqui. */
  contatos?: readonly string[];
  /** `true` = todos os contatos do número. Exige consciência: não é o default. */
  todos?: boolean;
  /** Chave de deduplicação (24h). Sem ela, cada chamada publica. */
  idempotencyKey?: string;
  /**
   * O freio de quem chama, por DENTRO do efeito: depois das validações, e fora
   * do alcance do replay. Quem repete uma publicação pronta recebe o recibo sem
   * esperar vaga e sem contar outro envio, e o 429 de `segurar` libera a chave.
   * `registrar` vale também para o desfecho incerto, porque pode ter saído.
   */
  freio?: { segurar(): Promise<void>; registrar(): Promise<void> };
}

export interface PublicacaoDeStatusFeita {
  /** `false` só no recibo incerto, que nunca sai de `publicarStatusDoWhatsapp`. */
  publicado: boolean;
  /** Id que o canal deu à publicação; `null` quando ele não devolve id. */
  statusId: string | null;
  /** `"todos"` ou `"N contato(s)"` — quem a publicação alcançou, dito de volta. */
  publico: string;
  /** Quantos saíram da lista: opt-out, anonimização ou contato pessoal. */
  excluidos: number;
  /** `true` quando a resposta veio do recibo da primeira publicação. */
  deduplicado: boolean;
}

/**
 * Publica a imagem no Status do número escolhido.
 *
 * Lança quando não pode publicar — e cada recusa diz em português o que falta:
 * canal inexistente/arquivado, canal desativado, canal que não publica Status,
 * WhatsApp desconectado, público ausente, inválido ou vazio depois do opt-out,
 * acervo desligado com `todos`, transporte recusando ou sem responder, choque de
 * chave de idempotência.
 */
export async function publicarStatusDoWhatsapp(
  input: PublicacaoDeStatusInput,
): Promise<PublicacaoDeStatusFeita> {
  // ── O público, ANTES de qualquer leitura ───────────────────────────────────
  // Validar primeiro é o que impede a chamada de gastar uma ida ao banco (e uma
  // reserva de idempotência) para recusar por entrada inválida.
  if (input.todos && input.contatos && input.contatos.length > 0) {
    throw new Error("publico_ambiguo: use a lista de contatos OU `todos: true`, não os dois.");
  }
  const publico: PublicoDoStatus = input.todos ? { tipo: "todos" } : lerPublico(input.contatos);

  // ── A sessão ───────────────────────────────────────────────────────────────
  const { data, error } = await input.db
    .from("channel_sessions")
    .select(`id, status, archived_at, metadata, ${CHANNEL_SESSION_REF_COLUMNS}`)
    .eq("organization_id", input.organizationId)
    .eq("id", input.canalId)
    .maybeSingle();
  if (error) throw new Error(`canal_ilegivel: ${error.message}`);
  const sessao = data as
    | (ChannelSessionRef & { status: string | null; archived_at: string | null; metadata: unknown })
    | null;
  if (!sessao) throw new Error("canal_nao_encontrado");
  if (sessao.archived_at) throw new Error("canal_arquivado");
  if (canalDesativado(sessao.metadata)) {
    throw new Error(
      "canal_desativado: este canal está desativado. Reative-o na Central de Conexões para publicar.",
    );
  }

  // ── A pergunta é ao CANAL, não ao nome dele ────────────────────────────────
  const provider = sessao.provider as ChannelProvider;
  if (!capabilitiesOf(provider).statusUpdates) {
    // "sem erro": a capability respondeu, e a resposta é que esta operação não
    // existe neste canal. A frase abaixo é a explicação para quem tentou.
    throw new Error(
      "canal_sem_status: este canal não publica Status do WhatsApp. O Status é do app, e só um número conectado por QR Code publica.",
    );
  }
  const adapter = getAdapter(provider);
  const publicarStatus = adapter.publishStatus;
  if (!publicarStatus) {
    // Divergência entre a matriz e o adapter é defeito NOSSO, e falhar aqui é o
    // que faz aparecer no CI em vez de virar um botão que promete e não faz.
    throw new Error(`canal_sem_publicacao: ${provider} declara statusUpdates mas não implementa publishStatus`);
  }

  if (sessao.status !== "WORKING") {
    throw new Error(
      `canal_desconectado: o WhatsApp deste número não está conectado (estado: ${sessao.status ?? "desconhecido"}). Reconecte pelo QR Code.`,
    );
  }

  if (publico.tipo === "todos" && !lerGuardarHistorico(sessao.metadata)) {
    // O acervo NÃO é ligado aqui (#999). A ferramenta explica o que falta, e o
    // operador decide: ligar na tela, ou informar a lista (que não depende do
    // acervo).
    throw new Error(
      "acervo_desligado: publicar para todos os contatos depende de este número guardar histórico do WhatsApp, e essa opção está desligada nesta conexão. Ligue \"Guardar histórico\" na Central de Conexões, ou informe a lista de contatos.",
    );
  }

  const sessionRef = resolveSessionRef(sessao);
  const legenda = input.legenda?.trim() ? input.legenda.trim() : undefined;
  if (legenda && legenda.length > LEGENDA_MAXIMA) {
    throw new Error(`legenda_longa: a legenda passa de ${LEGENDA_MAXIMA} caracteres.`);
  }

  // ── O efeito ───────────────────────────────────────────────────────────────
  const publicar = async (): Promise<{ resposta: PublicacaoDeStatusFeita; status: number }> => {
    // Aqui, e não antes da chave: o replay devolve o recibo sem reler, e quem saiu
    // da lista depois da publicação não vira conflito de chave.
    const destino: PublicoDoStatus =
      publico.tipo === "todos"
        ? publico
        : {
            tipo: "contatos",
            numeros: await semQuemSaiu(input.db, input.organizationId, publico.numeros),
          };
    if (destino.tipo === "contatos" && destino.numeros.length === 0) {
      throw new Error(
        "publico_vazio: todos os contatos da lista pediram para não ser incomodados, foram anonimizados ou são contatos pessoais. Nada foi publicado.",
      );
    }
    await input.freio?.segurar();
    const { externalId, incerto } = await publicarStatus({
      organizationId: input.organizationId,
      sessionRef,
      imagem: input.imagem,
      legenda,
      publico: destino,
    });
    await input.freio?.registrar();
    return {
      resposta: {
        publicado: !incerto,
        statusId: externalId,
        publico: destino.tipo === "todos" ? "todos" : `${destino.numeros.length} contato(s)`,
        excluidos:
          publico.tipo === "contatos" && destino.tipo === "contatos"
            ? publico.numeros.length - destino.numeros.length
            : 0,
        deduplicado: false,
      },
      status: incerto ? STATUS_INCERTO : 200,
    };
  };

  const concluir = (
    efeito: { resposta: PublicacaoDeStatusFeita; status: number },
    deduplicado: boolean,
  ): PublicacaoDeStatusFeita => {
    if (efeito.status === STATUS_INCERTO) {
      throw new Error(
        "publicacao_incerta: o WhatsApp não respondeu, e a imagem pode ter saído. Confira o Status no celular do número antes de repetir. Se não saiu, publique com uma chave nova.",
      );
    }
    return { ...efeito.resposta, deduplicado };
  };

  if (!input.idempotencyKey) {
    return concluir(await publicar(), false);
  }

  // O hash cobre o que IDENTIFICA a publicação: o número, o público, a legenda e
  // os BYTES da imagem (por hash, não o base64 inteiro, que não caberia numa
  // linha de recibo). Chave repetida com imagem diferente é conflito — e é o
  // certo: a chave é a identidade da operação, não um "não poste nada hoje".
  const corpo = {
    canal: input.canalId,
    publico,
    legenda: legenda ?? null,
    imagem: createHash("sha256").update(input.imagem.base64).digest("hex"),
  };
  const desfecho = await comIdempotencia<PublicacaoDeStatusFeita>({
    db: input.db,
    organizationId: input.organizationId,
    endpoint: ENDPOINT_DA_PUBLICACAO_DE_STATUS,
    chave: input.idempotencyKey,
    corpo,
    executar: publicar,
  });

  switch (desfecho.tipo) {
    case "executou":
      return concluir(desfecho, false);
    case "replay":
      // A primeira publicação vale como resposta: NÃO publica de novo.
      return concluir(desfecho, true);
    case "conflito":
      throw new Error(
        "idempotency_conflict: esta chave já foi usada para outra publicação (número, público, legenda ou imagem diferentes). Use uma chave nova.",
      );
    case "em_curso":
      throw new Error(
        "idempotency_in_progress: uma publicação com esta chave está em curso. Tente de novo em instantes.",
      );
  }
}
