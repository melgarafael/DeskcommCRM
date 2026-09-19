import { MAX_MEDIA_BYTES, MediaTooLargeError } from "@/lib/messaging/media/types";
import { z } from "zod";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { zernioBaseUrl } from "../zernio/credentials";
import { createAdminClient } from "@/lib/supabase/admin";
import { zernioAdapter } from "../adapters/zernio";
import { zernioCredsForAccountId } from "../zernio/credentials";
import { socialMessageId, SOCIAL_PROVIDER } from "./catalog";
import { socialRequest } from "./client";
import type { ChannelAdapter } from "../types";

export const socialAdapter: ChannelAdapter = {
  ...zernioAdapter,
  provider: SOCIAL_PROVIDER,
  // Recipient routing is exclusively the stored providerConversationId, never a phone.
  resolveRecipient: (input) => (input.isGroup ? null : "provider-thread"),
  templates: undefined,
  async checkHealth(input) {
    const db = createAdminClient();
    const { data } = await db
      .from("channel_sessions")
      .select("metadata")
      .eq("organization_id", input.organizationId)
      .eq("provider", SOCIAL_PROVIDER)
      .eq("zernio_account_id", input.sessionRef)
      .is("archived_at", null)
      .maybeSingle();
    if (!(data?.metadata as Record<string, unknown>)?.social_webhook_id)
      return { reachable: true, status: "FAILED", detail: "recebimento_nao_configurado" };
    const creds = await zernioCredsForAccountId(db, {
      organizationId: input.organizationId,
      accountId: input.sessionRef,
    });
    if (!creds) return { reachable: true, status: "FAILED", detail: "credencial_indisponivel" };
    try {
      const result = z
        .object({ status: z.string() })
        .parse(
          await socialRequest(
            creds.apiKey,
            `accounts/${encodeURIComponent(input.sessionRef)}/health`,
          ),
        );
      return result.status === "healthy"
        ? { reachable: true, status: "WORKING", detail: null }
        : { reachable: true, status: "FAILED", detail: "conta_requer_atencao" };
    } catch {
      return { reachable: false, status: null, detail: "provedor_indisponivel" };
    }
  },
  async fetchInboundMedia(input) {
    const url = new URL(input.url);
    assertSafeOutboundUrl(url.toString());
    await assertDestinoResolvidoSeguro(url.hostname);
    const creds = await zernioCredsForAccountId(createAdminClient(), {
      organizationId: input.organizationId,
      accountId: input.sessionRef,
    });
    if (!creds) throw new Error("Credencial indisponível para baixar a mídia.");
    // Only the provider's own media endpoint receives its API key, never a CDN or redirect.
    const providerMedia =
      url.origin === new URL(zernioBaseUrl()).origin && url.pathname.startsWith("/api/v1/");
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: providerMedia ? { Authorization: `Bearer ${creds.apiKey}` } : {},
    });
    if (!response.ok) throw new Error(`Falha ao baixar mídia (HTTP ${response.status}).`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_MEDIA_BYTES) {
      await response.body?.cancel();
      throw new MediaTooLargeError();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("A mídia retornou um corpo vazio.");
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_MEDIA_BYTES) {
          await reader.cancel();
          throw new MediaTooLargeError();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks);
    return {
      buffer,
      mime:
        response.headers.get("content-type")?.split(";")[0] ??
        input.hintMime ??
        "application/octet-stream",
    };
  },
  async sendTemplate() {
    throw new Error("Esta rede não usa modelos de WhatsApp.");
  },
  async send(envelope) {
    if (!envelope.providerConversationId)
      throw new Error("Aguarde uma mensagem do cliente para responder nesta rede.");
    if (!["text", "image", "video", "audio"].includes(envelope.kind))
      throw new Error("Este tipo de mensagem ainda não é suportado nesta rede.");
    const creds = await zernioCredsForAccountId(createAdminClient(), {
      organizationId: envelope.organizationId,
      accountId: envelope.sessionRef,
    });
    if (!creds) throw new Error("Reconecte esta conta em Redes sociais.");
    await envelope.beforeSend?.();
    const result = await socialRequest(
      creds.apiKey,
      `inbox/conversations/${encodeURIComponent(envelope.providerConversationId)}/messages`,
      {
        accountId: creds.accountId,
        ...(envelope.media
          ? {
              attachmentUrl: envelope.media.url,
              attachmentType: envelope.kind,
              ...(envelope.media.caption ? { message: envelope.media.caption } : {}),
            }
          : { message: envelope.body ?? "" }),
      },
    );
    const parsed = z.object({ data: z.object({ messageId: z.string().min(1) }) }).safeParse(result);
    if (!parsed.success)
      throw new Error(
        "Envio sem confirmação do provedor. Confira a conversa antes de tentar novamente.",
      );
    return { externalId: socialMessageId(creds.accountId, parsed.data.data.messageId) };
  },
};
