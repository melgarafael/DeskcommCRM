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
 *     mesmo aviso, salvo se a mensagem já estava no CRM e só o fechamento falhou;
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
  MENSAGEM_DO_NUMERO_OFICIAL_QUE_NAO_ENTROU,
} from "@/lib/event-log/aviso-de-evento-morto";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

import { fecharArquivoDoWebhook } from "./arquivo-de-webhook";
import { processarEntradaAceita, registrarFalhaDaEntrada } from "./entrada-aceita";
import { CANAIS_QUE_RESPONDEM_ANTES, idExternoDaEntradaAceita, type InboundWebhookInput } from "./inbound";
import { MAX_TENTATIVAS, type ResultadoDoReplay } from "./reprocessar-arquivo-de-webhook";

/** Folga para o `after()` da própria requisição terminar antes. */
export const ESPERA_DA_ENTRADA_MS = 5 * 60 * 1000;
/** Mais velha que isto não se ingere: vira `dead` com aviso (ver o cabeçalho). */
export const JANELA_DA_ENTRADA_MS = 6 * 60 * 60 * 1000;
/** A rodada não começa linha nova depois disto (o agendador corta em 45 s). */
export const PRAZO_DA_RODADA_MS = 20_000;
const LOTE = 10;
const FALHAS_SEGUIDAS_PARA_PARAR = 3;
const COLUNAS_DA_LINHA = "id, organization_id, channel_session_id, raw_body, payload_parsed, attempts, error_message";

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

async function marcarMorta(admin: Admin, linha: LinhaAceita, motivo: string, tentativas: number): Promise<void> {
  const { error } = await admin
    .from("webhook_events_log")
    .update({ status: "dead", attempts: tentativas, error_message: motivo.slice(0, 500) })
    .eq("id", linha.id);
  if (error) {
    logger.error("[webhook-replay] não marcou a entrada como morta", { log_id: linha.id, detail: error.message });
  }
}

/** Um aviso aberto por organização enquanto durar — Central inundada ninguém lê. */
async function avisarMensagemPerdida(
  admin: Admin,
  linha: LinhaAceita,
  tentativas: number,
  motivo: string,
): Promise<void> {
  try {
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", linha.organization_id)
      .eq("kind", "event_dead")
      .eq("status", "open")
      .eq("title", MENSAGEM_DO_NUMERO_OFICIAL_QUE_NAO_ENTROU.titulo)
      .limit(1)
      .maybeSingle();
    if (jaAberto) return;
    const { title, body } = avisoDaMensagemDoNumeroOficial({ eventType: eventoDa(linha), tentativas, motivo });
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

/**
 * A mensagem desta linha já está no CRM? Lança se a leitura falhar. Sem corpo não
 * há como saber, e a resposta é `false`: o aviso a mais é o lado certo do erro.
 */
async function mensagemJaEntrou(admin: Admin, linha: LinhaAceita): Promise<boolean> {
  const externalId = linha.raw_body ? idExternoDaEntradaAceita(linha.raw_body) : null;
  if (!externalId) return false;
  const { data, error } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", linha.organization_id)
    .eq("external_id", externalId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`mensagem não lida: ${error.message}`);
  return data !== null;
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
    let entrou: boolean;
    try {
      entrou = await mensagemJaEntrou(admin, linha);
    } catch (err) {
      logger.warn("[webhook-replay] entrada vencida não conferida", {
        log_id: linha.id,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (entrou) {
      await fecharArquivoDoWebhook(admin, linha.id, {
        status: "processed",
        validSignature: true,
        erro: "vencida_com_a_mensagem_no_crm",
      });
      r.processadas += 1;
      continue;
    }
    const motivo = "passou da janela de reprocessamento sem terminar";
    await marcarMorta(admin, linha, `replay: ${motivo}`, linha.attempts);
    await avisarMensagemPerdida(admin, linha, linha.attempts, motivo);
    r.desistidas += 1;
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
        await marcarMorta(admin, linha, detalhe, tentativas);
        await avisarMensagemPerdida(admin, linha, tentativas, detalhe);
        r.desistidas += 1;
      } else {
        await registrarFalhaDaEntrada(admin, linha.id, tentativas, detalhe);
        r.ainda_falhando += 1;
      }
    };

    if (!linha.raw_body) {
      // Sem corpo, tentar de novo não muda nada. Morre, com aviso — a mensagem
      // aceita não entrou. (Dentro da janela a poda não alcança o corpo; isto é
      // o cinto para um arquivo que nasceu sem ele.)
      await marcarMorta(admin, linha, "replay: arquivo sem corpo", tentativas);
      await avisarMensagemPerdida(admin, linha, tentativas, "arquivo sem corpo");
      r.desistidas += 1;
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
      await marcarMorta(admin, linha, "replay: canal inexistente ou arquivado", tentativas);
      r.desistidas += 1;
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
