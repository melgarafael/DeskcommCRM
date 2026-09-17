import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { encryptKey, decryptKey } from "@/lib/crypto/aes_gcm";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { sincronizarSaudeDaConexao } from "../health";
import { SocialClient } from "./client";
import { SOCIAL_PROVIDER, messageSchema, socialExternalId, type SocialNetwork } from "./contract";

const secretSchema = z.object({ ciphertext: z.string(), iv: z.string(), tag: z.string() });
export function seal(value: string) {
  const encrypted = encryptKey(value);
  return {
    ciphertext: encrypted.ciphertext.toString("base64"),
    iv: encrypted.iv.toString("base64"),
    tag: encrypted.tag.toString("base64"),
  };
}
export function unseal(value: unknown): string {
  const encrypted = secretSchema.parse(value);
  return decryptKey({
    ciphertext: Buffer.from(encrypted.ciphertext, "base64"),
    iv: Buffer.from(encrypted.iv, "base64"),
    tag: Buffer.from(encrypted.tag, "base64"),
  });
}
export async function connection(db: SupabaseClient, organizationId: string) {
  const { data, error } = await db
    .from("social_connections")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error("social_connection_lookup_failed");
  return data as {
    id: string;
    organization_id: string;
    account_id: string;
    credential: unknown;
    webhook_token: string;
    webhook_id: string | null;
    webhook_secret: unknown;
    webhook_url: string | null;
    last_event_at: string | null;
    last_test_at: string | null;
  } | null;
}
export async function syncChannels(db: SupabaseClient, org: string) {
  const row = await connection(db, org);
  if (!row) throw new Error("social_connection_missing");
  const client = new SocialClient(unseal(row.credential));
  const channels = await client.channels();
  const { data: locals, error: listError } = await db
    .from("channel_sessions")
    .select("id,social_channel_id,display_name,archived_at")
    .eq("organization_id", org)
    .eq("social_connection_id", row.id)
    .eq("provider", SOCIAL_PROVIDER);
  if (listError) throw new Error("social_channel_lookup_failed");
  for (const channel of channels) {
    const existing = locals?.find((local) => local.social_channel_id === channel.id);
    if (existing?.archived_at) continue;
    const values = {
      organization_id: org,
      provider: SOCIAL_PROVIDER,
      social_connection_id: row.id,
      social_channel_id: channel.id,
      social_network: channel.type,
      display_name: channel.display_name || channel.type,
      status:
        channel.status === "connected"
          ? "WORKING"
          : channel.status === "pending"
            ? "STARTING"
            : "STOPPED",
    };
    // Sincronização nunca reabre IA ou ressuscita canal arquivado.
    const result = existing
      ? await db
          .from("channel_sessions")
          .update(values)
          .eq("organization_id", org)
          .eq("id", existing.id)
      : await db.from("channel_sessions").insert({
          ...values,
          engine: "NOWEB",
          webhook_secret_encrypted: "\\x00",
          metadata: metadataInicialDoCanal(),
        });
    if (result.error) throw new Error("social_channel_save_failed");
    if (existing)
      await sincronizarSaudeDaConexao(
        db,
        { id: existing.id, organization_id: org, status: values.status },
        { reachable: true, status: values.status, detail: null },
        values.display_name,
        "empurrao",
      );
  }
  for (const local of locals ?? []) {
    if (local.archived_at || channels.some((c) => c.id === local.social_channel_id)) continue;
    const saved = await db
      .from("channel_sessions")
      .update({ status: "STOPPED" })
      .eq("organization_id", org)
      .eq("id", local.id);
    if (saved.error) throw new Error("social_channel_save_failed");
    await sincronizarSaudeDaConexao(
      db,
      { id: local.id, organization_id: org, status: "STOPPED" },
      { reachable: true, status: "STOPPED", detail: null },
      local.display_name ?? "Conexão social",
      "empurrao",
    );
  }
}

export async function channelCredentials(db: SupabaseClient, org: string, channelId: string) {
  const { data, error } = await db
    .from("channel_sessions")
    .select("social_channel_id,social_network,social_connection_id,status")
    .eq("organization_id", org)
    .eq("social_channel_id", channelId)
    .eq("provider", SOCIAL_PROVIDER)
    .is("archived_at", null)
    .single();
  if (error || !data) throw new Error("social_channel_unavailable");
  const row = await connection(db, org);
  if (!row || row.id !== data.social_connection_id) throw new Error("social_connection_missing");
  return {
    client: new SocialClient(unseal(row.credential)),
    status: data.status as string,
    network: data.social_network as SocialNetwork,
  };
}

/** Recebe só envelope autenticado; o org vem da conexão encontrada pelo token da rota. */
export async function processSocialEvent(
  db: SupabaseClient,
  org: string,
  eventId: string,
  event: string,
  payload: Record<string, unknown>,
) {
  const { data: receipt, error: receiptError } = await db
    .from("social_webhook_receipts")
    .select("event_id")
    .eq("organization_id", org)
    .eq("event_id", eventId)
    .maybeSingle();
  if (receiptError) throw new Error("social_receipt_read_failed");
  if (receipt) return;
  if (event === "message.received") {
    const parsed = messageSchema.safeParse(payload);
    if (!parsed.success) throw new Error("social_message_contract_invalid");
    const msg = parsed.data;
    const { data: session, error } = await db
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", org)
      .eq("social_channel_id", msg.channel_id)
      .eq("social_network", msg.channel)
      .eq("provider", SOCIAL_PROVIDER)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw new Error("social_session_lookup_failed");
    if (!session) {
      await syncChannels(db, org);
      throw new Error("social_session_refresh_retry");
    }
    const attachment = msg.content.attachments?.[0];
    const kind =
      attachment && ["image", "audio", "video", "file"].includes(attachment.type)
        ? attachment.type === "file"
          ? "document"
          : attachment.type
        : "text";
    const body =
      msg.content.text ??
      msg.content.title ??
      (attachment ? "[Anexo recebido]" : "[Mensagem não suportada — confira na rede social]");
    const { data, error: ingestError } = await db.rpc("fn_ingest_social_dm", {
      p_org: org,
      p_session: session.id,
      p_message: {
        channel_id: msg.channel_id,
        channel: msg.channel,
        conversation_id: msg.conversation_id,
        recipient_id: msg.from.external_id,
        name: msg.from.name ?? msg.channel,
        external_id: socialExternalId(msg.message_id),
        timestamp: msg.timestamp,
        type: kind,
        body,
        media_url: attachment?.payload.url ?? null,
      },
    });
    if (ingestError || !data) throw new Error("social_ingest_failed");
  } else if (event === "message.status") {
    const status = z
      .object({
        message_id: z.string().min(1),
        status: z.enum(["sent", "delivered", "read", "failed"]),
      })
      .parse(payload);
    const allowed = {
      sent: ["sending", "queued"],
      delivered: ["sending", "queued", "sent"],
      read: ["sending", "queued", "sent", "delivered"],
      failed: ["sending", "queued", "sent"],
    };
    const { data: message, error: readError } = await db
      .from("messages")
      .select("id")
      .eq("organization_id", org)
      .eq("external_id", socialExternalId(status.message_id))
      .maybeSingle();
    // O recibo pode chegar antes da resposta HTTP do envio: peça nova entrega ao HUB.
    if (readError || !message) throw new Error("social_receipt_waiting_message");
    const result = await db
      .from("messages")
      .update({
        status: status.status,
        ...(status.status === "failed"
          ? {
              error_code: "social_delivery_failed",
              error_message:
                "A rede social não entregou a mensagem. Confira a conexão e a janela de resposta.",
            }
          : {}),
      })
      .eq("organization_id", org)
      .eq("id", message.id)
      .in("status", allowed[status.status]);
    if (result.error) throw new Error("social_status_update_failed");
  } else if (event.startsWith("channel.")) {
    await syncChannels(db, org);
  }
  const { error } = await db
    .from("social_webhook_receipts")
    .upsert(
      { organization_id: org, event_id: eventId },
      { onConflict: "organization_id,event_id", ignoreDuplicates: true },
    );
  if (error) throw new Error("social_receipt_save_failed");
  await db
    .from("social_connections")
    .update({
      last_event_at: new Date().toISOString(),
      ...(event === "webhook.test" ? { last_test_at: new Date().toISOString() } : {}),
    })
    .eq("organization_id", org);
}
