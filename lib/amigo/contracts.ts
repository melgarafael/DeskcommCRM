import { z } from "zod";

/** Contratos sem segredo/Node: também podem alimentar formulários e tools. */
export const amigoOperations = [
  "patient_search",
  "patient_get",
  "patient_create",
  "patient_update",
  "patient_doctors",
  "patient_birthdays",
  "insurances",
  "insurance_plans",
  "insurance_products",
  "doctors",
  "doctors_available",
  "specialties",
  "doctor_dates",
  "attendance_create",
  "attendances",
  "patient_attendances",
  "attendance_cancel",
  "attendance_status",
  "attendance_reschedule",
  "places",
  "events",
  "calendar",
] as const;
export type AmigoOperation = (typeof amigoOperations)[number];
export type AmigoResponse = { data: unknown; status: "success" };

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(500);
const gender = z.enum(["Masculino", "Feminino"]);
const date = z.iso.date();
const hour = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
// Hora civil do provedor: nunca converter usando o fuso do servidor.
const civilDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/)
  .refine((value) => date.safeParse(value.slice(0, 10)).success);
const dateTime = z.union([civilDateTime, z.iso.datetime({ offset: true, local: true })]);
const monthDay = z
  .string()
  .regex(/^\d{2}-\d{2}$/)
  .refine((value) => date.safeParse(`2000-${value}`).success);
const patientFields = {
  name: text,
  gender: gender.optional(),
  contact_cellphone: text.optional(),
  email: z.email().max(320).optional(),
  cpf: text.optional(),
  cpf_responsible: text.optional(),
  insurance_number: text.optional(),
  insurance_id: id.optional(),
  address_cep: text.optional(),
  address_address: text.optional(),
  address_number: text.optional(),
  address_district: text.optional(),
  address_city: text.optional(),
  address_state: text.optional(),
  address_country: text.optional(),
  jobrole: text.optional(),
  mother_name: text.optional(),
  civil_status: text.max(25).optional(),
};
const insuranceFilter = { insurance_id: id.optional(), insurance_product_id: id.optional() };
function hasInsurance(value: { insurance_id?: number; insurance_product_id?: number }): boolean {
  // Pertencimento real do produto ao convênio é validado pelo Amigo, não inferido dos IDs.
  return value.insurance_product_id === undefined || value.insurance_id !== undefined;
}
function orderedDates(value: { start_date?: string; end_date?: string }): boolean {
  return !value.start_date || !value.end_date || value.start_date <= value.end_date;
}

export const amigoInputSchemas = {
  patient_search: z
    .strictObject({ cpf: text.optional(), contact_cellphone: text.optional() })
    .refine(
      (value) => value.cpf !== undefined || value.contact_cellphone !== undefined,
      "Informe CPF ou telefone",
    ),
  patient_get: z.strictObject({ patientId: id }),
  patient_create: z.strictObject(patientFields),
  patient_update: z.strictObject({ patientId: id, ...patientFields }),
  patient_doctors: z.strictObject({ patientId: id }),
  // Hoje/amanhã dependem do calendário da clínica no Amigo; aqui só o formato MM-DD.
  patient_birthdays: z.strictObject({ date: monthDay }),
  insurances: z.strictObject({ user_id: id.optional(), place_id: id.optional() }),
  insurance_plans: z.strictObject({
    insurance_group_id: id,
    event_id: id.optional(),
    user_id: id.optional(),
    place_id: id.optional(),
    only_schedulable: z.boolean().optional(),
  }),
  insurance_products: z.strictObject({ insurance_id: id }),
  doctors: z.strictObject({ to_confirm: z.boolean().optional() }),
  doctors_available: z
    .strictObject({
      ...insuranceFilter,
      event_id: id.optional(),
      place_id: id,
      specialty: z.array(text).max(100).optional(),
      only_schedulable: z.boolean().optional(),
    })
    .refine(hasInsurance, "Produto exige convênio"),
  specialties: z.strictObject({ insurance_id: id.optional(), place_id: id.optional() }),
  doctor_dates: z
    .strictObject({
      id,
      ...insuranceFilter,
      event_id: id,
      place_id: id.optional(),
      patient_id: id.optional(),
      date: date.optional(),
      gender: gender.optional(),
      born: date.optional(),
      allow_same_day: z.boolean().optional(),
      months_ahead: z.union([z.literal(3), z.literal(6)]).optional(),
    })
    .refine(hasInsurance, "Produto exige convênio"),
  // Exigência da integração além do schema externo: paciente explicitamente escolhido.
  attendance_create: z
    .strictObject({
      ...insuranceFilter,
      event_id: id,
      user_id: id,
      place_id: id,
      start_date: civilDateTime,
      patient_id: id,
      allow_same_day: z.boolean().optional(),
    })
    .refine(hasInsurance, "Produto exige convênio"),
  attendances: z
    .strictObject({
      place_id: id.optional(),
      start_date: date,
      end_date: date,
      status: z
        .enum(["ALL", "CANCELED", "ARRIVED", "CONFIRMED", "IN_ATTENDANCE", "DONE", "MISSED"])
        .optional(),
    })
    .refine(orderedDates, "Período invertido"),
  patient_attendances: z
    .strictObject({
      patient_id: id,
      place_id: id.optional(),
      start_date: date.optional(),
      end_date: date.optional(),
    })
    .refine(orderedDates, "Período invertido"),
  attendance_cancel: z.strictObject({ id }),
  attendance_status: z.strictObject({
    status: z.enum(["canceled", "arrived", "confirmed"]),
    patient_id: id,
    attendance_id: id,
  }),
  attendance_reschedule: z.strictObject({ id, date: dateTime }),
  places: z
    .strictObject({
      user_id: id.optional(),
      event_id: id.optional(),
      only_schedulable: z.boolean().optional(),
    })
    .refine(
      (value) => (value.user_id === undefined) === (value.event_id === undefined),
      "Médico e evento devem ser informados juntos",
    ),
  events: z.strictObject({
    insurance_id: id.optional(),
    place_id: id.optional(),
    user_id: id.optional(),
    only_schedulable: z.boolean().optional(),
  }),
  calendar: z
    .strictObject({ event_id: id, place_id: id, patient_id: id.optional(), ...insuranceFilter })
    .refine(hasInsurance, "Produto exige convênio"),
} satisfies Record<AmigoOperation, z.ZodType>;
export type AmigoInput<T extends AmigoOperation> = z.input<(typeof amigoInputSchemas)[T]>;

export function isAmigoMutation(operation: AmigoOperation): boolean {
  return (
    operation === "patient_create" ||
    operation === "patient_update" ||
    operation === "attendance_create" ||
    operation === "attendance_cancel" ||
    operation === "attendance_status" ||
    operation === "attendance_reschedule"
  );
}

// Respostas são extensíveis. Validamos campos conhecidos quando presentes e exigimos
// identificação mínima; não fabricamos defaults nem descartamos campos do fornecedor.
const string = z.string();
const nullableText = string.nullable().optional();
const named = z.looseObject({ id, name: string.optional() });
const reference = z.looseObject({
  insurance_id: id.optional(),
  place_id: id.optional(),
  event_id: id.optional(),
});
const patient = named.extend({
  age: z.number().int().nonnegative().nullable().optional(),
  cpf: nullableText,
  email: nullableText,
  contact_cellphone: nullableText,
  contact_cellphone_dial_code: nullableText,
  contact_cellphone_country_code: nullableText,
  health_insurance: z
    .looseObject({ id: id.nullable().optional(), name: nullableText })
    .nullable()
    .optional(),
  created_at: dateTime.optional(),
  last_attendance: reference.nullable().optional(),
});
const doctor = named.extend({
  specialty: nullableText,
  gender: nullableText,
  council_number: nullableText,
  council_name: nullableText,
  title: nullableText,
  last_attendance: reference.nullable().optional(),
  patient_insurance_id: id.nullable().optional(),
  config_arrival_order: z.boolean().optional(),
});
const place = named.extend({
  prefix: nullableText,
  address_address: nullableText,
  address_number: nullableText,
  address_district: nullableText,
  address_city: nullableText,
  address_state: nullableText,
  address_complement: nullableText,
  address: string.optional(),
});
const insuranceIds = z.union([
  z.array(id),
  string.refine((value) => {
    try {
      return z.array(id).safeParse(JSON.parse(value)).success;
    } catch {
      return false;
    }
  }),
]);
const event = named.extend({
  insurances: insuranceIds.optional(),
  preview_name: nullableText,
  matmeds: string.optional(),
  procedures: string.optional(),
  comeback_days: z.number().int().nullable().optional(),
  is_comeback: z.boolean().optional(),
  is_tele: z.boolean().optional(),
  duration: z.number().int().nonnegative().optional(),
  user_durations: nullableText,
});
const shift = z.enum(["MORNING", "AFTERNOON", "NIGHT"]);
const attendance = named.extend({
  type: string.optional(),
  start_date: dateTime.optional(),
  end_date: dateTime.optional(),
  patient_id: id.optional(),
  user_id: id.optional(),
  event_id: id.optional(),
  company_id: id.optional(),
  insurance_id: id.nullable().optional(),
  place_id: id.nullable().optional(),
  confirmed_at: dateTime.nullable().optional(),
  arrived: dateTime.nullable().optional(),
  canceled: z.boolean().optional(),
  missed: z.boolean().optional(),
  done: z.boolean().optional(),
  in_attendance: z.boolean().nullable().optional(),
  is_fit: z.boolean().optional(),
  is_arrival_order: z.boolean().optional(),
  preferential: z.boolean().optional(),
  user: doctor.optional(),
  patient: patient.optional(),
  place: place.optional(),
  agenda_event: named.optional(),
  event: event.optional(),
  status: z
    .enum(["scheduled", "confirmed", "arrived", "in_attendance", "done", "canceled", "missed"])
    .optional(),
  timegrids: z.array(z.looseObject({ start: hour, end: hour })).optional(),
  shift: shift.optional(),
  arrival_start_time: hour.optional(),
  arrival_end_time: hour.optional(),
  payment_method: string.optional(),
  startDateFormatted: string.optional(),
});
const doctorSlot = z.looseObject({
  id: string.min(1),
  start_date: dateTime,
  end_date: dateTime.optional(),
  user_id: id,
  hour: hour.optional(),
  interval: z.number().int().nonnegative().optional(),
  day_of_week: z.number().int().min(0).max(6).optional(),
  timegrid_id: id.nullable().optional(),
  place_id: id.nullable().optional(),
  formatted_start_date: civilDateTime.optional(),
  is_arrival_order: z.boolean().optional(),
  shift: shift.optional(),
});
const availableDay = string
  .regex(/^\d{2}\/\d{2}\/\d{4}$/)
  .refine(
    (value) =>
      date.safeParse(`${value.slice(6)}-${value.slice(3, 5)}-${value.slice(0, 2)}`).success,
  );
const calendarSlot = z.looseObject({
  id: string.min(1),
  start: hour,
  end: hour,
  timegrid_id: id.nullable().optional(),
  user_id: id.optional(),
  event_id: id.optional(),
  place_id: id.optional(),
  is_arrival_order: z.boolean().optional(),
  shift: shift.optional(),
});
const calendarDay = z.looseObject({
  date,
  status: string.optional(),
  slotsByUser: z.array(
    z.looseObject({
      user: doctor,
      event: z.looseObject({ id: id.optional(), name: string }).optional(),
      slots: z.array(calendarSlot),
      slots_total: z.number().int().nonnegative().optional(),
      is_arrival_order: z.boolean().optional(),
      shift: shift.optional(),
    }),
  ),
});
/** Schémas do campo data. O transporte devolve o JSON bruto validado, exceto search → array. */
export const amigoResponseSchemas = {
  patient_search: z.union([patient, z.array(patient)]),
  patient_get: patient,
  patient_create: patient,
  patient_update: patient,
  patient_doctors: z.array(doctor),
  patient_birthdays: z.array(patient),
  insurances: z.array(named),
  insurance_plans: z.array(named),
  insurance_products: z.array(named),
  doctors: z.array(doctor),
  doctors_available: z.array(doctor),
  specialties: z.array(string),
  doctor_dates: z.union([z.array(availableDay), z.array(doctorSlot)]),
  attendance_create: attendance,
  attendances: z.array(attendance),
  patient_attendances: z.array(attendance),
  attendance_cancel: z.literal(true),
  attendance_status: z.literal(true),
  attendance_reschedule: z.literal(true),
  places: z.array(place),
  events: z.array(event),
  calendar: z.array(calendarDay),
} satisfies Record<AmigoOperation, z.ZodType>;
