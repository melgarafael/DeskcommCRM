import { z } from "zod";
import { diaLocalISO, diaDaSemanaLocal, instanteDe } from "../fuso";
import { fusoValido } from "@/lib/tempo/fusos";

export const MODOS_DE_RESERVA = ["individual", "collective_limited", "collective_unlimited"] as const;
export const REGRAS_DE_CAPACIDADE = ["inherit", "limited", "unlimited"] as const;
export type ModoDeReserva = (typeof MODOS_DE_RESERVA)[number];
export type RegraDeCapacidade = (typeof REGRAS_DE_CAPACIDADE)[number];

const uuid = z.string().uuid();
const inteiro = (min: number, max: number) => z.number().int().min(min).max(max);
export const horarioDoServicoSchema = z.object({
  id: uuid.optional(),
  weekday: inteiro(0, 6).nullish(),
  on_date: z.iso.date().nullish(),
  timing_kind: z.enum(["fixed", "window"]),
  start_minute: inteiro(0, 1439),
  end_minute: inteiro(1, 1440).nullish(),
  duration_minutes: inteiro(5, 1440).nullish(),
  capacity_rule: z.enum(REGRAS_DE_CAPACIDADE).default("inherit"),
  capacity_limit: inteiro(1, 100_000).nullish(),
}).superRefine((value, ctx) => {
  if ((value.weekday == null) === (value.on_date == null))
    ctx.addIssue({ code: "custom", path: ["weekday"], message: "Escolha toda semana ou somente uma data." });
  if (value.timing_kind === "window" && (value.end_minute == null || value.end_minute <= value.start_minute))
    ctx.addIssue({ code: "custom", path: ["end_minute"], message: "O fim da faixa precisa vir depois do início." });
  if (value.capacity_rule === "limited" && value.capacity_limit == null)
    ctx.addIssue({ code: "custom", path: ["capacity_limit"], message: "Informe o limite deste horário." });
});
export type HorarioDoServico = z.infer<typeof horarioDoServicoSchema>;

/** O mesmo contrato do formulário, da rota e da ferramenta; nenhum path JSON privado na tela. */
export const configuracaoDoServicoSchema = z.object({
  event_type_id: uuid,
  expected_revision: inteiro(1, Number.MAX_SAFE_INTEGER),
  service_enabled: z.boolean(),
  is_active: z.boolean().optional(),
  requires_confirmation: z.boolean().optional(),
  booking_mode: z.enum(MODOS_DE_RESERVA),
  service_capacity: inteiro(1, 100_000).nullish(),
  service_timezone: z.string().refine(fusoValido, "Escolha um fuso válido."),
  destination_calendar_id: uuid.nullish(),
  service_publication_mode: z.enum(["none", "service", "professional"]).default("none"),
  professionals: z.array(uuid).max(100).refine((v) => new Set(v).size === v.length),
  resources: z.array(z.object({ resource_id: uuid, units: inteiro(1, 100_000) })).max(50)
    .refine((v) => new Set(v.map((r) => r.resource_id)).size === v.length),
  calendar_sources: z.array(uuid).max(100).refine((v) => new Set(v).size === v.length),
  schedule: z.array(horarioDoServicoSchema).max(256),
}).superRefine((value, ctx) => {
  for (let i = 0; i < value.schedule.length; i++) for (let j = i + 1; j < value.schedule.length; j++) {
    const a = value.schedule[i]!, b = value.schedule[j]!;
    const sameDay = a.on_date != null ? a.on_date === b.on_date : b.on_date == null && a.weekday === b.weekday;
    if (sameDay && ((a.timing_kind === "fixed" && b.timing_kind === "fixed" && a.start_minute === b.start_minute)
      || (a.timing_kind === "window" && b.timing_kind === "window" && a.start_minute < (b.end_minute ?? 0) && b.start_minute < (a.end_minute ?? 0))))
      ctx.addIssue({ code: "custom", path: ["schedule", j], message: "Há horários sobrepostos na programação. Confira a configuração." });
  }
  if (value.booking_mode === "collective_limited" && value.service_capacity == null)
    ctx.addIssue({ code: "custom", path: ["service_capacity"], message: "Informe a capacidade do serviço." });
  if (value.booking_mode === "individual" && value.schedule.some((r) => r.capacity_rule !== "inherit"))
    ctx.addIssue({ code: "custom", path: ["schedule"], message: "O atendimento individual sempre ocupa um profissional." });
  if (value.service_enabled && value.is_active !== false && value.schedule.length === 0)
    ctx.addIssue({ code: "custom", path: ["schedule"], message: "Adicione pelo menos um horário antes de ativar." });
  if (value.service_enabled && value.is_active !== false && value.booking_mode === "individual" && value.professionals.length === 0)
    ctx.addIssue({ code: "custom", path: ["professionals"], message: "Escolha os profissionais habilitados." });
  if (value.service_publication_mode === "service" && !value.destination_calendar_id)
    ctx.addIssue({ code: "custom", path: ["destination_calendar_id"], message: "Escolha o calendário de destino." });
  if (value.service_publication_mode === "professional" && value.professionals.length === 0)
    ctx.addIssue({ code: "custom", path: ["professionals"], message: "Escolha os profissionais que publicarão em suas agendas." });
});
export type ConfiguracaoDoServico = z.infer<typeof configuracaoDoServicoSchema>;

export const bloquearServicoSchema = z.object({
  operation_key: uuid,
  scope_kind: z.enum(["service", "professional", "resource"]),
  event_type_id: uuid.nullish(),
  owner_user_id: uuid.nullish(),
  resource_id: uuid.nullish(),
  starts_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(300),
  publish_google: z.boolean().default(false),
}).superRefine((v, ctx) => {
  const target = v.scope_kind === "service" ? v.event_type_id : v.scope_kind === "professional" ? v.owner_user_id : v.resource_id;
  if (!target) ctx.addIssue({ code: "custom", message: "Escolha o alcance do bloqueio." });
  if (new Date(v.ends_at) <= new Date(v.starts_at)) ctx.addIssue({ code: "custom", path: ["ends_at"], message: "O fim precisa vir depois do início." });
  if (v.publish_google && v.scope_kind !== "service") ctx.addIssue({ code: "custom", message: "Para publicar, escolha um serviço com calendário de destino." });
});

export interface RegraDoServico {
  booking_mode: ModoDeReserva;
  service_capacity: number | null;
  service_timezone: string;
  duration_minutes: number;
  slot_interval_minutes?: number | null;
}
export function capacidadeEfetiva(servico: RegraDoServico, horario: HorarioDoServico): number | null {
  if (servico.booking_mode === "individual") return 1;
  if (horario.capacity_rule === "unlimited") return null;
  if (horario.capacity_rule === "limited") return horario.capacity_limit ?? null;
  return servico.booking_mode === "collective_limited" ? servico.service_capacity : null;
}

export interface CandidatoDoServico {
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  capacity_rule: RegraDeCapacidade;
  capacity_limit: number | null;
  rule_id?: string;
}

/** Uma regra de data substitui só o trecho que declara, nunca os bloqueios ou a jornada pessoal. */
export function horarioEfetivo(
  rows: readonly HorarioDoServico[], dia: string, weekday: number, minuto: number,
): HorarioDoServico | null {
  const contem = (r: HorarioDoServico) => r.timing_kind === "fixed"
    ? r.start_minute === minuto
    : r.start_minute <= minuto && r.end_minute != null && minuto < r.end_minute;
  const candidatos = rows.filter((r) => (r.on_date === dia || (r.on_date == null && r.weekday === weekday)) && contem(r));
  // Faixas sobrepostas com regras concorrentes não se resolvem pela ordem de INSERT.
  const datados = candidatos.filter((r) => r.on_date === dia);
  const prioridade = datados.length ? datados : candidatos;
  const fixos = prioridade.filter((r) => r.timing_kind === "fixed");
  const escolhidos = fixos.length ? fixos : prioridade;
  return escolhidos.length === 1 ? escolhidos[0] ?? null : null;
}

export function candidatosDoServico(
  servico: RegraDoServico, rows: readonly HorarioDoServico[], de: Date, ate: Date,
): CandidatoDoServico[] {
  if (!fusoValido(servico.service_timezone) || !(ate > de) || ate.getTime() - de.getTime() > 62 * 86_400_000)
    throw new Error("Período ou fuso inválido.");
  const result = new Map<string, CandidatoDoServico>();
  const primeiraData = diaLocalISO(de, servico.service_timezone);
  const ultimaData = diaLocalISO(ate, servico.service_timezone);
  for (let civil = new Date(`${primeiraData}T12:00:00Z`); civil.toISOString().slice(0, 10) <= ultimaData; civil = new Date(civil.getTime() + 86_400_000)) {
    const dia = civil.toISOString().slice(0, 10);
    const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = dia.split("-").map(Number);
    const meioDia = instanteDe({ ano: year, mes: month, dia: day, hora: 12, minuto: 0 }, servico.service_timezone);
    const weekday = diaDaSemanaLocal(meioDia, servico.service_timezone);
    const minutos = new Set<number>();
    for (const r of rows.filter((r) => r.on_date === dia || (r.on_date == null && r.weekday === weekday))) {
      const duration = r.duration_minutes ?? servico.duration_minutes;
      const step = servico.slot_interval_minutes ?? duration;
      if (!(step > 0)) throw new Error("Intervalo inválido.");
      if (r.timing_kind === "fixed") minutos.add(r.start_minute);
      else for (let m = r.start_minute; m + duration <= (r.end_minute ?? 0); m += step) minutos.add(m);
    }
    for (const minuto of minutos) {
      const regra = horarioEfetivo(rows, dia, weekday, minuto);
      if (!regra) continue;
      const duration = regra.duration_minutes ?? servico.duration_minutes;
      if (regra.timing_kind === "window" && minuto + duration > (regra.end_minute ?? 0)) continue;
      const start = instanteDe({ ano: year, mes: month, dia: day, hora: Math.floor(minuto / 60), minuto: minuto % 60 }, servico.service_timezone);
      const end = new Date(start.getTime() + duration * 60_000);
      if (start < de || start >= ate) continue;
      result.set(start.toISOString(), {
        starts_at: start.toISOString(), ends_at: end.toISOString(), duration_minutes: duration,
        capacity_rule: regra.capacity_rule, capacity_limit: capacidadeEfetiva(servico, regra),
        ...(regra.id ? { rule_id: regra.id } : {}),
      });
      if (result.size > 500) throw new Error("A consulta tem mais de 500 horários. Escolha um período menor.");
    }
  }
  return [...result.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
