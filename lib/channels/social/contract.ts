import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Contrato público 1.3: https://hub.sociosai.com/docs/referencia. */
export const SOCIAL_PROVIDER = "socios_hub" as const;
export const SOCIAL_LABEL = "Sócios AI Hub";
export const socialNetworkSchema = z.enum(["instagram", "messenger"]);
export type SocialNetwork = z.infer<typeof socialNetworkSchema>;
const id = z.string().min(1).max(200);
export const channelSchema = z.object({
  id,
  type: socialNetworkSchema,
  status: z.enum(["connected", "disconnected", "pending"]),
  display_name: z.string().nullish(),
  external_id: z.string().nullish(),
});
export const envelopeSchema = z.object({
  id,
  event: id,
  subaccount_id: id,
  channel_id: id.optional(),
  created_at: z.number().finite(),
  data: z.record(z.string(), z.unknown()),
});
export const messageSchema = z.object({
  message_id: id,
  channel: socialNetworkSchema,
  channel_id: id,
  conversation_id: id,
  contact_id: id,
  from: z.object({ external_id: id, name: z.string().nullish() }),
  type: id,
  timestamp: z.number().finite().nonnegative(),
  content: z
    .object({
      text: z.string().optional(),
      title: z.string().optional(),
      attachments: z
        .array(z.object({ type: z.string(), payload: z.object({ url: z.string().url() }) }))
        .optional(),
    })
    .passthrough(),
});

/** Verifica o corpo BRUTO. Secret literal, como documentado; não decodificar whsec_. */
export function verifySocialWebhook(
  raw: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
): boolean {
  const eventId = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!eventId || !timestamp || !signature || secret.length < 16 || !/^\d+$/.test(timestamp))
    return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now / 1000 - seconds) > 300) return false;
  const expected = Buffer.from(
    `v1,${createHmac("sha256", secret).update(`${eventId}.${timestamp}.${raw}`).digest("base64")}`,
  );
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function socialExternalId(messageId: string): string {
  return `${SOCIAL_PROVIDER}:${messageId}`;
}
