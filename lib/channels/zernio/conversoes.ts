/**
 * Venda reportada à Meta PELO CANAL intermediado.
 *
 *   POST /v1/whatsapp/conversions
 *
 * O provedor liga um conjunto de dados da Meta ao número (tela "Conversions"
 * dele) e repassa o evento com o vínculo do clique que ELE guardou ao receber
 * a conversa. Do lado do CRM não há token nem dataset: basta a chave da conta.
 *
 * ─── O 200 que não é sucesso ────────────────────────────────────────────────
 *
 * A resposta é `{ eventsReceived, eventsFailed, failures[], traceId }`, e ela
 * vem 200 mesmo quando a Meta recusou o evento. Ler só o status HTTP gravaria
 * "enviada" para uma venda que nunca chegou — exatamente o silêncio que a tela
 * de conversões existe para impedir. Por isso `eventsFailed > 0` é recusa.
 *
 * ─── Unidades, não centavos ─────────────────────────────────────────────────
 *
 * `value` é número na unidade da moeda. O CRM guarda `value_cents` = valor×100
 * em TODA moeda, então a conversão é a mesma divisão do transporte direto da
 * Meta (`lib/plataformas-de-anuncio/meta/conversions.ts`).
 */
import type { ChannelConversionInput, ChannelConversionResult } from "../types";

import { resolveZernioCreds } from "./credentials";
import { createAdminClient } from "@/lib/supabase/admin";

/** Espera do transitório quando o provedor não diz quanto. */
const ESPERA_PADRAO_MS = 5 * 60 * 1000;

interface RespostaDeConversao {
  eventsReceived?: number;
  eventsFailed?: number;
  failures?: unknown[];
  traceId?: string;
  error?: string;
  code?: string;
}

/** Texto curto e sem dado pessoal: vai para o livro-razão e para a tela. */
function resumo(texto: string): string {
  return texto.replace(/\s+/g, " ").trim().slice(0, 200);
}

function motivoDaFalha(falhas: unknown[] | undefined): string {
  const primeira = falhas?.[0];
  if (primeira && typeof primeira === "object") {
    const f = primeira as Record<string, unknown>;
    const msg = f.message ?? f.error ?? f.reason;
    if (typeof msg === "string" && msg) return msg;
  }
  return "evento recusado pela plataforma";
}

function esperaDe(res: Response): number {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? s * 1000 : ESPERA_PADRAO_MS;
}

export async function zernioReportConversion(
  input: ChannelConversionInput,
): Promise<ChannelConversionResult> {
  let creds;
  try {
    creds = await resolveZernioCreds(createAdminClient(), {
      organizationId: input.organizationId,
      accountId: input.sessionRef,
    });
  } catch (err) {
    // Consulta ao banco que falhou é instabilidade, não configuração errada.
    return { outcome: "retry", detail: resumo(`credencial ilegível: ${String(err)}`) };
  }
  if (!creds) return { outcome: "rejected", detail: "zernio_not_configured" };

  const corpo: Record<string, unknown> = {
    accountId: creds.accountId,
    eventName: input.event,
    eventId: input.eventId,
    eventTime: Math.floor(input.occurredAt.getTime() / 1000),
  };
  // Sem valor (evento de etapa), sem `value`/`currency` — zero seria mentira.
  if (input.valueCents !== null) {
    corpo.value = input.valueCents / 100;
    corpo.currency = input.currency;
  }
  if (input.providerConversationId) corpo.conversationId = input.providerConversationId;
  if (input.phone) corpo.phoneE164 = input.phone;

  let res: Response;
  try {
    res = await fetch(`${creds.baseUrl}/v1/whatsapp/conversions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  } catch (err) {
    return { outcome: "retry", detail: resumo(`rede: ${err instanceof Error ? err.message : String(err)}`) };
  }

  const json = (await res.json().catch(() => null)) as RespostaDeConversao | null;

  if (res.status === 429 || res.status >= 500) {
    return { outcome: "retry", detail: `zernio_${res.status}`, retryInMs: esperaDe(res) };
  }
  if (!res.ok) {
    const detalhe = json?.code ? `${json.code}: ${json.error ?? ""}` : (json?.error ?? res.statusText);
    return { outcome: "rejected", detail: resumo(`zernio_${res.status} ${detalhe}`) };
  }

  const rastro = json?.traceId ? ` (trace ${json.traceId})` : "";
  if ((json?.eventsFailed ?? 0) > 0 || (json?.eventsReceived ?? 0) < 1) {
    return { outcome: "rejected", detail: resumo(`${motivoDaFalha(json?.failures)}${rastro}`) };
  }
  return { outcome: "ok", detail: `via canal${rastro}` };
}
