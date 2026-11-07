import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TransportModule from "./transport";
import type * as ProjectionModule from "./projection";
const g = vi.hoisted(() => ({ load: vi.fn(), request: vi.fn(), project: vi.fn(), db: vi.fn() }));
vi.mock("./store", () => ({ loadAmigoConnection: g.load }));
vi.mock("./transport", async (original) => ({
  ...(await original<typeof TransportModule>()),
  requestAmigo: g.request,
}));
vi.mock("./projection", async (original) => ({
  ...(await original<typeof ProjectionModule>()),
  projectAttendance: g.project,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: g.db }));
import { syncAmigo, verifyAmigoReminder } from "./sync";
import { AmigoError } from "./transport";
let patches: Array<{ table: string; patch: Record<string, unknown> }>;
let responses: Record<string, unknown>;
function db() {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "lt", "order", "limit"]) q[method] = () => q;
      q.update = (patch: Record<string, unknown>) => {
        patches.push({ table, patch });
        return q;
      };
      q.maybeSingle = async () => ({ data: responses[table] ?? null, error: null });
      q.then = (resolve: (value: unknown) => unknown) =>
        resolve({
          data: table === "amigo_operations" ? [] : (responses[table] ?? null),
          error: null,
        });
      return q;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  patches = [];
  responses = {
    organizations: { status: "active" },
    amigo_appointment_links: { attendance_id: 91, patient_id: 4 },
    amigo_patient_links: { contact_id: "contact" },
  };
  g.db.mockImplementation(db);
  g.load.mockResolvedValue({
    id: "conn",
    active: true,
    token: "secret-fixture",
    timezone: "America/Fortaleza",
    last_sync_at: null,
    reminders_enabled: false,
  });
  g.request.mockResolvedValue({ data: [], status: "success" });
});
describe("ciclo de atualização e lembretes Amigo", () => {
  it("sincroniza somente por leituras e bootstrap sem efeitos retroativos", async () => {
    const row = { id: 91, patient_id: 4 };
    g.request.mockResolvedValueOnce({ data: [row], status: "success" });
    const result = await syncAmigo("org", "request");
    expect(result).toMatchObject({ examined: 1, reconciled: 0 });
    expect(g.request).toHaveBeenCalledTimes(14);
    expect(g.request.mock.calls.every((call) => call[1] === "attendances")).toBe(true);
    expect(g.project).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org" }),
      row,
      expect.objectContaining({ bootstrap: true }),
    );
    expect(patches.at(-1)?.patch).toMatchObject({ last_error: null });
  });
  it("token recusado pausa e registra falha visível sem nova tentativa", async () => {
    g.request.mockRejectedValue(new AmigoError("AMIGO_UNAUTHORIZED", 401));
    await expect(syncAmigo("org", "r")).rejects.toMatchObject({ code: "amigo_sync_failed" });
    expect(g.request).toHaveBeenCalledTimes(1);
    expect(patches).toContainEqual({
      table: "amigo_connections",
      patch: { last_error: "sync_failed" },
    });
  });
  it("org parada não consulta a agenda externa", async () => {
    responses.organizations = { status: "suspended" };
    await expect(syncAmigo("org", "r")).rejects.toMatchObject({ status: 403 });
    expect(g.request).not.toHaveBeenCalled();
  });
  it("opção de lembrete desligada bloqueia envio antes de consultar Amigo", async () => {
    expect(
      await verifyAmigoReminder(db() as never, {
        id: "a",
        organization_id: "org",
        contact_id: "contact",
        starts_at: "2026-11-07T17:00:00Z",
        authority: "amigo",
        external_connection_id: "conn",
      }),
    ).toBe(false);
    expect(g.request).not.toHaveBeenCalled();
  });
  it("consulta cancelada externamente impede lembrete e atualiza projeção", async () => {
    g.load.mockResolvedValue({
      id: "conn",
      active: true,
      token: "secret-fixture",
      timezone: "America/Fortaleza",
      reminders_enabled: true,
    });
    const row = {
      id: 91,
      patient_id: 4,
      event_id: 7,
      start_date: "2026-11-07 14:00",
      end_date: "2026-11-07 14:30",
      status: "canceled",
    };
    g.request.mockResolvedValue({ data: [row], status: "success" });
    expect(
      await verifyAmigoReminder(db() as never, {
        id: "a",
        organization_id: "org",
        contact_id: "contact",
        starts_at: "2026-11-07T17:00:00Z",
        authority: "amigo",
        external_connection_id: "conn",
      }),
    ).toBe(false);
    expect(g.project).toHaveBeenCalledWith(expect.anything(), expect.anything(), row, {
      actor: expect.objectContaining({ type: "api_token" }),
    });
  });
});
