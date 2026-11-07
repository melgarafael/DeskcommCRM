import { describe, expect, it } from "vitest";
import {
  amigoInputSchemas,
  amigoOperations,
  isAmigoMutation,
  type AmigoOperation,
} from "./contracts";

const minimal: Record<AmigoOperation, unknown> = {
  patient_search: { cpf: "00000000000" },
  patient_get: { patientId: 1 },
  patient_create: { name: "Paciente Teste" },
  patient_update: { patientId: 1, name: "Paciente Teste" },
  patient_doctors: { patientId: 1 },
  patient_birthdays: { date: "02-29" },
  insurances: {},
  insurance_plans: { insurance_group_id: 1 },
  insurance_products: { insurance_id: 1 },
  doctors: {},
  doctors_available: { place_id: 1 },
  specialties: {},
  doctor_dates: { id: 1, event_id: 2 },
  attendance_create: {
    patient_id: 1,
    user_id: 2,
    place_id: 3,
    event_id: 4,
    start_date: "2026-11-06 08:30",
  },
  attendances: { start_date: "2026-11-01", end_date: "2026-11-30" },
  patient_attendances: { patient_id: 1 },
  attendance_cancel: { id: 1 },
  attendance_status: { status: "confirmed", patient_id: 1, attendance_id: 2 },
  attendance_reschedule: { id: 1, date: "2026-11-07 19:30" },
  places: {},
  events: {},
  calendar: { event_id: 1, place_id: 2 },
};

describe("contratos Amigo", () => {
  it("publica exatamente as 22 operações acordadas", () => {
    expect(amigoOperations).toEqual([
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
    ]);
    expect(Object.keys(amigoInputSchemas)).toEqual(amigoOperations);
  });
  it.each(Object.keys(minimal) as AmigoOperation[])(
    "%s aceita input mínimo e recusa campos arbitrários",
    (op) => {
      expect(amigoInputSchemas[op].safeParse(minimal[op]).success).toBe(true);
      expect(
        amigoInputSchemas[op].safeParse({
          ...(minimal[op] as object),
          url: "https://outro.invalid",
        }).success,
      ).toBe(false);
      expect(amigoInputSchemas[op].safeParse(null).success).toBe(false);
    },
  );
  it.each(Object.keys(minimal) as AmigoOperation[])(
    "%s classifica mutação explicitamente",
    (op) => {
      expect(isAmigoMutation(op)).toBe(
        [
          "patient_create",
          "patient_update",
          "attendance_create",
          "attendance_cancel",
          "attendance_status",
          "attendance_reschedule",
        ].includes(op),
      );
    },
  );
  it.each([
    ["patient_search", {}],
    ["patient_search", { cpf: "" }],
    ["patient_search", { contact_cellphone: " " }],
    ["patient_get", { patientId: "../places" }],
    ["patient_get", { patientId: 0 }],
    ["patient_get", { patientId: 1.5 }],
    ["patient_get", { patientId: Number.MAX_SAFE_INTEGER + 1 }],
    ["patient_create", { name: " " }],
    ["patient_create", { name: "Teste", born: "2000-01-01" }],
    ["patient_update", { patientId: 1 }],
    ["patient_create", { name: "Teste", civil_status: "a".repeat(26) }],
    ["patient_create", { name: "Teste", email: "ruim" }],
    ["places", { user_id: 1 }],
    ["places", { event_id: 1 }],
    ["doctors_available", { place_id: 1, insurance_product_id: 2 }],
    ["doctor_dates", { id: 1, event_id: 2, insurance_product_id: 3 }],
    ["calendar", { event_id: 1, place_id: 2, insurance_product_id: 3 }],
    ["attendance_create", { user_id: 1, event_id: 2, place_id: 3, start_date: "2026-11-06 08:30" }],
    ["attendance_create", { ...(minimal.attendance_create as object), insurance_product_id: 2 }],
    ["attendances", { start_date: "2026-11-07", end_date: "2026-11-06" }],
    ["patient_attendances", { patient_id: 1, start_date: "2026-11-07", end_date: "2026-11-06" }],
    ["doctor_dates", { id: 1, event_id: 2, date: "2026-02-29" }],
    ["doctor_dates", { id: 1, event_id: 2, born: "2026-13-01" }],
    ["doctor_dates", { id: 1, event_id: 2, months_ahead: 4 }],
    ["doctor_dates", { id: 1, event_id: 2, allow_same_day: "false" }],
    ["patient_birthdays", { date: "02-30" }],
    ["patient_birthdays", { date: "2026-11-06" }],
    ["attendance_status", { status: "done", patient_id: 1, attendance_id: 2 }],
    ["attendance_reschedule", { id: 1, date: "2026-02-30 19:30" }],
    ["attendance_reschedule", { id: 1, date: "2026-11-06 25:30" }],
    ["doctors_available", { place_id: 1, specialty: Array(101).fill("Cardiologia") }],
  ] as [AmigoOperation, unknown][])("recusa input inválido %s %j", (op, input) => {
    expect(amigoInputSchemas[op].safeParse(input).success).toBe(false);
  });
  it("preserva data civil, opções e filtros documentados", () => {
    const input = {
      id: 1,
      event_id: 2,
      date: "2024-02-29",
      born: "2000-02-29",
      allow_same_day: false,
      months_ahead: 6,
    };
    expect(amigoInputSchemas.doctor_dates.parse(input)).toEqual(input);
    expect(
      amigoInputSchemas.places.parse({ user_id: 1, event_id: 2, only_schedulable: false }),
    ).toEqual({ user_id: 1, event_id: 2, only_schedulable: false });
  });
});
