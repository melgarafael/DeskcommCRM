import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  autoriza: vi.fn(() => true),
  audit: vi.fn(),
  iniciar: vi.fn(),
}));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: m.autoriza }));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/nuvemshop/sync/deps", () => ({ depsReais: () => ({}) }));
vi.mock("@/lib/nuvemshop/sync/iniciar", () => ({ iniciarSincronizacao: m.iniciar }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const rows =
        tabela === "tenant_integrations"
          ? [
              { organization_id: "a", organizations: { status: "active" } },
              { organization_id: "b", organizations: { status: "active" } },
            ]
          : [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.in = async () => ({ data: rows, error: null });
      (q as { then: unknown }).then = (res: (v: unknown) => void) => res({ data: rows, error: null });
      return q;
    },
  }),
}));

const req = () => new NextRequest("http://localhost/api/v1/cron/nuvemshop-reconcile");

describe("GET nuvemshop-reconcile", () => {
  beforeEach(() => {
    m.autoriza.mockReturnValue(true);
    m.audit.mockReset();
    m.iniciar.mockReset();
  });

  it("sem secret → 403", async () => {
    m.autoriza.mockReturnValue(false);
    const { GET } = await import("./route");
    expect((await GET(req())).status).toBe(403);
    expect(m.iniciar).not.toHaveBeenCalled();
  });

  it("início ok:false não audita; ok audita exatamente uma vez", async () => {
    m.iniciar
      .mockResolvedValueOnce({ ok: false, motivo: "sync_em_andamento" })
      .mockResolvedValueOnce({ ok: true, runId: "r2" });
    const { GET } = await import("./route");
    const body = await (await GET(req())).json();
    expect(body.data).toEqual({ candidatos: 2, iniciados: 1, falhas: 0 });
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "nuvemshop.sync_requested", organizationId: "b" }));
  });

  it("exceção na 1ª org não impede a 2ª", async () => {
    m.iniciar.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ok: true, runId: "r2" });
    const { GET } = await import("./route");
    const body = await (await GET(req())).json();
    expect(body.data).toEqual({ candidatos: 2, iniciados: 1, falhas: 1 });
    expect(m.audit).toHaveBeenCalledTimes(1);
  });
});
