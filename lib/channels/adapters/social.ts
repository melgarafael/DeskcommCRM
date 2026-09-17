import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ChannelAdapter } from "../types";
import { channelCredentials } from "../social/service";
import { SOCIAL_PROVIDER, socialExternalId } from "../social/contract";

/** DMs endereçam IGSID/PSID da conversa, nunca telefone ou identidade de outro canal. */
export const socialAdapter: ChannelAdapter = {
  provider: SOCIAL_PROVIDER,
  acceptedStatus: "sending",
  codes: {
    notConfigured: "social_not_configured",
    sendFailed: "social_send_failed",
    unknownError: "social_unknown_error",
  },
  isConfigured: () => true,
  resolveRecipient: (input) => (input.isGroup ? null : input.providerRecipientId || null),
  async send(envelope) {
    if (!envelope.idempotencyKey) throw new Error("social_idempotency_required");
    const creds = await channelCredentials(
      createAdminClient(),
      envelope.organizationId,
      envelope.sessionRef,
    );
    if (creds.status !== "WORKING") throw new Error("social_channel_disconnected");
    let body: Record<string, unknown>;
    if (envelope.kind === "text") body = { type: "text", text: { body: envelope.body ?? "" } };
    else if (envelope.media && ["image", "video", "audio", "document"].includes(envelope.kind)) {
      body = {
        type: "media",
        media: {
          url: envelope.media.url,
          kind: envelope.kind,
          caption: envelope.body || undefined,
        },
      };
    } else throw new Error("social_message_type_unsupported");
    await envelope.beforeSend?.();
    const result = await creds.client.send(
      envelope.sessionRef,
      envelope.to,
      body,
      envelope.idempotencyKey,
    );
    return { externalId: socialExternalId(result.message_id) };
  },
  async fetchInboundMedia(input) {
    assertSafeOutboundUrl(input.url);
    const url = new URL(input.url);
    if (
      url.protocol !== "https:" ||
      !["fbcdn.net", "cdninstagram.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    )
      throw new Error("social_media_host_invalid");
    await assertDestinoResolvidoSeguro(url.hostname);
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!res.ok || Number(res.headers.get("content-length")) > 50 * 1024 * 1024)
      throw new Error("social_media_unavailable");
    if (!res.body) throw new Error("social_media_empty");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > 50 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("social_media_too_large");
      }
      chunks.push(chunk.value);
    }
    return {
      buffer: Buffer.concat(chunks),
      mime: res.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
    };
  },
  async checkHealth(input) {
    try {
      const creds = await channelCredentials(
        createAdminClient(),
        input.organizationId,
        input.sessionRef,
      );
      const channels = await creds.client.channels();
      const channel = channels.find((c) => c.id === input.sessionRef);
      return {
        reachable: true,
        status: channel?.status === "connected" ? "WORKING" : "STOPPED",
        detail: channel ? null : "Conexão não encontrada no provedor.",
      };
    } catch {
      return {
        reachable: false,
        status: null,
        detail: "Não foi possível consultar a conexão social.",
      };
    }
  },
};
