import { expect, it } from "vitest";
import { scheduleSchema, formatClassEnd } from "@/lib/academia/schedule";
const id = "a2350000-0000-4000-8000-000000000001";
const values = { modality_id: id, audience_id: id, teacher_id: id, space_id: id, weekday: 1, start_time: "08:30", duration_minutes: 45 };
it("valida uma referência semanal sem presumir idades ou duração", () => {
  expect(scheduleSchema.parse(values).start_time).toBe("08:30");
  expect(scheduleSchema.safeParse({ ...values, duration_minutes: undefined }).success).toBe(false);
  expect(scheduleSchema.safeParse({ ...values, organization_id: id }).success).toBe(false);
});
it.each(["24:00", "8:30", "08:60", "08:30:00"])("rejeita horário %s", start_time => {
  expect(scheduleSchema.safeParse({ ...values, start_time }).success).toBe(false);
});
it("calcula término com virada de dia sem depender do fuso da máquina", () => {
  expect(formatClassEnd("08:30", 45)).toBe("09:15");
  expect(formatClassEnd("23:30", 90)).toBe("01:00 (+1 dia)");
  expect(formatClassEnd("00:00", 1440)).toBe("00:00 (+1 dia)");
});
