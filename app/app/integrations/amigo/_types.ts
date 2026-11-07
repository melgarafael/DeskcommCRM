import type { z } from "zod";
import type { amigoResponseSchemas } from "@/lib/amigo/contracts";
export type { AmigoSafeConfig } from "@/lib/amigo/store";
export type { AmigoOperation } from "@/lib/amigo/contracts";
export type Named = { id: number; name?: string };
export type Patient = z.infer<typeof amigoResponseSchemas.patient_get>;
export type Attendance = z.infer<typeof amigoResponseSchemas.attendances>[number];
export type DoctorSlot = Exclude<z.infer<typeof amigoResponseSchemas.doctor_dates>[number], string>;
export type CalendarDay = z.infer<typeof amigoResponseSchemas.calendar>[number];
export type Receipt = {
  data: unknown;
  operation_id?: string;
  local_appointment_id?: string;
  uncertain?: boolean;
  state?: string;
};
export type Tab = "config" | "agenda" | "pacientes" | "catalogos";
