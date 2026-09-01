import { instantFromWallClock } from "@/lib/tempo/zoned-clock";

export interface ComputeSlotsInput {
  /** "YYYY-MM-DD" */
  date: string;
  timezone: string;
  durationMinutes: number;
  /** Blocos do dia de semana já filtrado, "HH:MM:SS" */
  scheduleBlocks: { starts_at: string; ends_at: string }[];
  /** Agendamentos `scheduled` que já ocupam parte do dia */
  existingAppointments: { scheduled_at: string; duration_minutes: number }[];
}

export interface Slot {
  startsAt: string;
  endsAt: string;
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

function parseTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour: hour!, minute: minute! };
}

/**
 * Slots livres de `durationMinutes` dentro dos blocos de horário, descontando
 * agendamentos já marcados. Granularidade dos slots = `durationMinutes` (sem
 * sobreposição entre slots candidatos — o próximo começa onde o anterior
 * termina).
 */
export function computeAvailableSlots(input: ComputeSlotsInput): Slot[] {
  const { year, month, day } = parseDate(input.date);
  const durationMs = input.durationMinutes * 60_000;

  const ocupados = input.existingAppointments.map((a) => {
    const start = new Date(a.scheduled_at).getTime();
    return { start, end: start + a.duration_minutes * 60_000 };
  });

  const slots: Slot[] = [];

  for (const bloco of input.scheduleBlocks) {
    const inicio = parseTime(bloco.starts_at);
    const fim = parseTime(bloco.ends_at);
    const blocoStart = instantFromWallClock(year, month, day, inicio.hour, inicio.minute, input.timezone).getTime();
    const blocoEnd = instantFromWallClock(year, month, day, fim.hour, fim.minute, input.timezone).getTime();

    for (let candidateStart = blocoStart; candidateStart + durationMs <= blocoEnd; candidateStart += durationMs) {
      const candidateEnd = candidateStart + durationMs;
      const colide = ocupados.some((o) => candidateStart < o.end && candidateEnd > o.start);
      if (!colide) {
        slots.push({
          startsAt: new Date(candidateStart).toISOString(),
          endsAt: new Date(candidateEnd).toISOString(),
        });
      }
    }
  }

  return slots;
}
