import { z } from "zod";
import { assertCurrentServiceBoundary, parseServiceBoundary, type ServiceBoundary, type CurrentServiceBoundary } from "@/lib/atendimento/fronteira";

export const meetingStateSchema = z.enum([
  "not_requested",
  "pending",
  "ready",
  "failed",
  "cancelled",
]);
export const meetingErrors = {
  google_failure: "O Google não conseguiu criar o link. Tente criar novamente.",
  unsupported: "Esta agenda não permite Google Meet. Confira as configurações da conta.",
  unknown: "O link ainda não foi confirmado. Tente verificar novamente.",
  invalid: "O Google não devolveu um link de vídeo válido. Verifique novamente.",
} as const;
export const conferenceSchema = z
  .object({
    createRequest: z
      .object({
        requestId: z.string().optional(),
        status: z.object({ statusCode: z.enum(["pending", "success", "failure"]) }).optional(),
      })
      .optional(),
    conferenceSolution: z.object({ key: z.object({ type: z.string() }) }).optional(),
    entryPoints: z
      .array(z.object({ entryPointType: z.string(), uri: z.string().optional() }))
      .optional(),
  })
  .passthrough();
/** URL retornada, nunca derivada de conferenceId/htmlLink; credencial fica só no appointment. */
export function meetVideoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "meet.google.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/[a-z0-9-]+\/?$/i.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export type MeetingObservation = {
  state: "pending" | "ready" | "failed";
  received: boolean;
  url: string | null;
  error: keyof typeof meetingErrors | null;
};
export function observeMeeting(
  event: { conferenceData?: unknown; hangoutLink?: unknown },
  requestId: string,
  adopt = false,
): MeetingObservation | null {
  const parsed = conferenceSchema.safeParse(event.conferenceData);
  if (!parsed.success)
    return event.conferenceData
      ? { state: "failed", received: false, url: null, error: "invalid" }
      : null;
  const c = parsed.data;
  const received = c.createRequest?.requestId === requestId;
  if (!received && !adopt) return null;
  const status = c.createRequest?.status?.statusCode;
  // Failure antigo permite uma nova intenção explícita; uma criação alheia
  // ainda pending é incerta e não pode ser substituída por outro pedido.
  if (!received && status === "failure") return null;
  if (!received && status === "pending")
    return { state: "failed", received: false, url: null, error: "unknown" };
  if (received && status === "failure")
    return { state: "failed", received: true, url: null, error: "google_failure" };
  if (received && status === "pending")
    return { state: "pending", received: true, url: null, error: null };
  if (c.conferenceSolution?.key.type !== "hangoutsMeet")
    return { state: "failed", received, url: null, error: "invalid" };
  const url =
    meetVideoUrl(c.entryPoints?.find((p) => p.entryPointType === "video")?.uri) ??
    meetVideoUrl(event.hangoutLink);
  return url
    ? { state: "ready", received, url, error: null }
    : { state: "failed", received, url: null, error: "invalid" };
}
export const meetingDeliverySchema = z.object({
  state: z.enum(["none", "waiting_for_link", "queued", "sent", "blocked", "stale", "failed"]),
  generation: z.uuid().optional(),
  error: z.string().nullable().optional(),
  service_boundary: z
    .custom<ServiceBoundary>((value) => parseServiceBoundary(value) !== null)
    .optional(),
  authorized_by: z.object({ kind: z.enum(["user", "ai_agent"]), id: z.string() }).optional(),
  source_operation_id: z.uuid().optional(),
  channel_session_id: z.uuid().optional(),
  settled_at: z.string().optional(),
});

/** DTO revela somente se a intenção antiga ainda pertence ao atendimento atual. */
export function meetingAuthorizationCurrent(expected: ServiceBoundary | null, current: CurrentServiceBoundary | null): boolean {
  try { assertCurrentServiceBoundary(expected, current); return true; } catch { return false; }
}
export const meetingDeliveryErrors: Record<string, string> = {
  opt_out: "O contato bloqueou mensagens. O envio permanece impedido; respeite essa escolha.",
  lgpd: "Os dados do contato não permitem o envio. Confira a situação e a base legal no cadastro.",
  channel: "O canal foi arquivado ou mudou. Escolha um atendimento em um canal disponível.",
  access_or_stale: "O acesso do solicitante ou o atendimento mudou. Confira o responsável e escolha um atendimento disponível.",
  force_human: "O contato está em atendimento humano. O responsável pode autorizar este link pelo botão de envio, sem ativar a IA.",
  conversa_silenciada: "A IA está silenciada neste atendimento. O responsável pode autorizar somente este link pelo botão de envio.",
  conversa_de_humano: "Este atendimento está atribuído a uma pessoa. O responsável pode autorizar somente este link pelo botão de envio.",
  sem_autorizacao: "O contato não está autorizado para atendimento automático. O responsável pode autorizar somente este link pelo botão de envio.",
  autorizacao_expirada: "A autorização de atendimento automático expirou. O responsável pode autorizar somente este link pelo botão de envio.",
  limits: "O envio atingiu uma janela ou limite do canal. Aguarde a liberação antes de tentar novamente.",
  guardrail: "Uma regra de envio impediu a mensagem. Confira o aviso na Central antes de tentar novamente.",
};
