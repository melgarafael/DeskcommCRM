import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileAppointment } from "@/lib/agenda/google/sync-executor";
vi.mock("@/lib/agenda/google/membros", () => ({
  apenasDeMembrosAtivos: vi.fn(async (_db, rows) => rows),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agenda/google/sync-executor", () => ({ reconcileAppointment: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "cron", INTERNAL_SECRET: null } }));
import { apenasDeMembrosAtivos } from "@/lib/agenda/google/membros";
import { GET } from "@/app/api/v1/cron/agenda-google-push/route";
const org = "aaaaaaaa-0000-4000-8000-00000000000a";
let rows: Array<{ id: string; organization_id: string }>;
let filters: string[];
beforeEach(() => {
  vi.clearAllMocks();
  rows = [{ id: "appointment", organization_id: org }];
  filters = [];
  const chain: Record<string, unknown> = {
    select: () => chain,
    or: (v: string) => {
      filters.push(v);
      return chain;
    },
    lte: () => chain,
    not: () => chain,
    order: () => chain,
    limit: async () => ({ data: rows, error: null }),
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);
  vi.mocked(reconcileAppointment).mockResolvedValue("processed");
});
const request = (authorized = true) =>
  new NextRequest("http://localhost/api/v1/cron/agenda-google-push", {
    headers: authorized ? { authorization: "Bearer cron" } : {},
  });
describe("push usa o executor comum por compromisso", () => {
  it("publica por organização/id pelo claim comum, sem selecionar conexão incidental", async () => {
    expect((await GET(request())).status).toBe(200);
    expect(reconcileAppointment).toHaveBeenCalledWith(expect.anything(), org, "appointment");
    expect(filters[0]).toContain("needs_google_push.eq.true");
  });
  it("sem conexão/claim disponível não marca sucesso nem audita entrega", async () => {
    vi.mocked(reconcileAppointment).mockResolvedValue("busy");
    await GET(request());
    expect(audit).not.toHaveBeenCalled();
  });
  it("cancelamento segue mesma identidade e protocolo do executor", async () => {
    rows = [{ id: "cancelled", organization_id: org }];
    await GET(request());
    expect(reconcileAppointment).toHaveBeenCalledWith(expect.anything(), org, "cancelled");
  });
  it("erro do executor é contado com org correta sem fingir sucesso", async () => {
    vi.mocked(reconcileAppointment).mockResolvedValue("failed");
    await GET(request());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org,
        metadata: expect.objectContaining({ falhas: 1, processados: 0 }),
      }),
    );
  });
  it("ex-membro recusado pelo executor não impede outras organizações e não mistura audit", async () => {
    rows.push({ id: "other", organization_id: "another-org" });
    vi.mocked(reconcileAppointment)
      .mockRejectedValueOnce(new Error("google_owner_unavailable"))
      .mockResolvedValueOnce("processed");
    await GET(request());
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "another-org",
        metadata: expect.objectContaining({ processados: 1, falhas: 0 }),
      }),
    );
  });
  it("sem segredo é401 antes de DB/efeito", async () => {
    expect((await GET(request(false))).status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(reconcileAppointment).not.toHaveBeenCalled();
  });
  it("rodada vazia ou observação sem mudança não audita", async () => {
    rows = [];
    await GET(request());
    expect(audit).not.toHaveBeenCalled();
    rows = [{ id: "same", organization_id: org }];
    vi.mocked(reconcileAppointment).mockResolvedValue("unchanged");
    await GET(request());
    expect(audit).not.toHaveBeenCalled();
  });
});

it("ex-membro é excluído antes de entregar o compromisso ao executor/token", async () => {
  vi.mocked(apenasDeMembrosAtivos).mockResolvedValueOnce([]);
  await GET(request());
  expect(reconcileAppointment).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
});

it("titular redigido durante seleção é terminal sem auditar inação repetida", async () => {
  vi.mocked(reconcileAppointment).mockResolvedValue("terminal");
  await GET(request());
  await GET(request());
  expect(reconcileAppointment).toHaveBeenCalledTimes(2);
  expect(audit).not.toHaveBeenCalled();
});
