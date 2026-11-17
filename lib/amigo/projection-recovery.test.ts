import { expect, it } from "vitest";
import { projectAttendance, normalizeAttendance } from "./projection";
const old = {
  id: 91,
  patient_id: 4,
  event_id: 7,
  start_date: "2026-11-07 14:00",
  end_date: "2026-11-07 14:30",
  status: "scheduled",
};
it("segunda sincronização repara falha local mesmo com o mesmo estado externo", async () => {
  let link: Record<string, unknown> = {
    id: "link",
    appointment_id: "appointment",
    remote_data: normalizeAttendance(old, "America/Fortaleza"),
    remote_status: "scheduled",
  };
  let attempts = 0;
  const db = {
    from: (table: string) => {
      let patch: Record<string, unknown> | undefined;
      const result = () => {
        if (table === "amigo_appointment_links") {
          if (patch) link = { ...link, ...patch };
          return { data: link, error: null };
        }
        if (table === "amigo_patient_links")
          return { data: { contact_id: "contact", lead_id: null }, error: null };
        if (table === "calendar_event_types") return { data: { id: "event" }, error: null };
        if (table === "calendar_appointments") {
          if (!patch) return { data: { revision: 2 }, error: null };
          attempts++;
          return { data: null, error: attempts === 1 ? { message: "temporary" } : null };
        }
        return { data: null, error: null };
      };
      const q = {
        select: () => q,
        eq: () => q,
        upsert: (value: Record<string, unknown>) => {
          patch = value;
          return q;
        },
        update: (value: Record<string, unknown>) => {
          patch = value;
          return q;
        },
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (v: unknown) => unknown) => resolve(result()),
      };
      return q;
    },
  };
  const current = { ...old, status: "canceled" };
  const conn = { id: "conn", organizationId: "org", timezone: "America/Fortaleza" };
  await expect(
    projectAttendance(db as never, conn, current, { bootstrap: true }),
  ).rejects.toThrow();
  await expect(
    projectAttendance(db as never, conn, current, { bootstrap: true }),
  ).resolves.toMatchObject({ appointmentId: "appointment" });
  expect(attempts).toBe(2);
});

it("falha no CRM é reparada sem duplicar a atividade e cada nova revisão conserva seu evento", async () => {
  const actor = { type: "api_token" as const, id: "sync", role: "manager" };
  let link: Record<string, unknown> = {
    id: "link",
    appointment_id: "appointment",
    remote_data: normalizeAttendance(old, "America/Fortaleza"),
    remote_status: "scheduled",
  };
  let local = { revision: 1, status: "confirmed", starts_at: "2026-11-07T17:00:00.000Z" };
  const activities = new Set<string>();
  let failActivity = true;
  const db = {
    from: (table: string) => {
      let patch: Record<string, unknown> | undefined;
      const result = () => {
        if (table === "amigo_appointment_links") {
          if (patch) link = { ...link, ...patch };
          return { data: link, error: null };
        }
        if (table === "amigo_patient_links")
          return { data: { contact_id: "contact", lead_id: "lead" }, error: null };
        if (table === "calendar_event_types") return { data: { id: "event" }, error: null };
        if (table === "calendar_appointments") {
          if (patch) {
            const changed = patch.status !== local.status || patch.starts_at !== local.starts_at;
            local = { ...local, ...patch, revision: local.revision + (changed ? 1 : 0) };
          }
          return { data: local, error: null };
        }
        if (table === "crm_lead_activities") {
          if (failActivity) return { data: null, error: { message: "offline" } };
          activities.add(String(patch?.id));
        }
        return { data: null, error: null };
      };
      const q = {
        select: () => q,
        eq: () => q,
        upsert: (p: Record<string, unknown>) => {
          patch = p;
          return q;
        },
        update: (p: Record<string, unknown>) => {
          patch = p;
          return q;
        },
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (v: unknown) => unknown) => resolve(result()),
      };
      return q;
    },
  };
  const conn = { id: "conn", organizationId: "org", timezone: "America/Fortaleza" };
  // A closed transition never needs stage queries; it still writes the timeline.
  const current = { ...old, status: "canceled" };
  await expect(projectAttendance(db as never, conn, current, { actor })).rejects.toThrow(
    "Atividade",
  );
  failActivity = false;
  await projectAttendance(db as never, conn, current, { actor });
  await projectAttendance(db as never, conn, current, { actor });
  expect(activities.size).toBe(1);
  await projectAttendance(db as never, conn, { ...current, status: "done" }, { actor });
  await projectAttendance(db as never, conn, current, { actor });
  expect(activities.size).toBe(3);
});
