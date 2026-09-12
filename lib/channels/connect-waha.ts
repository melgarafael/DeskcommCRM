import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { TETO_NOME_DE_SESSAO_WAHA, nomeDaSessaoCabeNoWaha } from "@/lib/channels/nome-da-sessao";
import type { WahaClient } from "@/lib/waha/client";
import { WahaSessionError } from "@/lib/waha/client";

const channelSchema = z.object({
  id: z.string().uuid(), organization_id: z.string().uuid(), waha_session_name: z.string(),
  status: z.enum(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]),
  display_name: z.string().nullable().optional(), phone_number: z.string().nullable().optional(),
  status_reason: z.string().nullable().optional(), archived_at: z.string().nullable().optional(),
});
const receiptSchema = z.object({
  replay: z.boolean(), channel: channelSchema.nullable(), receipt_id: z.string().uuid(), lease_token: z.string().uuid().optional(),
});
export class ChannelConnectionError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly technical?: Record<string, unknown>) { super(code); }
}
type Transport = Pick<WahaClient, "createSession" | "startExistingSession" | "stopSession">;
export interface ConnectChannelInput {
  organizationId: string; idempotencyKey: string; userId: string; requestId: string;
  displayName?: string; onboarding?: boolean; restart?: boolean;
}

/** Única reserva WAHA: auth client reserva, service client confirma por lease+org.
 * HTTP não participa da transação. Falha mantém FAILED e identidade; retry
 * reutiliza o remoto existente. Nunca exclui uma sessão automaticamente.
 */
export async function connectWahaChannel(authDb: SupabaseClient, serviceDb: SupabaseClient, waha: Transport, input: ConnectChannelInput): Promise<{ channel: z.infer<typeof channelSchema>; replay: boolean }> {
  if (!z.string().uuid().safeParse(input.idempotencyKey).success) throw new ChannelConnectionError("idempotency_key_required", 422);
  const hash = createHash("sha256").update(JSON.stringify({ display_name: input.displayName ?? null, onboarding: input.onboarding ?? false, restart: input.restart ?? false })).digest("hex");
  const { data, error } = await authDb.rpc("fn_reserve_channel_connection", {
    p_org: input.organizationId, p_key: input.idempotencyKey, p_hash: hash,
    p_display_name: input.displayName ?? null, p_onboarding: input.onboarding ?? false,
  });
  if (error) {
    const code = ["idempotency_conflict", "connection_in_progress", "connection_mfa_required", "connection_forbidden"].find((c) => error.message.includes(c));
    throw new ChannelConnectionError(code ?? "connection_reservation_failed", error.code === "42501" ? 403 : code ? 409 : 500);
  }
  const receipt = receiptSchema.parse(data);
  const channel = receipt.channel;
  if (!channel || channel.organization_id !== input.organizationId) throw new ChannelConnectionError("connection_reservation_missing", 410);
  if (receipt.replay) return { channel, replay: true };
  if (!receipt.lease_token) throw new ChannelConnectionError("connection_lease_lost", 409);
  let created = false;
  async function finish(status: string, reason?: string) {
    const result = await serviceDb.rpc("fn_finish_channel_connection", {
      p_org: input.organizationId, p_receipt: receipt.receipt_id, p_lease: receipt.lease_token,
      p_status: status, p_reason: reason ?? null, p_created: created,
    });
    if (result.error) throw new ChannelConnectionError("connection_checkpoint_failed", 503);
    return result.data;
  }
  // Teto do WAHA conferido AQUI, antes de qualquer chamada ao transporte.
  //
  // Deixar passar é o defeito da issue #667: o WAHA devolve um 400 opaco no meio
  // do fluxo, com a reserva já feita, e o card de Conexões fica preso em
  // `Parado`. Nome acima do teto não é falha de transporte — é dado de uma
  // instalação que ainda não encurtou o identificador, e o operador precisa
  // saber disso, não receber um erro genérico. A reserva é fechada em `FAILED`
  // para não travar a próxima tentativa.
  if (!nomeDaSessaoCabeNoWaha(channel.waha_session_name)) {
    await finish("FAILED", "session_name_too_long");
    throw new ChannelConnectionError("connection_session_name_too_long", 409, {
      waha_session_name: channel.waha_session_name,
      comprimento: channel.waha_session_name.length,
      teto: TETO_NOME_DE_SESSAO_WAHA,
    });
  }
  try {
    if (input.restart) await waha.stopSession(channel.waha_session_name);
    const creation = await waha.createSession(channel.waha_session_name);
    created = creation.created;
    if (created) await finish("remote_created");
    const remote = await waha.startExistingSession(channel.waha_session_name);
    if (remote.name !== channel.waha_session_name || !["STARTING", "SCAN_QR_CODE", "WORKING"].includes(remote.status)) {
      throw new Error("connection_postcondition_failed");
    }
    const persisted = channelSchema.parse(await finish(remote.status));
    if (persisted.organization_id !== input.organizationId || persisted.id !== channel.id || persisted.status !== remote.status) {
      throw new Error("connection_checkpoint_mismatch");
    }
    void audit({ action: channel.archived_at ? "channel.reactivated" : "channel.connected", actorUserId: input.userId,
      organizationId: input.organizationId, resourceType: "channel_session", resourceId: channel.id,
      requestId: input.requestId, metadata: { provider: "waha", origin: input.onboarding ? "onboarding" : "connections" } });
    return { channel: persisted, replay: false };
  } catch (cause) {
    const code = "connection_repair_required";
    await finish("FAILED", code);
    throw new ChannelConnectionError(code, 502, cause instanceof WahaSessionError
      ? { operation: cause.operation, http_status: cause.httpStatus } : undefined);
  }
}

/** Ações manuais aguardam apenas a reserva em execução; FAILED é recuperável. */
export async function assertWahaConnectionIdle(db: SupabaseClient,
  organizationId: string, channelSessionId: string): Promise<void> {
  const { data, error } = await db.from("channel_connection_requests")
    .select("id, lease_until").eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId).in("state", ["processing"])
    .order("lease_until", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new ChannelConnectionError("connection_reservation_failed", 503);
  if (data && new Date(data.lease_until).getTime() > Date.now()) throw new ChannelConnectionError("connection_in_progress", 409);
}
