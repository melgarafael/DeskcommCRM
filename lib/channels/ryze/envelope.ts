import { z } from "zod";

import { conferirEnvelope, type LeituraDeEnvelope } from "@/lib/webhooks/contrato";

const text = z.string().min(1);
const instanceData = z.looseObject({
  token: z.string().optional(),
  baseUrl: z.string().optional(),
});

const exchangeMessage = z.looseObject({
  id: text.optional(),
  direction: z.enum(["incoming", "outgoing"]),
  status: z.string().optional(),
  text: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  remoteJid: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  media: z.unknown().optional(),
});

const statusMessage = z.looseObject({
  id: text.optional(),
  status: z.string().optional(),
  direction: z.enum(["incoming", "outgoing"]).optional(),
  text: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
});

const exchangeData = z.looseObject({
  id: text.optional(),
  message: exchangeMessage,
  instanceData: instanceData.optional(),
});

const statusData = z.looseObject({
  id: text.optional(),
  message: statusMessage,
  instanceData: instanceData.optional(),
});

const root = z.looseObject({
  event: text,
  data: z.unknown().optional(),
  instanceData: instanceData.optional(),
});

export const ryzeEnvelopeSchema = z.discriminatedUnion("event", [
  z.looseObject({ event: z.literal("message.exchange"), data: exchangeData, instanceData: instanceData.optional() }),
  z.looseObject({ event: z.literal("message.status"), data: statusData, instanceData: instanceData.optional() }),
]);

export type RyzeEnvelope = z.infer<typeof ryzeEnvelopeSchema>;
export type RyzeMessage = RyzeEnvelope["data"]["message"];
export type RyzeExchangeMessage = Extract<RyzeEnvelope, { event: "message.exchange" }>["data"]["message"];
export type RyzeWebhookParse =
  | { ok: true; kind: "supported"; envelope: RyzeEnvelope }
  | { ok: true; kind: "unsupported"; event: string }
  | { ok: false; motivo: "json_invalido" | "contrato_violado"; campos: string[] };

export function lerEnvelopeRyze(rawBody: string): LeituraDeEnvelope<RyzeEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, motivo: "json_invalido", campos: [] };
  }
  return conferirEnvelope(parsed, ryzeEnvelopeSchema);
}

export function lerWebhookRyze(rawBody: string): RyzeWebhookParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, motivo: "json_invalido", campos: [] };
  }

  const base = root.safeParse(parsed);
  if (!base.success) {
    return { ok: false, motivo: "contrato_violado", campos: base.error.issues.map((i) => i.path.join(".") || "(raiz)") };
  }
  if (base.data.event !== "message.exchange" && base.data.event !== "message.status") {
    return { ok: true, kind: "unsupported", event: base.data.event };
  }
  const strict = conferirEnvelope(parsed, ryzeEnvelopeSchema);
  return strict.ok ? { ok: true, kind: "supported", envelope: strict.envelope } : strict;
}

export function ryzeEventId(envelope: RyzeEnvelope): string | null {
  return envelope.data.id ?? null;
}

export function ryzeMessageExternalId(envelope: RyzeEnvelope): string | null {
  return envelope.data.message.id ?? null;
}

export function ryzeStatusDedupeKey(envelope: RyzeEnvelope): string | null {
  const eventId = ryzeEventId(envelope);
  const messageId = ryzeMessageExternalId(envelope);
  const status = envelope.data.message.status;
  return eventId ?? (messageId && status ? `${envelope.event}:${messageId}:${status}` : null);
}
