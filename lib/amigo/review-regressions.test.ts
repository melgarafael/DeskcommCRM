import type * as ProjectionModule from "./projection";
import type * as OperationsModule from "./operations";
import { beforeEach, describe, expect, it, vi } from "vitest";
const g = vi.hoisted(() => ({
  load: vi.fn(),
  request: vi.fn(),
  project: vi.fn(),
  receipt: vi.fn(),
  db: vi.fn(),
}));
vi.mock("./store", () => ({ loadAmigoConnection: g.load }));
vi.mock("./transport", () => ({ requestAmigo: g.request }));
vi.mock("./projection", async (original) => ({
  ...(await original<typeof ProjectionModule>()),
  projectAttendance: g.project,
}));
vi.mock("./operations", async (original) => ({
  ...(await original<typeof OperationsModule>()),
  runDurableOperation: g.receipt,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: g.db }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { executeAmigo } from "./service";
const ctx = {
  organizationId: "org",
  actor: { type: "user" as const, id: "user", role: "manager" },
  role: "manager",
  requestId: "r",
  expectedConnectionId: "old",
};
const row = {
  id: 90,
  patient_id: 4,
  event_id: 7,
  start_date: "2026-11-07 14:00",
  end_date: "2026-11-07 14:30",
  status: "canceled",
};
beforeEach(() => {
  vi.clearAllMocks();
  g.db.mockReturnValue({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return q;
    },
  });
  g.load.mockResolvedValue({
    id: "old",
    active: true,
    token: "fake-token",
    timezone: "America/Fortaleza",
    last_sync_at: "2026-11-06T00:00:00Z",
  });
  g.project.mockResolvedValue({ appointmentId: "projection" });
  g.receipt.mockResolvedValue({
    id: "receipt",
    state: "confirmed",
    result: { data: { ...row, status: "scheduled" } },
  });
});
describe("sequências da revisão Amigo", () => {
  it("IDs de formulário antigo são recusados após a troca de conta", async () => {
    g.load.mockResolvedValue({ id: "new", active: true, token: "new-token" });
    await expect(executeAmigo(ctx, "events", { place_id: 1 })).rejects.toMatchObject({
      status: 409,
      code: "amigo_connection_changed",
    });
    expect(g.request).not.toHaveBeenCalled();
  });
  it("replay de criação relê estado atual e não ressuscita consulta cancelada", async () => {
    g.request.mockResolvedValue({ data: [row], status: "success" });
    const result = await executeAmigo(
      ctx,
      "attendance_create",
      { patient_id: 4, event_id: 7, user_id: 8, place_id: 1, start_date: "2026-11-07 14:00" },
      "original-key",
    );
    expect(g.request).toHaveBeenCalledWith("fake-token", "patient_attendances", { patient_id: 4 });
    expect(g.project).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      row,
      expect.anything(),
    );
    expect(result).toMatchObject({ state: "superseded", uncertain: true });
  });
  it("leitura posterior ao bootstrap leva autoria para o CRM", async () => {
    g.request.mockResolvedValue({ data: [row], status: "success" });
    await executeAmigo(ctx, "attendances", { start_date: "2026-11-07", end_date: "2026-11-07" });
    expect(g.project).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      row,
      expect.objectContaining({ actor: ctx.actor, bootstrap: false }),
    );
  });
});
