/**
 * Canal de SMS (#4415) — o recibo de entrega de uma mensagem que enviamos.
 *
 * O fornecedor aceita o envio (`queued`, a linha nasce `sent`) e só depois a
 * operadora entrega ou recusa. Sem este passo, a recusa da operadora nunca
 * chegava ao operador: a Inbox dizia "enviado" para um SMS que não tocou o
 * aparelho. É o mesmo defeito que `lib/channels/meta/status-update.ts` fechou
 * no canal oficial, e a regra é a mesma:
 *
 * - `status` fica no domínio que o produto lê (`sent | delivered | failed`);
 * - nunca rebaixa: um `sent` atrasado não desfaz um `delivered`, e nada
 *   reescreve um `failed` (a ordem dos avisos não é garantida);
 * - `delivered_at` é carimbado UMA vez, pelo primeiro aviso que o alcança;
 * - só mensagem `outbound` DESTA conexão: o aviso cita um id do fornecedor, e
 *   a conexão é quem diz de quem ele é.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import type { AvisoDeStatus } from "./twilio";

export type ResultadoDoAviso =
  | { status: "ingested"; reason: string }
  | { status: "ignored"; reason: string };

/** O código que fica em `messages.error_code`: a categoria, nunca o número do fornecedor. */
export function codigoDaFalha(aviso: AvisoDeStatus): string {
  return `sms_${aviso.motivo ?? "outro"}`;
}

export async function aplicarAvisoDeStatus(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; aviso: AvisoDeStatus },
): Promise<ResultadoDoAviso> {
  const { organizationId, channelSessionId, aviso } = input;
  if (!aviso.desfecho) return { status: "ignored", reason: "estado_intermediario" };

  const agora = new Date().toISOString();
  const update: Record<string, unknown> = { status: aviso.desfecho, updated_at: agora };
  if (aviso.desfecho === "failed") {
    update.error_code = codigoDaFalha(aviso);
    update.error_message = `A operadora não entregou o SMS (${aviso.motivo ?? "outro"}${
      aviso.codigo !== null ? `, código ${aviso.codigo}` : ""
    }).`;
  }

  // O que cada desfecho pode sobrescrever. `failed` nunca é sobrescrito, e
  // `delivered` não volta para `sent`.
  const naoSobrescreve = aviso.desfecho === "sent" ? "(delivered,read,failed)" : "(read,failed)";

  const { data, error } = await admin
    .from("messages")
    .update(update)
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .eq("external_id", aviso.externalId)
    .eq("direction", "outbound")
    .not("status", "in", naoSobrescreve)
    .select("id");
  if (error) throw new Error(`sms_status_update_failed: ${error.message}`);

  if (aviso.desfecho === "delivered") {
    const { error: erroDoCarimbo } = await admin
      .from("messages")
      .update({ delivered_at: agora })
      .eq("organization_id", organizationId)
      .eq("channel_session_id", channelSessionId)
      .eq("external_id", aviso.externalId)
      .eq("direction", "outbound")
      .is("delivered_at", null);
    // Best-effort: o carimbo é métrica, o status já foi gravado.
    if (erroDoCarimbo) {
      logger.warn("[sms] hora da entrega não gravada", {
        organization_id: organizationId,
        erro: erroDoCarimbo.message,
      });
    }
  }

  return (data ?? []).length > 0
    ? { status: "ingested", reason: `status_${aviso.desfecho}` }
    : { status: "ignored", reason: "mensagem_desconhecida_ou_ja_resolvida" };
}
