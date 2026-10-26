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
 *  2. **Ligava o acervo do NOWEB em toda sessão** para a lista de público
 *     funcionar. A #999 decidiu o contrário: o acervo fica desligado por padrão
 *     e liga por conexão, na tela. Feature nenhuma liga sozinha.
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
 *  - a lista é validada sobre os DÍGITOS, não sobre a string crua: `+55 (15)
 *    99999-9999` é um telefone, e recusá-lo por causa da máscara seria recusar
 *    o formato em que as pessoas escrevem número;
 *  - a chave de idempotência é RESERVADA antes do efeito (`comIdempotencia`),
 *    com o hash gravado no formato da coluna (`hashDaColuna`).
 *
 * ─── O acervo do histórico ──────────────────────────────────────────────────
 *
 * Numa sessão NOWEB o provedor só honra a LISTA de público com o acervo
 * (`noweb.store`) ligado; sem ele responde 400. Este módulo lê a opção por
 * conexão (`lerGuardarHistorico`, chave `guardar_historico` do `metadata`) e,
 * quando falta, EXPLICA o que falta em vez de ligar por conta própria — a
 * decisão da #999 é que quem liga é o operador, na tela. Publicar para todos
 * não depende do acervo, e por isso segue valendo sem ele.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { comIdempotencia } from "@/lib/api/idempotency";

import { lerGuardarHistorico } from "./acervo-do-historico";
import { capabilitiesOf } from "./capabilities";
import { canalDesativado } from "./desativado";
import { getAdapter } from "./index";
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
 * Recusa com mensagem que diz QUAL entrada está errada: quem chama é uma
 * ferramenta usada por outro sistema, e "lista inválida" não dá o que consertar.
 */
export function lerPublico(contatos: readonly string[] | undefined): PublicoDoStatus {
  if (!contatos || contatos.length === 0) {
    throw new Error(
      "publico_ausente: informe a lista de contatos ou `todos: true`. O Status nunca sai para todos por omissão.",
    );
  }
  const numeros: string[] = [];
  for (const bruto of contatos) {
    const lido = Telefone.safeParse(digitosDoTelefone(bruto));
    if (!lido.success) {
      throw new Error(
        `contato_invalido: "${bruto}" não é um telefone em dígitos (8 a 15, com DDI).`,
      );
    }
    if (!numeros.includes(lido.data)) numeros.push(lido.data);
  }
  return { tipo: "contatos", numeros };
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
}

export interface PublicacaoDeStatusFeita {
  publicado: true;
  /** Id que o canal deu à publicação; `null` quando ele não devolve id. */
  statusId: string | null;
  /** `"todos"` ou `"N contato(s)"` — o que o chamador pediu, dito de volta. */
  publico: string;
  /** `true` quando a resposta veio do recibo da primeira publicação. */
  deduplicado: boolean;
}

/**
 * Publica a imagem no Status do número escolhido.
 *
 * Lança quando não pode publicar — e cada recusa diz em português o que falta:
 * canal inexistente/arquivado, canal desativado, canal que não publica Status,
 * WhatsApp desconectado, público ausente ou inválido, acervo desligado com
 * lista de público, transporte recusando, choque de chave de idempotência.
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

  if (publico.tipo === "contatos" && !lerGuardarHistorico(sessao.metadata)) {
    // O acervo NÃO é ligado aqui (#999). A ferramenta explica o que falta, e o
    // operador decide: ligar na tela, ou publicar para todos (que não depende
    // do acervo).
    throw new Error(
      "acervo_desligado: a lista de público do Status depende de este número guardar histórico do WhatsApp, e essa opção está desligada nesta conexão. Ligue \"Guardar histórico\" na Central de Conexões, ou publique para todos os contatos.",
    );
  }

  const sessionRef = resolveSessionRef(sessao);
  const legenda = input.legenda?.trim() ? input.legenda.trim() : undefined;
  if (legenda && legenda.length > LEGENDA_MAXIMA) {
    throw new Error(`legenda_longa: a legenda passa de ${LEGENDA_MAXIMA} caracteres.`);
  }

  // ── O efeito ───────────────────────────────────────────────────────────────
  const publicar = async (): Promise<{ resposta: PublicacaoDeStatusFeita; status: number }> => {
    const { externalId } = await publicarStatus({
      organizationId: input.organizationId,
      sessionRef,
      imagem: input.imagem,
      legenda,
      publico,
    });
    return {
      resposta: {
        publicado: true,
        statusId: externalId,
        publico: publico.tipo === "todos" ? "todos" : `${publico.numeros.length} contato(s)`,
        deduplicado: false,
      },
      status: 200,
    };
  };

  if (!input.idempotencyKey) {
    return (await publicar()).resposta;
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
      return desfecho.resposta;
    case "replay":
      // A primeira publicação vale como resposta: NÃO publica de novo.
      return { ...desfecho.resposta, deduplicado: true };
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
