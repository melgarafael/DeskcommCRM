/**
 * A ENTRADA ACEITA — o evento que a rota respondeu antes de processar.
 *
 * `_entrada-do-canal.ts` arquiva o corpo cru, confere assinatura e conta, MARCA a
 * linha do arquivo como aceita e responde 200. A ingestão roda depois da
 * resposta (`after()` do Next) por `processarDepoisDaResposta`, e o que não
 * terminar — o contêiner reiniciou no meio, o banco recusou — fica na linha
 * para o cron `webhook-replay` (`reprocessar-entradas-aceitas.ts`), que passa
 * pela MESMA `processarEntradaAceita`.
 *
 * ─── O estado, todo na linha de `webhook_events_log` ───────────────────────
 *
 *   status `received` + `valid_signature = true`  → aceita, processamento pendente
 *   status `processed`                            → a ingestão terminou
 *   status `error`                                → recusada pelo contrato; tentar de novo não muda nada
 *   status `dead`                                 → o reprocessamento desistiu, com aviso na Central
 *
 * `attempts` conta as tentativas que falharam (a de depois da resposta é a 1ª)
 * e `error_message` guarda a última falha. Sem coluna nova: `received` já era
 * "ainda não terminou", e `processed_at` nulo continua querendo dizer isso.
 *
 * A marca de aceita é `valid_signature = true` gravada ANTES da resposta. É ela
 * que separa a linha que o servidor aceitou da linha que só foi arquivada — se o
 * processo morrer entre o arquivo e a assinatura, a linha fica `received` com
 * `valid_signature` nulo, o provedor não recebeu resposta e reentrega, e o
 * reprocessamento não a toca: um corpo cuja assinatura ninguém conferiu nunca
 * vira mensagem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { fecharArquivoDoWebhook } from "./arquivo-de-webhook";
import { processarEventoAceito, type InboundWebhookInput } from "./inbound";

export interface EntradaAceita {
  sessao: InboundWebhookInput["session"];
  rawBody: string;
  arquivoId: string;
}

export type DesfechoDaEntradaAceita =
  | { tipo: "processada" }
  | { tipo: "recusada"; motivo: string }
  | { tipo: "falhou"; detalhe: string };

/**
 * Grava a aceitação na linha do arquivo. `false` quando não gravou — e aí a
 * rota NÃO responde 200: sem a linha marcada, nada garante que o evento será
 * processado se o processo morrer, e o provedor precisa reentregar.
 */
export async function aceitarEntrada(admin: SupabaseClient, arquivoId: string): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("webhook_events_log")
      .update({ valid_signature: true })
      .eq("id", arquivoId)
      .eq("status", "received")
      .select("id");
    if (error) {
      logger.warn("[entrada-aceita] não consegui marcar a linha como aceita", {
        log_id: arquivoId,
        detail: error.message.slice(0, 160),
      });
      return false;
    }
    return ((data as { id: string }[] | null) ?? []).length === 1;
  } catch (err) {
    logger.warn("[entrada-aceita] não consegui marcar a linha como aceita", {
      log_id: arquivoId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return false;
  }
}

/**
 * Roda a ingestão de uma entrada aceita e fecha a linha quando há desfecho.
 * Nunca lança: a falha volta como `falhou`, com a linha ainda `received`, e
 * quem chama decide o que fazer com ela. `retomada` é do reprocessamento: a
 * mensagem já gravada ainda pode estar sem os efeitos.
 */
export async function processarEntradaAceita(
  admin: SupabaseClient,
  entrada: EntradaAceita,
  opcoes: { retomada?: boolean } = {},
): Promise<DesfechoDaEntradaAceita> {
  let r: Awaited<ReturnType<typeof processarEventoAceito>>;
  try {
    r = await processarEventoAceito(admin, {
      session: entrada.sessao,
      rawBody: entrada.rawBody,
      retomada: opcoes.retomada,
    });
  } catch (err) {
    return { tipo: "falhou", detalhe: err instanceof Error ? err.message : "ingest_failed" };
  }

  if (r.ok) {
    await fecharArquivoDoWebhook(admin, entrada.arquivoId, {
      status: "processed",
      validSignature: true,
      // O desfecho do seam vai junto, como na resposta síncrona: é ele que
      // distingue "ingerido" de "ignorado" quando alguém for contar depois.
      erro: typeof r.body.reason === "string" ? r.body.reason : null,
    });
    return { tipo: "processada" };
  }

  // Recusa do contrato: o mesmo corpo vai ser recusado sempre. A assinatura
  // conferiu (a linha só é aceita depois dela), então `validSignature` fica
  // `true` — marcá-la `false` mandaria procurar um segredo errado que não existe.
  await fecharArquivoDoWebhook(admin, entrada.arquivoId, {
    status: "error",
    validSignature: true,
    erro: r.message,
  });
  return { tipo: "recusada", motivo: r.message };
}

/**
 * Registra a tentativa que falhou, sem fechar a linha: ela continua `received`
 * para o reprocessamento achá-la. Best-effort — se nem isto grava, a linha já
 * está `received` e aceita, que é o que o reprocessamento procura.
 */
export async function registrarFalhaDaEntrada(
  admin: SupabaseClient,
  arquivoId: string,
  tentativas: number,
  detalhe: string,
): Promise<void> {
  try {
    const { error } = await admin
      .from("webhook_events_log")
      .update({ attempts: tentativas, error_message: detalhe.slice(0, 500) })
      .eq("id", arquivoId)
      .eq("status", "received");
    if (error) {
      logger.warn("[entrada-aceita] falha da entrada não registrada", {
        log_id: arquivoId,
        detail: error.message.slice(0, 160),
      });
    }
  } catch (err) {
    logger.warn("[entrada-aceita] falha da entrada não registrada", {
      log_id: arquivoId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
}

/**
 * O corpo do `after()`: a ingestão que antes segurava a resposta. É a primeira
 * tentativa; se falhar, a linha fica para o reprocessamento.
 */
export async function processarDepoisDaResposta(
  admin: SupabaseClient,
  entrada: EntradaAceita & { requestId: string },
): Promise<DesfechoDaEntradaAceita> {
  const desfecho = await processarEntradaAceita(admin, entrada);
  if (desfecho.tipo === "falhou") {
    logger.warn("[entrada-aceita] ingestão depois da resposta falhou — fica para o reprocessamento", {
      organization_id: entrada.sessao.organization_id,
      channel_session_id: entrada.sessao.id,
      log_id: entrada.arquivoId,
      request_id: entrada.requestId,
      detail: desfecho.detalhe.slice(0, 160),
    });
    await registrarFalhaDaEntrada(admin, entrada.arquivoId, 1, desfecho.detalhe);
  }
  return desfecho;
}
