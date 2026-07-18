/**
 * Zod schemas do roteamento de atendimento (G5-01 — spec 13 §3.4/§3.5/§5).
 *
 * - routingConfigSchema: organizations.settings.routing (mode + knobs). Os knobs
 *   (max_retries, backoff_seconds) são CONFIG lida pelo worker de G5-02 — NUNCA
 *   constantes hardcoded no worker (doutrina do repo).
 * - availabilitySchedule: janela tz-aware por atendente ({timezone, windows}).
 * - availabilityPatchSchema: PATCH parcial de attendant_availability.
 */
import { z } from "zod";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Modos de roteamento no MVP (decisão G1-06b); "load" fica pós-MVP. */
export const ROUTING_MODES = ["manual", "round_robin"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/**
 * organizations.settings.routing. Default mode = "manual" (round_robin é opt-in,
 * derivado de G1-06b). Defaults dos knobs = spec 13 §3.5.
 */
export const routingConfigSchema = z.object({
  mode: z.enum(ROUTING_MODES).default("manual"),
  max_retries: z.number().int().min(0).max(20).default(5),
  backoff_seconds: z.number().int().min(1).max(3600).default(60),
});
export type RoutingConfig = z.infer<typeof routingConfigSchema>;

/** Uma janela de disponibilidade: dow 0=domingo … 6=sábado, "HH:MM"–"HH:MM". */
export const scheduleWindowSchema = z
  .object({
    dow: z.number().int().min(0).max(6),
    start: z.string().regex(HHMM, "start deve ser HH:MM"),
    end: z.string().regex(HHMM, "end deve ser HH:MM"),
  })
  .refine((w) => w.start < w.end, { message: "start deve ser antes de end" });
export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>;

/**
 * schedule tz-aware. `windows` vazio = sem restrição de horário (24/7) — o
 * default do DB é `{}`, então um atendente recém-criado não fica inelegível por
 * falta de janela; janelas EXISTEM para RESTRINGIR.
 */
export const availabilityScheduleSchema = z.object({
  timezone: z.string().min(1).max(64).default("America/Sao_Paulo"),
  windows: z.array(scheduleWindowSchema).max(50).default([]),
});
export type AvailabilitySchedule = z.infer<typeof availabilityScheduleSchema>;

/** PATCH parcial de disponibilidade (o atendente muda a sua; manager, de todos). */
export const availabilityPatchSchema = z
  .object({
    is_available: z.boolean(),
    capacity: z.number().int().min(1).max(1000),
    schedule: availabilityScheduleSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Informe ao menos um campo (is_available, capacity ou schedule).",
  });
export type AvailabilityPatch = z.infer<typeof availabilityPatchSchema>;
