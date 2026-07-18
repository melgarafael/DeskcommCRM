/**
 * Elegibilidade de atendente para roteamento (spec 13 §5).
 *
 * Elegível = disponível ∧ dentro do horário (schedule tz-aware) ∧ abaixo da
 * capacidade. Lógica PURA e testável — o worker de G5-02 (cron TS) importa daqui
 * e passa o `now` + a carga atual (conversas abertas atribuídas). Sem acesso a
 * DB, sem relógio implícito: o `now` é sempre injetado (teste usa clock mockado).
 *
 * AT-08: o auto-offline por heartbeat velho vive aqui como constante NOMEADA
 * única (não espalhada como número mágico) e como predicado testável; o cron
 * `/api/v1/cron/attendant-heartbeat` faz o UPDATE a partir do cutoff.
 */
import type { AvailabilitySchedule } from "@/lib/schemas/routing";

/** AT-08: atendente sem heartbeat há mais que isto ⇒ auto-offline (config, não mágica). */
export const HEARTBEAT_TIMEOUT_MINUTES = 15;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Momento local (dow 0-6 + "HH:MM") de `now` no timezone dado. tz-aware via
 * Intl (stdlib, sem dependência) — respeita DST do fuso.
 */
function localMoment(now: Date, timezone: string): { dow: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dow = WEEKDAY_INDEX[get("weekday")] ?? 0;
  const hhmm = `${get("hour")}:${get("minute")}`;
  return { dow, hhmm };
}

/**
 * `now` cai dentro de alguma janela do schedule?
 * `windows` vazio (default do DB `{}`) = sem restrição de horário ⇒ true (24/7);
 * janelas existem para RESTRINGIR, não para habilitar.
 */
export function isWithinSchedule(
  schedule: Pick<AvailabilitySchedule, "timezone" | "windows"> | null | undefined,
  now: Date,
): boolean {
  const windows = schedule?.windows ?? [];
  if (windows.length === 0) return true;
  const timezone = schedule?.timezone || "America/Sao_Paulo";
  const { dow, hhmm } = localMoment(now, timezone);
  return windows.some((w) => w.dow === dow && hhmm >= w.start && hhmm < w.end);
}

/** Heartbeat mais velho que o timeout ⇒ considerado offline (AT-08). */
export function isHeartbeatStale(
  lastHeartbeatAt: string | Date | null | undefined,
  now: Date,
  timeoutMinutes: number = HEARTBEAT_TIMEOUT_MINUTES,
): boolean {
  if (!lastHeartbeatAt) return true;
  const last = new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last > timeoutMinutes * 60_000;
}

export interface AttendantEligibilityInput {
  isAvailable: boolean;
  capacity: number;
  /** Conversas abertas atribuídas ao atendente (carga atual). */
  currentLoad: number;
  schedule?: Pick<AvailabilitySchedule, "timezone" | "windows"> | null;
}

/** disponível ∧ com folga (carga < capacidade) ∧ dentro do horário (§5). */
export function isAttendantEligible(input: AttendantEligibilityInput, now: Date): boolean {
  return (
    input.isAvailable &&
    input.currentLoad < input.capacity &&
    isWithinSchedule(input.schedule ?? null, now)
  );
}
