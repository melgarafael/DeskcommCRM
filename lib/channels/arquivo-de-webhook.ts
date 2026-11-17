/**
 * O CORPO CRU DO QUE O PROVEDOR MANDOU.
 *
 * ─── Por que isto precisa existir ───────────────────────────────────────────
 *
 * `webhook_events_log` é o único lugar onde o payload original fica guardado. A
 * rota do canal por QR grava lá desde sempre; a rota genérica de canal — por
 * onde entram os canais oficiais — não gravava nada. Barrido antes desta peça:
 * zero escritores naquele caminho.
 *
 * Não é lacuna abstrata. O comentário de `lib/waha/ingest.ts` mostra que a
 * decisão sobre identidades opacas (`@lid`) só foi possível porque esse arquivo
 * existia em produção — "76 de 76", contados no banco. O instrumento que
 * respondeu aquela pergunta faltava justamente no canal NOVO, que é onde ainda
 * há pergunta aberta: se mensagem de grupo chega, e de qual host vem o anexo.
 *
 * ─── Duas escritas, e não uma ───────────────────────────────────────────────
 *
 * A linha nasce ANTES do processamento, com `received`. Se o processo morrer no
 * meio — exceção, OOM, deploy no instante errado — o corpo cru continua lá, que
 * é justamente quando alguém vai querer lê-lo. Gravar só no fim perderia
 * exatamente os casos que motivam o arquivo.
 *
 * A entrada que responde antes de processar escreve uma terceira vez, no meio:
 * a marca de aceita (`valid_signature = true`), gravada antes do 200 — é o que o
 * cron `webhook-replay` procura quando o processamento não termina.
 *
 * ─── O que este módulo NÃO faz ──────────────────────────────────────────────
 *
 * Não interpreta o payload. `event_type` e `external_id` ficam nulos de
 * propósito: lê-los exigiria saber o formato de cada canal, e essa é a decisão
 * que o seam existe para manter longe da rota. O `payload_parsed` guarda o JSON
 * inteiro — quem investigar lê `payload_parsed->>'event'` e tem a mesma
 * resposta, sem que ninguém precise ensinar o formato a este arquivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { TELEGRAM_SECRET_HEADER } from "./bot/webhook";

/** Cabeçalhos que NUNCA entram no arquivo, por menor que seja a chance. */
// `asaas-access-token` (spec da cobrança do revendedor §2.4): o Asaas autentica
// o webhook com um token ESTÁTICO no cabeçalho — é a credencial inteira, não uma
// assinatura. A rota de cobrança nem grava cabeçalho; isto é o cinto para quando
// alguém apontar o aviso do Asaas para uma rota de canal.
// `x-telegram-bot-api-secret-token` (#3486): o Telegram autentica o webhook com o
// `secret_token` do setWebhook repetido VERBATIM no cabeçalho — é o segredo
// inteiro, não uma assinatura. Guardado aqui, qualquer um que lesse o arquivo
// forjaria updates do robô.
const PROIBIDOS = ["authorization", "cookie", "x-api-key", "asaas-access-token", TELEGRAM_SECRET_HEADER];

/**
 * Cabeçalhos sanitizados.
 *
 * A assinatura FICA: ela é o que permite reconferir depois se um payload
 * recusado tinha mesmo assinatura errada, ou se o segredo é que estava errado —
 * e é assinatura, não credencial: não abre nada sozinha.
 */
export function cabecalhosSeguros(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((valor, chave) => {
    if (PROIBIDOS.includes(chave.toLowerCase())) return;
    out[chave] = valor;
  });
  return out;
}

/**
 * Abre a linha do arquivo. Devolve o id para o fechamento, ou `null` quando não
 * deu — e "não deu" não interrompe a ingestão que roda ANTES da resposta: perder
 * o arquivo é ruim, perder a mensagem do cliente é pior.
 *
 * A exceção é o evento que o canal processa DEPOIS de responder
 * (`./entrada-aceita.ts`): ali a linha é a única coisa que garante a mensagem
 * se o processo morrer, e sem ela a rota responde 503 para o provedor reentregar.
 */
export async function abrirArquivoDoWebhook(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    channelSessionId: string;
    provider: string;
    rawBody: string;
    headers: Headers;
  },
): Promise<string | null> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(entrada.rawBody) as unknown;
    // Só objeto vai para a coluna `jsonb`: um payload que seja lista ou escalar
    // é legítimo em JSON e não cabe no formato desta coluna.
    parsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    // Corpo que não é JSON é EXATAMENTE o que se quer arquivar: é o caso que
    // ninguém consegue reproduzir depois. `raw_body` guarda ele inteiro.
    parsed = null;
  }

  try {
    const { data, error } = await admin
      .from("webhook_events_log")
      .insert({
        organization_id: entrada.organizationId,
        channel_session_id: entrada.channelSessionId,
        // Vem da SESSÃO, nunca de um literal: a rota não pode nomear canal, e
        // o `lint:channels` reprova quem tenta.
        provider: entrada.provider,
        http_method: "POST",
        headers: cabecalhosSeguros(entrada.headers),
        raw_body: entrada.rawBody,
        payload_parsed: parsed,
        status: "received",
        attempts: 0,
      })
      .select("id")
      .maybeSingle();

    if (error) {
      logger.warn("[arquivo-webhook] não consegui abrir a linha", {
        detail: error.message.slice(0, 160),
      });
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    logger.warn("[arquivo-webhook] não consegui abrir a linha", {
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return null;
  }
}

/**
 * Fecha a linha com o desfecho.
 *
 * `valid_signature` só é `false` quando a recusa foi POR assinatura. Um payload
 * bem assinado que o parser ignorou não é assinatura inválida, e marcar como se
 * fosse mandaria quem investigar procurar um problema de segredo que não existe.
 */
export async function fecharArquivoDoWebhook(
  admin: SupabaseClient,
  id: string | null,
  desfecho: { status: "processed" | "error"; validSignature: boolean | null; erro?: string | null },
): Promise<void> {
  if (!id) return;
  try {
    await admin
      .from("webhook_events_log")
      .update({
        status: desfecho.status,
        valid_signature: desfecho.validSignature,
        error_message: desfecho.erro ?? null,
        processed_at: new Date().toISOString(),
      })
      .eq("id", id);
  } catch {
    // A linha `received` já está gravada com o corpo cru, que é o que importa.
    // Falhar aqui não pode derrubar a resposta ao provedor.
  }
}

/** Só a rodada que encontrou a linha ainda pendente pode registrar a desistência. */
export async function marcarArquivoDoWebhookComoMorto(
  admin: SupabaseClient,
  linha: { id: string; organization_id: string | null },
  pendente: { status: "received" | "error"; attempts: number },
  desfecho: { motivo: string; tentativas: number },
): Promise<"gravado" | "mudou" | "falhou"> {
  const update = admin
    .from("webhook_events_log")
    .update({
      status: "dead",
      attempts: desfecho.tentativas,
      error_message: desfecho.motivo.slice(0, 500),
    })
    .eq("id", linha.id)
    .eq("status", pendente.status)
    .eq("attempts", pendente.attempts);
  const daOrg =
    linha.organization_id === null
      ? update.is("organization_id", null)
      : update.eq("organization_id", linha.organization_id);
  const { data, error } = await daOrg.select("id");
  if (error) {
    logger.error("[webhook-replay] não marcou a linha como morta", {
      log_id: linha.id,
      detail: error.message,
    });
    return "falhou";
  }
  return data?.length ? "gravado" : "mudou";
}
