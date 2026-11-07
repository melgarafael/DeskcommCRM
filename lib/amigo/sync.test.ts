import { describe, expect, it } from "vitest";
import { syncWindows, matchReconciliation, reminderMatches } from "./sync";
const attendance = {
  id: 91,
  patient_id: 4,
  event_id: 7,
  user_id: 2,
  place_id: 3,
  start_date: "2026-11-07 14:00",
  end_date: "2026-11-07 14:30",
  status: "scheduled",
};
describe("sincronização e reconciliação Amigo", () => {
  it("limita a janela -7/+90 em lotes de sete dias sem lacunas", () => {
    const windows = syncWindows(new Date("2026-11-06T15:00:00Z"), "America/Fortaleza");
    expect(windows).toHaveLength(14);
    expect(windows[0]).toEqual({ start_date: "2026-10-30", end_date: "2026-11-05" });
    expect(windows.at(-1)?.end_date).toBe("2027-02-04");
  });
  it("recupera criação incerta somente com uma correspondência exata", () => {
    const op = {
      operation: "attendance_create",
      request_context: {
        patient_id: 4,
        event_id: 7,
        user_id: 2,
        place_id: 3,
        start_date: "2026-11-07 14:00",
      },
    };
    expect(matchReconciliation(op, [attendance], "America/Fortaleza")).toEqual({
      data: attendance,
      status: "success",
    });
    expect(
      matchReconciliation(op, [attendance, { ...attendance, id: 92 }], "America/Fortaleza"),
    ).toBeNull();
    expect(
      matchReconciliation(op, [{ ...attendance, place_id: 8 }], "America/Fortaleza"),
    ).toBeNull();
    expect(matchReconciliation(op, [], "America/Fortaleza")).toBeNull();
  });
  it("não libera chegada ou cancelamento com estado apenas agendado", () => {
    const op = { operation: "attendance_cancel", request_context: { id: 91 } };
    expect(matchReconciliation(op, [attendance], "America/Fortaleza")).toBeNull();
    expect(
      matchReconciliation(op, [{ ...attendance, status: "canceled" }], "America/Fortaleza"),
    ).toEqual({ data: true, status: "success" });
  });
  it("lembrete exige vínculo, estado remoto elegível e data atual", () => {
    const local = { starts_at: "2026-11-07T17:00:00.000Z", contact_id: "responsavel" };
    expect(reminderMatches(local, attendance, "America/Fortaleza", "responsavel")).toBe(true);
    expect(
      reminderMatches(
        local,
        { ...attendance, status: "canceled" },
        "America/Fortaleza",
        "responsavel",
      ),
    ).toBe(false);
    expect(
      reminderMatches(
        local,
        { ...attendance, start_date: "2026-11-07 15:00" },
        "America/Fortaleza",
        "responsavel",
      ),
    ).toBe(false);
    expect(reminderMatches(local, attendance, "America/Fortaleza", "outro")).toBe(false);
  });
});
