import type { SupabaseClient } from "@supabase/supabase-js";

import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaDoTexto } from "@/lib/i18n/idiomas";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";

/**
 * A PESQUISA DE SATISFAÇÃO DO ENCERRAMENTO (#4023).
 *
 * O cliente fecha o atendimento e recebe UMA pergunta de 1 a 5; a resposta dele
 * volta pela entrada normal do WhatsApp e vira a nota daquele atendimento. Quem
 * gerencia vê a média e a contagem; quem não gerencia não vê nota nenhuma —
 * nem a da própria conversa.
 *
 * ─── Por que a pergunta é feita DEPOIS do fechamento, e não antes ───────────
 *
 * Encerrar é o gesto que a pessoa pediu, e ele tem de acontecer mesmo que a
 * pergunta não saia (canal fora do ar, contato bloqueado, organização suspensa).
 * Por isso `pedirSatisfacaoAoEncerrar` é chamada depois do `fn_service_status`
 * e NUNCA lança: o pior desfecho é "não perguntei", nunca "não fechei".
 *
 * ─── Por que o pedido mora numa tabela, e não em `settings` ─────────────────
 *
 * Porque "já perguntei nesta conversa?" é uma pergunta com resposta única e
 * concorrente: o lote do inbox fecha dez conversas em paralelo e a tela pode
 * repetir o POST. O índice parcial `satisfacao_um_pedido_aberto_por_conversa`
 * é quem responde — o INSERT perde a corrida e a segunda pergunta NÃO sai. Sem
 * ele, uma guarda em memória responderia "não perguntei" nas duas chamadas.
 *
 * ─── Número solto não engole o atendimento ─────────────────────────────────
 *
 * Um "2" só vira nota enquanto a conversa está DE FATO esperando a nota: há
 * pedido `aguardando`, a janela não venceu e, desde a pergunta, NADA mais foi
 * enviado ao cliente. Se a equipe ou a IA voltou a falar (um menu, uma
 * pergunta), o atendimento seguiu, e o "2" é resposta a ELA: o pedido fecha
 * como `sem_nota` e a mensagem segue o caminho normal.
 *
 * ─── A pergunta passa pelos portões de qualquer envio ao cliente ──────────
 *
 * Contato bloqueado (STOP) ou pessoal não recebe a pergunta, e fora da janela
 * de envio do número (`channel_knobs`, a mesma régua da automação) ela não
 * sai — não é adiada: pesquisa feita horas depois não mede o atendimento.
 * Qualquer recusa do envio fecha o pedido como `sem_nota`, para que nenhum
 * pedido sem pergunta fique aberto capturando número.
 *
 * ─── Por que `sem_nota` existe ─────────────────────────────────────────────
 *
 * Porque silêncio não é zero. Contar pedido sem resposta como nota 0 afunda a
 * média de quem tem cliente ocupado, e o número passa a medir quem responde
 * pesquisa. `sem_nota` entra na contagem de pedidos e NUNCA na de notas.
 */

/** Janela padrão para o cliente responder. Uma volta por dia é o teto barato. */
export const JANELA_DA_NOTA_HORAS = 24;

/** Teto da janela por organização: acima disso o pedido deixaria de ser pesquisa. */
export const JANELA_MAXIMA_HORAS = 168;

/**
 * O texto que o cliente lê. Curto de propósito: a resposta procurada é um
 * dígito, e pergunta longa convida a resposta em texto livre que o leitor de
 * nota não reconhece.
 */
export const TEXTO_DA_PERGUNTA_PADRAO =
  "De 1 a 5, como você avalia este atendimento? Responda só com o número.";

export interface OpcaoDaSatisfacao {
  ligado: boolean;
  janela_horas: number;
  pergunta: string;
}

/**
 * Lê a opção da organização em `organizations.settings.satisfacao`.
 *
 * DESLIGADA DE FÁBRICA: ausente, `null`, `{}` ou qualquer coisa que não seja
 * `ligado: true` devolve `ligado: false`. Quem nunca ligou não vê uma pergunta
 * sair — e é isso que a issue pede ("desligada de fábrica").
 */
export function lerOpcaoDaSatisfacao(settings: unknown): OpcaoDaSatisfacao {
  const raiz = (settings ?? {}) as Record<string, unknown>;
  const bloco = (raiz.satisfacao ?? null) as Record<string, unknown> | null;
  const janela = Number(bloco?.janela_horas);
  const pergunta = typeof bloco?.pergunta === "string" ? bloco.pergunta.trim() : "";
  return {
    ligado: bloco?.ligado === true,
    janela_horas:
      Number.isFinite(janela) && janela >= 1 && janela <= JANELA_MAXIMA_HORAS
        ? Math.round(janela)
        : JANELA_DA_NOTA_HORAS,
    pergunta: pergunta || TEXTO_DA_PERGUNTA_PADRAO,
  };
}

/**
 * A NOTA que a resposta carrega, ou `null` quando a mensagem não é uma nota.
 *
 * Estrito de propósito: `4` (com pontuação e emoji em volta) é nota; `50`, `4
 * reais`, `quero 4 caixas` e `2024` NÃO são. Um leitor frouxo transformaria
 * pedido de orçamento em avaliação de atendimento, e a média passaria a medir
 * outra coisa.
 */
export function lerNotaDaResposta(texto: string | null | undefined): number | null {
  if (typeof texto !== "string") return null;
  const limpo = texto
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2705}\u{274C}]/gu, " ")
    .replace(/^(?:nota|minha nota(?: e| é)?)\s*[:\-]?\s*/iu, "")
    .trim();
  const casou = /^([1-5])(?:[.,!;:)\]]|\s*(?:de\s*)?5)?$/.exec(limpo.replace(/["'”’]/g, "").trim());
  if (!casou) return null;
  return Number(casou[1]);
}

/** Uma resposta que chega DEPOIS da janela não vira nota — o pedido já venceu. */
function venceu(expiraEm: string | null | undefined, quando: Date): boolean {
  if (!expiraEm) return false;
  const limite = new Date(expiraEm).getTime();
  return Number.isFinite(limite) && quando.getTime() > limite;
}

export type DesfechoDoPedido =
  | { pedida: true; pedidoId: string }
  | {
      pedida: false;
      motivo:
        | "desligada"
        | "ja_pedida"
        | "falha_ao_enviar"
        | "sem_contato"
        | "contato_bloqueado"
        | "contato_pessoal"
        | "fora_da_janela"
        | "org_parada"
        | "erro";
    };

interface LinhaDaOrganizacao {
  settings?: unknown;
  locale?: string | null;
}

/**
 * Pergunta UMA vez, ao encerrar. Nunca lança: fechar aconteceu antes e não pode
 * ser desfeito por causa da pesquisa.
 *
 * `settings` pode vir de quem já leu a organização; quando não vem, é lida
 * aqui, junto com o idioma em que a pergunta padrão sai.
 */
export async function pedirSatisfacaoAoEncerrar(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    conversationId: string;
    contactId: string | null;
    /** O número da conversa: é dele a janela de envio. */
    channelSessionId?: string | null;
    settings?: unknown;
    agora?: Date;
  },
): Promise<DesfechoDoPedido> {
  let pedidoId: string | undefined;
  try {
    let settings = entrada.settings;
    let locale: string | null = null;
    if (settings === undefined) {
      const { data } = await admin
        .from("organizations")
        .select("settings, locale")
        .eq("id", entrada.organizationId)
        .maybeSingle();
      settings = (data as LinhaDaOrganizacao | null)?.settings;
      locale = (data as LinhaDaOrganizacao | null)?.locale ?? null;
    }
    const opcao = lerOpcaoDaSatisfacao(settings);
    if (!opcao.ligado) return { pedida: false, motivo: "desligada" };
    if (!entrada.contactId) return { pedida: false, motivo: "sem_contato" };

    // Os portões de qualquer envio ao cliente, ANTES de o pedido nascer: um
    // pedido sem pergunta ficaria aberto à espera de um número.
    const { data: contato } = await admin
      .from("contacts")
      .select("is_blocked, is_personal")
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.contactId)
      .maybeSingle();
    const linhaDoContato = contato as { is_blocked?: boolean; is_personal?: boolean } | null;
    if (!linhaDoContato) return { pedida: false, motivo: "sem_contato" };
    if (linhaDoContato.is_blocked === true) return { pedida: false, motivo: "contato_bloqueado" };
    if (linhaDoContato.is_personal === true) return { pedida: false, motivo: "contato_pessoal" };

    const agora = entrada.agora ?? new Date();
    if (
      entrada.channelSessionId &&
      (await adiarAteAJanelaAbrir(admin, entrada.organizationId, entrada.channelSessionId, agora)) !== null
    ) {
      return { pedida: false, motivo: "fora_da_janela" };
    }
    const expira = new Date(agora.getTime() + opcao.janela_horas * 60 * 60 * 1000);

    // O PEDIDO NASCE ANTES DO ENVIO. Se o envio falhar, existe um pedido que
    // pode ser fechado; se o envio viesse primeiro, dois fechamentos
    // simultâneos mandariam duas perguntas e só depois descobririam o conflito.
    const { data: criado, error: erroDoPedido } = await admin
      .from("satisfacao_do_atendimento")
      .insert({
        organization_id: entrada.organizationId,
        conversation_id: entrada.conversationId,
        contact_id: entrada.contactId,
        status: "aguardando",
        perguntado_em: agora.toISOString(),
        expira_em: expira.toISOString(),
      })
      .select("id")
      .maybeSingle();

    if (erroDoPedido) {
      // 23505 = o índice parcial: já há pedido aberto nesta conversa.
      if (erroDoPedido.code === "23505") return { pedida: false, motivo: "ja_pedida" };
      return { pedida: false, motivo: "erro" };
    }
    pedidoId = (criado as { id?: string } | null)?.id;
    if (!pedidoId) return { pedida: false, motivo: "erro" };
    // A pergunta padrão sai no idioma da organização; a escrita pela empresa
    // sai como foi escrita.
    const pergunta =
      opcao.pergunta === TEXTO_DA_PERGUNTA_PADRAO
        ? traduzir(TEXTO_DA_PERGUNTA_PADRAO, idiomaDoTexto(locale))
        : opcao.pergunta;

    const { sendMessageHandler } = await import("@/app/api/v1/messages/_handler");
    const mensagem = await sendMessageHandler(
      admin,
      {
        organization_id: entrada.organizationId,
        actor: { type: "ai_agent", id: "pesquisa-de-satisfacao", role: "agent" },
        requestId: `satisfacao-${entrada.conversationId}`,
      },
      {
        conversation_id: entrada.conversationId,
        type: "text",
        body: pergunta,
        metadata: { pesquisa_de_satisfacao: true, pedido_id: pedidoId },
      },
    );

    // `queued` é canal fora do ar: a mensagem pode nunca sair. Fechar o pedido
    // como `sem_nota` é a verdade disponível — não há pergunta para responder.
    if (mensagem.status !== "sent" && mensagem.status !== "queued") {
      await fecharSemNota(admin, entrada.organizationId, pedidoId);
      return { pedida: false, motivo: "falha_ao_enviar" };
    }
    return { pedida: true, pedidoId };
  } catch (erro) {
    // Encerramento não é desfeito por pesquisa. Quem investiga acha pelo log do
    // chamador; aqui a resposta é "não perguntei".
    //
    // `OrgNaoOperanteError` (org suspensa, redigida ou arquivada) cai aqui de
    // propósito: a pergunta não sai e nada é retentado — o encerramento já
    // aconteceu. Recusa do envio (contato bloqueado no meio do caminho, janela
    // de 24h do canal oficial) também cai aqui. Em todos, o pedido que nasceu
    // fecha como `sem_nota`: aberto, ele capturaria o próximo número do cliente
    // como nota de uma pergunta que nunca saiu.
    if (pedidoId) {
      try {
        await fecharSemNota(admin, entrada.organizationId, pedidoId);
      } catch {
        // O banco caiu entre o envio e o fechamento: o desfecho continua "não
        // perguntei", e a varredura de vencidos fecha o pedido no fim da janela.
      }
    }
    if (erro instanceof OrgNaoOperanteError) return { pedida: false, motivo: "org_parada" };
    return { pedida: false, motivo: "erro" };
  }
}

async function fecharSemNota(admin: SupabaseClient, organizationId: string, pedidoId: string): Promise<void> {
  await admin
    .from("satisfacao_do_atendimento")
    .update({ status: "sem_nota" })
    .eq("id", pedidoId)
    .eq("organization_id", organizationId)
    .eq("status", "aguardando");
}

/**
 * A resposta do cliente pela entrada NORMAL do WhatsApp (o mesmo webhook, a
 * mesma mensagem que já está em `messages`) vira a nota do pedido aberto.
 *
 * Devolve `capturada: true` só quando a nota foi gravada. Qualquer outro
 * desfecho deixa a mensagem seguir o caminho de sempre — um "5" que virou nota
 * não pede resposta da IA; um "vcs demoraram" segue normal.
 */
export async function capturarRespostaDeSatisfacao(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    conversationId: string;
    texto: string | null | undefined;
    messageId?: string | null;
    enviadaEm?: Date;
  },
): Promise<{
  capturada: boolean;
  nota?: number;
  pedidoId?: string;
  motivo?: "sem_pedido" | "nao_e_nota" | "vencida" | "conversa_seguiu";
}> {
  const nota = lerNotaDaResposta(entrada.texto);
  if (nota === null) return { capturada: false, motivo: "nao_e_nota" };

  try {
    const { data: pedido } = await admin
      .from("satisfacao_do_atendimento")
      .select("id, expira_em, perguntado_em")
      .eq("organization_id", entrada.organizationId)
      .eq("conversation_id", entrada.conversationId)
      .eq("status", "aguardando")
      .maybeSingle();
    const linha = pedido as { id?: string; expira_em?: string; perguntado_em?: string } | null;
    if (!linha?.id) return { capturada: false, motivo: "sem_pedido" };

    const quando = entrada.enviadaEm ?? new Date();
    if (venceu(linha.expira_em, quando)) {
      await admin
        .from("satisfacao_do_atendimento")
        .update({ status: "sem_nota" })
        .eq("id", linha.id)
        .eq("status", "aguardando");
      return { capturada: false, motivo: "vencida" };
    }

    // A conversa ainda espera a nota? Se, desde a pergunta, saiu QUALQUER outra
    // mensagem ao cliente (a equipe reabriu, a IA mandou um menu), o número é
    // resposta a ela — fecha o pedido e deixa a mensagem seguir.
    // (`perguntado_em` é `not null` no banco; sem ele, toda mensagem enviada
    // conta, e o número segue como conversa.)
    const { data: enviadasDepois, error: erroDasEnviadas } = await admin
      .from("messages")
      .select("id, metadata")
      .eq("organization_id", entrada.organizationId)
      .eq("conversation_id", entrada.conversationId)
      .eq("direction", "outbound")
      .gt("sent_at", linha.perguntado_em ?? "1970-01-01T00:00:00.000Z")
      .limit(5);
    // Sem saber se a conversa seguiu, o número NÃO vira nota: engolir uma
    // resposta de menu é pior do que perder uma nota.
    if (erroDasEnviadas) return { capturada: false, motivo: "sem_pedido" };
    const outras = ((enviadasDepois ?? []) as Array<{ metadata?: Record<string, unknown> | null }>).filter(
      (m) => m.metadata?.pesquisa_de_satisfacao !== true,
    );
    if (outras.length > 0) {
      await fecharSemNota(admin, entrada.organizationId, linha.id);
      return { capturada: false, motivo: "conversa_seguiu" };
    }

    // O `eq("status","aguardando")` é o CAS: duas mensagens "5" quase
    // simultâneas não gravam duas notas, e a segunda não sobrescreve a primeira.
    const { data: gravado } = await admin
      .from("satisfacao_do_atendimento")
      .update({
        status: "respondida",
        nota,
        respondido_em: quando.toISOString(),
        mensagem_da_resposta_id: entrada.messageId ?? null,
      })
      .eq("id", linha.id)
      .eq("status", "aguardando")
      .select("id")
      .maybeSingle();
    if (!gravado) return { capturada: false, motivo: "sem_pedido" };
    return { capturada: true, nota, pedidoId: linha.id };
  } catch {
    return { capturada: false, motivo: "nao_e_nota" };
  }
}

/** Fecha os pedidos vencidos da organização. Devolve quantos viraram `sem_nota`. */
export async function fecharPedidosVencidos(
  admin: SupabaseClient,
  organizationId: string,
): Promise<number> {
  const { data, error } = await admin.rpc("fn_satisfacao_fechar_vencidas", {
    p_org: organizationId,
  });
  if (error) return 0;
  const total = Number(data);
  return Number.isFinite(total) ? total : 0;
}

export interface ResumoDaSatisfacao {
  media: number | null;
  respostas: number;
  pedidos: number;
  sem_nota: number;
  aguardando: number;
  notas: Record<string, number>;
}

/**
 * Média e contagem do período — SÓ para quem gerencia. O piso é conferido na
 * rota (`requireRole("manager")`) e de novo na policy de leitura da tabela: a
 * API não é a única porta do PostgREST.
 */
export async function resumoDaSatisfacao(
  admin: SupabaseClient,
  entrada: { organizationId: string; de?: string | null; ate?: string | null },
): Promise<ResumoDaSatisfacao> {
  const { data, error } = await admin.rpc("fn_satisfacao_resumo", {
    p_org: entrada.organizationId,
    p_de: entrada.de ?? null,
    p_ate: entrada.ate ?? null,
  });
  if (error) throw new Error(error.message);
  const bruto = (data ?? {}) as Record<string, unknown>;
  const numero = (chave: string): number => {
    const valor = Number(bruto[chave]);
    return Number.isFinite(valor) ? valor : 0;
  };
  const media = bruto.media === null || bruto.media === undefined ? null : Number(bruto.media);
  return {
    // Sem nota, a média é `null` — nunca 0. "Não medido" e "nota zero" são
    // coisas diferentes, e a tela mostra "—" para a primeira.
    media: media !== null && Number.isFinite(media) ? media : null,
    respostas: numero("respostas"),
    pedidos: numero("pedidos"),
    sem_nota: numero("sem_nota"),
    aguardando: numero("aguardando"),
    notas: (bruto.notas ?? {}) as Record<string, number>,
  };
}
