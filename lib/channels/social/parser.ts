import { z } from "zod";
import { inboxSupported, socialMessageId } from "./catalog";
import type { ZernioInboundMessage } from "../zernio/webhook";

const text = z.string().min(1);
const schema = z.object({
  event: z.enum([
    "message.received",
    "message.sent",
    "message.delivered",
    "message.read",
    "message.failed",
  ]),
  account: z.object({ id: text, platform: text }),
  message: z.object({
    id: text,
    platformMessageId: text.nullish(),
    conversationId: text,
    platform: text,
    direction: z.enum(["incoming", "outgoing"]),
    text: z.string().nullish(),
    sentAt: z.iso.datetime({ offset: true }).nullish(),
    sender: z
      .object({ id: text, name: z.string().nullish(), username: z.string().nullish() })
      .nullish(),
    attachments: z.array(z.object({ type: text, url: z.url() })).default([]),
  }),
  conversation: z
    .object({
      participantId: text,
      participantName: z.string().nullish(),
      participantUsername: z.string().nullish(),
    })
    .nullish(),
});
export interface SocialMessage extends ZernioInboundMessage {
  platform: string;
  participantId: string;
}
export function parseSocialMessage(
  payload: unknown,
  accountId: string,
  platform: string,
): SocialMessage | null {
  const parsed = schema.safeParse(payload);
  if (!parsed.success || !inboxSupported(platform)) return null;
  const p = parsed.data;
  if (
    p.account.id !== accountId ||
    p.account.platform !== platform ||
    p.message.platform !== platform
  )
    return null;
  const outbound = p.message.direction === "outgoing";
  // Event and direction must agree; an outgoing echo must never dispatch the AI.
  if (p.event === "message.received" && outbound) return null;
  if (p.event !== "message.received" && !outbound) return null;
  const participantId = outbound ? p.conversation?.participantId : p.message.sender?.id;
  if (!participantId) return null;
  const status =
    p.event === "message.received"
      ? undefined
      : (p.event.slice(8) as "sent" | "delivered" | "read" | "failed");
  return {
    platform,
    participantId,
    accountId,
    conversationId: p.message.conversationId,
    externalId: socialMessageId(accountId, p.message.platformMessageId ?? p.message.id),
    direction: outbound ? "outbound" : "inbound",
    kind: status && status !== "sent" ? "status" : "message",
    status,
    text: p.message.text ?? null,
    sentAt: p.message.sentAt ?? null,
    attachments: p.message.attachments,
    referral: null,
    identity: {
      phone: null,
      bsuid: null,
      anchor: null,
      username:
        (outbound ? p.conversation?.participantUsername : p.message.sender?.username) ?? null,
      displayName: (outbound ? p.conversation?.participantName : p.message.sender?.name) ?? null,
    },
  };
}
