import { z } from "zod";

export const weekdays = [
  { value: 1, label: "Segunda-feira" },
  { value: 2, label: "Terça-feira" },
  { value: 3, label: "Quarta-feira" },
  { value: 4, label: "Quinta-feira" },
  { value: 5, label: "Sexta-feira" },
  { value: 6, label: "Sábado" },
  { value: 7, label: "Domingo" },
] as const;

/** Horário de parede: a grade semanal não representa uma data nem um instante UTC. */
export const scheduleSchema = z.object({
  modality_id: z.uuid(),
  audience_id: z.uuid(),
  teacher_id: z.uuid(),
  space_id: z.uuid(),
  weekday: z.number().int().min(1).max(7),
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Informe um horário no formato HH:mm."),
  duration_minutes: z.number().int().min(1).max(1440),
  notes: z.string().trim().max(2000).default(""),
  active: z.boolean().default(true),
}).strict();

export type ScheduleValues = z.infer<typeof scheduleSchema>;
export type ScheduleRecord = ScheduleValues & {
  id: string;
  organization_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export const scheduleColumns = "id,organization_id,modality_id,audience_id,teacher_id,space_id,weekday,start_time,duration_minutes,notes,active,revision,created_at,updated_at";

/** Postgres devolve TIME como HH:mm:ss; a precisão contratada é de minuto. */
export function scheduleValues(record: ScheduleRecord): ScheduleValues {
  return {
    modality_id: record.modality_id,
    audience_id: record.audience_id,
    teacher_id: record.teacher_id,
    space_id: record.space_id,
    weekday: record.weekday,
    start_time: record.start_time.slice(0, 5),
    duration_minutes: record.duration_minutes,
    notes: record.notes,
    active: record.active,
  };
}

export function formatClassEnd(start: string, duration: number): string {
  const [hours = 0, minutes = 0] = start.split(":").map(Number);
  const end = hours * 60 + minutes + duration;
  const hh = Math.floor((end % 1440) / 60).toString().padStart(2, "0");
  const mm = (end % 60).toString().padStart(2, "0");
  return `${hh}:${mm}${end >= 1440 ? " (+1 dia)" : ""}`;
}
