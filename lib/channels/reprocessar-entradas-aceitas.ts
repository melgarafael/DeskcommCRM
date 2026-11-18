/**
 * Reprocessa a ENTRADA ACEITA que ficou no meio — a segunda metade do cron
 * `app/api/v1/cron/webhook-replay` (a primeira é a do canal por QR, em
 * `./reprocessar-arquivo-de-webhook.ts`).
 *
 * A entrada do canal intermediado responde 200 ao provedor antes de processar
 * (`./entrada-aceita.ts`). Se o contêiner reiniciar no meio da ingestão, ou a
 * ingestão falhar, o provedor já recebeu 200 e não reentrega: quem garante a
 * mensagem é a linha do arquivo, que ficou `received` com a marca de aceita.
 *
 *   - relê as linhas aceitas e não terminadas recebidas há mais de
 *     `ESPERA_DA_ENTRADA_MS` — o `after()` da própria requisição leva segundos,
 *     e cinco minutos de folga deixam o reprocessamento longe dele;
 *   - e há menos de `JANELA_DA_ENTRADA_MS`: reprocessar depois disso faria a IA
 *     responder uma mensagem velha. A linha aceita que passa da janela (agendador
 *     parado, VPS fora do ar, fila represada) não é ingerida: vira `dead` com o
 *     mesmo aviso. Com a mensagem já no CRM ela fecha, e a régua é a de
 *     `retomarEfeitosDaEntrada`: sem o pedido de despacho, rodam os efeitos sem a
 *     IA, e o aviso diz que a mensagem ficou sem atendimento;
 *   - TOMA a linha antes de processar, somando a tentativa com a contagem que
 *     leu (`attempts = n` → `n + 1`): duas rodadas que se sobreponham não
 *     processam a mesma linha com a mesma leitura;
 *   - passa pela MESMA ingestão da resposta (`processarEntradaAceita`), e a
 *     repetição não duplica: só mensagem nova responde antes de processar, e
 *     `unique (organization_id, external_id)` faz a segunda vez virar `23505`.
 *     Esse `23505` não diz que os efeitos rodaram: por isso a chamada vai como
 *     `retomada`, e a ingestão confere (`retomarEfeitosDaEntrada`);
 *   - em `MAX_TENTATIVAS` a linha vira `dead` e a organização recebe UM aviso na
 *     Central (família `MENSAGEM_DO_NUMERO_OFICIAL_QUE_NAO_ENTROU`);
 *   - linha com corpo legível não morre levando um pedido de sair: o opt-out é
 *     gravado antes da desistência, e sem ele a linha fica para a rodada seguinte;
 *   - para na terceira falha seguida da rodada (o banco ainda não voltou) e
 *     depois de `PRAZO_DA_RODADA_MS`, para a rodada caber nos 45 s que o
 *     agendador dá a ela.
 *
 * Mora em `lib/channels/` porque nomeia o canal (pela lista de
 * `CANAIS_QUE_RESPONDEM_ANTES`); a rota do cron só autentica e audita.
 */
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import {
  avisoDaMensagemDoNumeroOficial,
  type EfeitoDoEvento,
  MENSAGEM_DO_NUMERO_OFICIAL_QUE_NAO_ENTROU,
  MENSAGEM_DO_NUMERO_OFICIAL_SEM_ATENDIMENTO,
} from "@/lib/event-log/aviso-de-evento-morto";
import { logger } from "@/lib/logger";
import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import type { createAdminClient } from "@/lib/supabase/admin";

import { fecharArquivoDoWebhook, marcarArquivoDoWebhookComoMorto } from "./arquivo-de-webhook";
import { processarEntradaAceita, registrarFalhaDaEntrada } from "./entrada-aceita";
import { CANAIS_QUE_RESPONDEM_ANTES, mensagemDaEntradaAceita, type InboundWebhookInput } from "./inbound";
import { aplicarEfeitosDaRecuperacao, aplicarOptOutPendente, type EntradaDaRecuperacao } from "./pos-entrada";
import { MAX_TENTATIVAS, type ResultadoDoReplay } from "./reprocessar-arquivo-de-webhook";
import { contatoConhecidoDaEntrada, despachoJaPedido } from "./zernio/ingest";
import type { ZernioInboundMessage } from "./zernio/webhook";

/** Folga para o `after()` da própria requisição terminar antes. */
export const ESPERA_DA_ENTRADA_MS = 5 * 60 * 1000;
/** Mais velha que isto não se ingere: vira `dead` com aviso (ver o cabeçalho). */
export const JANELA_DA_ENTRADA_MS = 6 * 60 * 60 * 1000;
/** A rodada não começa linha nova depois disto (o agendador corta em 45 s). */
export const PRAZO_DA_RODADA_MS = 20_000;
const LOTE = 10;
const FALHAS_SEGUIDAS_PARA_PARAR = 3;
const COLUNAS_DA_LINHA = "id, organization_id, channel_session_id, raw_body, payload_parsed, attempts, error_message";
const ORIGEM_DOS_EFEITOS = "entrada_vencida";

type Admin = ReturnType<typeof createAdminClient>;

interface LinhaAceita {
  id: string;
  organization_id: string;
  channel_session_id: string | null;
  raw_body: string | null;
  payload_parsed: unknown;
  attempts: number;
  error_message: string | null;
}

function eventoDa(linha: LinhaAceita): string {
  const p = linha.payload_parsed;
  const e = p && typeof p === "object" ? (p as Record<string, unknown>).event : null;
  return typeof e === "string" && e.length > 0 ? e : "webhook";
}

/**
 * O pedido de sair não morre com a linha: o texto está no corpo, e a ficha, se
 * existir, é da mesma pessoa. Sem ficha não há quem bloquear. Lança se não gravou.
 */
async function respeitarPedidoDeSair(admin: Admin, linha: LinhaAceita): Promise<void> {
  const msg = linha.raw_body ? mensagemDaEntradaAceita(linha.raw_body) : null;
  if (msg?.direction !== "inbound" || !ehPedidoDeOptOut(msg.text)) return;
  const contato = await contatoConhecidoDaEntrada(admin, linha.organization_id, linha.channel_session_id, msg);
  if (!contato) return;
  await aplicarOptOutPendente(admin, {
    organizationId: linha.organization_id,
    contactId: contato.contactId,
    conversationId: contato.conversationId,
    texto: msg.text,
    requestId: `entrada-perdida:${linha.id}`,
    origem: ORIGEM_DOS_EFEITOS,
  });
}

async function desistir(
  admin: Admin,
  linha: LinhaAceita,
  r: ResultadoDoReplay,
  desfecho: { motivo: string; tentativas: number; aviso?: string },
): Promise<void> {
  try {
    await respeitarPedidoDeSair(admin, linha);
  } catch (err) {
    // Morta, a linha nunca mais seria lida, e o pedido se perderia de vez.
    logger.error("[webhook-replay] pedido de sair não gravado: a linha fica para a rodada seguinte", {
      log_id: linha.id,
      detail: err instanceof Error ? err.message : String(err),
    });
    r.ainda_falhando += 1;
    return;
  }
  const resultado = await marcarArquivoDoWebhookComoMorto(
    admin,
    linha,
    { status: "received", attempts: desfecho.tentativas },
    desfecho,
  );
  if (resultado === "falhou") r.ainda_falhando += 1;
  if (resultado !== "gravado") return;
  r.desistidas += 1;
  if (desfecho.aviso !== undefined) {
    await avisarMensagemPerdida(admin, linha, desfecho.tentativas, desfecho.aviso);
  }
}

/** Um aviso aberto por organização enquanto durar — Central inundada ninguém lê. */
async function avisarMensagemPerdida(
  admin: Admin,
  linha: LinhaAceita,
  tentativas: number,
  motivo: string,
  efeito: EfeitoDoEvento = MENSAGEM_DO_NUMERO_OFICIAL_QUE_NAO_ENTROU,
): Promise<void> {
  try {
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", linha.organization_id)
      .eq("kind", "event_dead")
      .eq("status", "open")
      .eq("title", efeito.titulo)
      .limit(1)
      .maybeSingle();
    if (jaAberto) return;
    const { title, body } = avisoDaMensagemDoNumeroOficial({ eventType: eventoDa(linha), tentativas, motivo }, efeito);
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: linha.organization_id,
      kind: "event_dead",
      severity: "critical",
      title,
      body,
    });
    // `23505` é outra rodada chegando primeiro ao índice único parcial da 0491:
    // o aviso já está aberto, que é o desfecho que se queria.
    if (error && error.code !== "23505") {
      logger.error("[webhook-replay] aviso na Central falhou", {
        organization_id: linha.organization_id,
        detail: error.message,
      });
    }
  } catch (err) {
    logger.error("[webhook-replay] aviso na Central falhou", {
      organization_id: linha.organization_id,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** A sessão da linha, ou `null` quando foi apagada ou arquivada. Lança se a leitura falhar. */
async function sessaoDaLinha(admin: Admin, linha: LinhaAceita): Promise<InboundWebhookInput["session"] | null> {
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id, provider, display_name, phone_number")
      .eq("id", linha.channel_session_id ?? "")
      .eq("organization_id", linha.organization_id);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) throw new Error(`sessão não lida: ${error.message}`);
  return (data as InboundWebhookInput["session"] | null) ?? null;
}

interface MensagemGravada {
  id: string;
  conversation_id: string;
  contact_id: string;
  direction: string;
  sent_at: string;
}

/**
 * A mensagem desta linha, se já está no CRM. Lança se a leitura falhar. Sem corpo
 * não há como saber, e a resposta é `null`: o aviso a mais é o lado certo do erro.
 */
async function mensagemGravada(
  admin: Admin,
  linha: LinhaAceita,
  msg: ZernioInboundMessage | null,
): Promise<MensagemGravada | null> {
  if (!msg) return null;
  const { data, error } = await admin
    .from("messages")
    .select("id, conversation_id, contact_id, direction, sent_at")
    .eq("organization_id", linha.organization_id)
    .eq("external_id", msg.externalId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`mensagem não lida: ${error.message}`);
  return data as MensagemGravada | null;
}

/**
 * A mensagem existe, mas existir não prova que os efeitos rodaram. Sem o pedido de
 * despacho, roda só o que não acorda o agente: seis horas depois, uma resposta
 * chegaria a quem já foi atendido. `true` = não havia o marco. Lança se o opt-out
 * não gravou: a linha fica para a rodada seguinte.
 *
 * A repetição é segura: a linha só volta se o fechamento falhar. O opt-out não
 * audita quem já está bloqueado, o carimbo não soma com a conversa nessa hora, e o
 * aviso é um por organização. Contato pessoal, número interno e canal desativado
 * nunca despacham, e neles o aviso a mais é o lado certo do erro.
 */
async function rodarEfeitosSemIa(
  admin: Admin,
  linha: LinhaAceita,
  msg: ZernioInboundMessage,
  gravada: MensagemGravada,
): Promise<boolean> {
  if (gravada.direction !== "inbound") return false;
  if (await despachoJaPedido(admin, linha.organization_id, gravada.id)) return false;

  const entrada: EntradaDaRecuperacao = {
    organizationId: linha.organization_id,
    contactId: gravada.contact_id,
    conversationId: gravada.conversation_id,
    messageId: gravada.id,
    channelSessionId: linha.channel_session_id ?? "",
    texto: msg.text,
    nomeDoContato: msg.identity.displayName,
    requestId: `entrada-vencida:${linha.id}`,
    origem: ORIGEM_DOS_EFEITOS,
    enviadaEm: gravada.sent_at,
    previa: (msg.text ?? "").slice(0, 200),
  };
  await aplicarOptOutPendente(admin, entrada);
  await aplicarEfeitosDaRecuperacao(admin, { ...entrada, optOutJaTratado: true });
  await avisarMensagemPerdida(
    admin,
    linha,
    linha.attempts,
    "passou da janela de reprocessamento com a mensagem gravada e sem o pedido de despacho",
    MENSAGEM_DO_NUMERO_OFICIAL_SEM_ATENDIMENTO,
  );
  return true;
}

/**
 * As linhas aceitas que passaram da janela sem terminar. Falha só pula a rodada:
 * a linha continua aqui, e quem ainda não terminou é a rodada seguinte.
 */
async function encerrarVencidas(admin: Admin, desde: string, r: ResultadoDoReplay): Promise<void> {
  const { data, error } = await admin
    .from("webhook_events_log")
    .select(COLUNAS_DA_LINHA)
    .in("provider", [...CANAIS_QUE_RESPONDEM_ANTES])
    .eq("status", "received")
    .eq("valid_signature", true)
    .lt("received_at", desde)
    .order("received_at", { ascending: true })
    .limit(LOTE);
  if (error) {
    logger.warn("[webhook-replay] entradas vencidas não lidas", { detail: error.message });
    return;
  }

  for (const linha of (data ?? []) as LinhaAceita[]) {
    r.lidas += 1;
    const msg = linha.raw_body ? mensagemDaEntradaAceita(linha.raw_body) : null;
    let gravada: MensagemGravada | null;
    let rodouSemIa: boolean;
    try {
      gravada = await mensagemGravada(admin, linha, msg);
      rodouSemIa = gravada !== null && msg !== null && (await rodarEfeitosSemIa(admin, linha, msg, gravada));
    } catch (err) {
      logger.warn("[webhook-replay] entrada vencida não conferida", {
        log_id: linha.id,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (gravada) {
      await fecharArquivoDoWebhook(admin, linha.id, {
        status: "processed",
        validSignature: true,
        erro: rodouSemIa ? "vencida_efeitos_sem_ia" : "vencida_com_a_mensagem_no_crm",
      });
      r.processadas += 1;
      continue;
    }
    const motivo = "passou da janela de reprocessamento sem terminar";
    await desistir(admin, linha, r, {
      motivo: `replay: ${motivo}`,
      tentativas: linha.attempts,
      aviso: motivo,
    });
  }
}

export async function reprocessarEntradasAceitas(
  admin: Admin,
  now: Date,
  opcoes: { relogio?: () => number } = {},
): Promise<ResultadoDoReplay> {
  const relogio = opcoes.relogio ?? Date.now;
  const inicio = relogio();
  const ate = new Date(now.getTime() - ESPERA_DA_ENTRADA_MS).toISOString();
  const desde = new Date(now.getTime() - JANELA_DA_ENTRADA_MS).toISOString();

  const { data, error } = await admin
    .from("webhook_events_log")
    .select(COLUNAS_DA_LINHA)
    .in("provider", [...CANAIS_QUE_RESPONDEM_ANTES])
    .eq("status", "received")
    .eq("valid_signature", true)
    .gte("received_at", desde)
    .lt("received_at", ate)
    .order("received_at", { ascending: true })
    .limit(LOTE);
  if (error) throw new Error(`query_failed: ${error.message}`);

  const linhas = (data ?? []) as LinhaAceita[];
  const r: ResultadoDoReplay = { lidas: linhas.length, processadas: 0, ainda_falhando: 0, desistidas: 0 };
  let falhasSeguidas = 0;

  for (const linha of linhas) {
    if (falhasSeguidas >= FALHAS_SEGUIDAS_PARA_PARAR) break;
    if (relogio() - inicio >= PRAZO_DA_RODADA_MS) break;

    // ─── Tomar a linha ─────────────────────────────────────────────────────
    // O UPDATE condicional é a trava: só uma rodada passa de `n` para `n + 1`.
    // Zero linhas = outra rodada a tomou, ou ela já terminou.
    const tentativas = linha.attempts + 1;
    const { data: tomada, error: erroAoTomar } = await admin
      .from("webhook_events_log")
      .update({ attempts: tentativas })
      .eq("id", linha.id)
      .eq("status", "received")
      .eq("attempts", linha.attempts)
      .select("id");
    if (erroAoTomar) {
      falhasSeguidas += 1;
      r.ainda_falhando += 1;
      continue;
    }
    if (((tomada as { id: string }[] | null) ?? []).length === 0) continue;

    const falhou = async (detalhe: string) => {
      falhasSeguidas += 1;
      if (tentativas >= MAX_TENTATIVAS) {
        await desistir(admin, linha, r, { motivo: detalhe, tentativas, aviso: detalhe });
      } else {
        await registrarFalhaDaEntrada(admin, linha.id, tentativas, detalhe);
        r.ainda_falhando += 1;
      }
    };

    if (!linha.raw_body) {
      // Sem corpo, tentar de novo não muda nada. Morre, com aviso — a mensagem
      // aceita não entrou. (Dentro da janela a poda não alcança o corpo; isto é
      // o cinto para um arquivo que nasceu sem ele.)
      await desistir(admin, linha, r, {
        motivo: "replay: arquivo sem corpo",
        tentativas,
        aviso: "arquivo sem corpo",
      });
      continue;
    }

    let sessao: InboundWebhookInput["session"] | null;
    try {
      sessao = await sessaoDaLinha(admin, linha);
    } catch (err) {
      await falhou(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!sessao) {
      // Canal apagado ou arquivado: a rota também não ingeriria. Sem aviso — foi decisão de alguém.
      await desistir(admin, linha, r, { motivo: "replay: canal inexistente ou arquivado", tentativas });
      continue;
    }

    const desfecho = await processarEntradaAceita(
      admin,
      { sessao, rawBody: linha.raw_body, arquivoId: linha.id },
      { retomada: true },
    );
    if (desfecho.tipo === "falhou") {
      await falhou(desfecho.detalhe);
      continue;
    }
    falhasSeguidas = 0;
    if (desfecho.tipo === "processada") r.processadas += 1;
    else r.desistidas += 1;
  }
  await encerrarVencidas(admin, desde, r);
  return r;
}
