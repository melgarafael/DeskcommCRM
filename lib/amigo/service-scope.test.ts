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
  actor: { type: "ai_agent" as const, id: "run", role: "admin" },
  role: "admin",
  requestId: "request",
  expectedConnectionId: "connection",
  contactId: "contact",
};
let tables: Record<string, Record<string, unknown>[]>;
function db() {
  return {
    from: (table: string) => {
      let rows = tables[table] ?? [];
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          rows = rows.filter((r) => r[key] === value);
          return q;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      };
      return q;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  tables = {
    contacts: [
      {
        id: "contact",
        organization_id: "org",
        phone_number: "5585999991234",
        is_anonymized: false,
      },
    ],
    amigo_patient_links: [
      {
        organization_id: "org",
        connection_id: "connection",
        patient_id: 12,
        contact_id: "contact",
      },
    ],
    amigo_appointment_links: [
      { organization_id: "org", connection_id: "connection", attendance_id: 71, patient_id: 12 },
    ],
  };
  g.db.mockImplementation(db);
  g.load.mockResolvedValue({
    id: "connection",
    token: "private-token",
    active: true,
    timezone: "America/Fortaleza",
    last_sync_at: "2026-11-06T00:00:00Z",
  });
  g.request.mockResolvedValue({ data: [{ id: 12 }, { id: 13 }], status: "success" });
});
describe("escopo do domínio e resultado remoto", () => {
  it("contato de outra clínica é recusado antes de buscar credencial", async () => {
    tables.contacts![0]!.organization_id = "other";
    await expect(executeAmigo(ctx, "patient_search", { cpf: "123" })).rejects.toMatchObject({
      status: 403,
    });
    expect(g.load).not.toHaveBeenCalled();
    expect(g.request).not.toHaveBeenCalled();
  });
  it("paciente sem vínculo explícito não pode ser consultado", async () => {
    await expect(executeAmigo(ctx, "patient_get", { patientId: 13 })).rejects.toMatchObject({
      status: 403,
    });
    expect(g.request).not.toHaveBeenCalled();
  });
  it("busca contextual usa telefone verificado e devolve todos os candidatos sem escolher", async () => {
    const result = await executeAmigo(ctx, "patient_search", {
      cpf: "cpf-alheio",
      contact_cellphone: "outro",
    });
    expect(g.request).toHaveBeenCalledWith("private-token", "patient_search", {
      contact_cellphone: "85999991234",
    });
    expect(result.data).toHaveLength(2);
    expect(g.project).not.toHaveBeenCalled();
  });
  it("falha local após sucesso remoto não permite confirmação ao cliente", async () => {
    g.receipt.mockResolvedValue({
      id: "op",
      state: "confirmed",
      result: { data: { id: 90 }, status: "success" },
    });
    g.project.mockRejectedValue(new Error("DB offline"));
    const result = await executeAmigo(
      ctx,
      "attendance_create",
      { patient_id: 12, event_id: 3, user_id: 4, place_id: 5, start_date: "2026-11-07 14:00" },
      "stable-key",
    );
    expect(result).toMatchObject({
      state: "projection_pending",
      uncertain: true,
      operation_id: "op",
    });
    expect(result.local_appointment_id).toBeUndefined();
  });
  it("alteração histórica consulta a conexão original mesmo inativa", async () => {
    g.load.mockResolvedValue({
      id: "connection",
      token: "private-token",
      active: false,
      timezone: "America/Fortaleza",
    });
    g.receipt.mockResolvedValue({ id: "op", state: "rejected", result: {} });
    await executeAmigo(
      { ...ctx, connectionId: "connection" },
      "attendance_cancel",
      { id: 71 },
      "key",
    );
    expect(g.load).toHaveBeenCalledWith("org", "connection");
    expect(g.receipt).toHaveBeenCalled();
  });
});
