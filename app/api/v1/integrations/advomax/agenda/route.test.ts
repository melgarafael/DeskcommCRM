import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET } from "./route";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

describe("GET agenda Advomax", () => {
  beforeEach(() => { process.env.ADVOMAX_CRM_INTEGRATION_KEY = "segredo"; vi.clearAllMocks(); });
  const request = (key = "segredo", ate = "2026-10-01T00:00:00.000Z") => new NextRequest(
    `http://localhost/api/v1/integrations/advomax/agenda?de=2026-09-01T00:00:00.000Z&ate=${encodeURIComponent(ate)}`,
    { headers: { "X-CRM-Integration-Key": key, "X-CRM-Organization-Id": "11111111-1111-4111-8111-111111111111", "X-Advomax-Empresa-Codigo": "7" } },
  );

  it("recusa segredo inválido antes do banco", async () => {
    expect((await GET(request("errado"))).status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("recusa janela maior que um ano", async () => {
    expect((await GET(request("segredo", "2028-10-01T00:00:00.000Z"))).status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("pagina no escopo da organização e não expõe ids internos", async () => {
    const orgId = "11111111-1111-4111-8111-111111111111";
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const appointments = Array.from({ length: 101 }, (_, index) => ({
      id: `a${index}`, title: `Compromisso ${index}`,
      starts_at: "2026-09-17T14:00:00.000Z", ends_at: "2026-09-17T15:00:00.000Z",
      time_zone: "America/Sao_Paulo", status: "confirmed", owner_user_id: "u1", contact_id: "c1",
      location_kind: null, location_details: null, revision: 1, updated_at: "2026-09-17T12:00:00.000Z",
    }));
    const dataByTable: Record<string, unknown[]> = {
      organizations: [{ id: orgId }], calendar_appointments: appointments,
      advomax_contact_links: [{ contact_id: "c1", pessoa_codigo: 42 }],
    };
    function from(table: string) {
      const call = { table, filters: [] as Array<[string, unknown]> };
      calls.push(call);
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const method of ["select", "lt", "gt", "order", "range", "in"]) chain[method] = () => chain;
      chain.eq = (column, value) => { call.filters.push([String(column), value]); return chain; };
      chain.maybeSingle = async () => ({ data: dataByTable[table]?.[0] ?? null, error: null });
      chain.then = (resolve) => Promise.resolve({ data: dataByTable[table] ?? [], error: null }).then(resolve as never);
      return chain;
    }
    vi.mocked(createAdminClient).mockReturnValue({
      from,
      auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: { app_metadata: { advomax_user_codigo: 9 } } } })) } },
    } as never);

    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body.data.appointments).toHaveLength(100);
    expect(body.data.has_more).toBe(true);
    expect(body.data.next_offset).toBe(100);
    expect(body.data.appointments[0]).toMatchObject({ pessoa_codigo: 42, usuario_codigo: 9 });
    expect(JSON.stringify(body)).not.toMatch(/owner_user_id|contact_id/);
    for (const call of calls.filter((item) => item.table !== "organizations")) {
      expect(call.filters).toContainEqual(["organization_id", orgId]);
    }
  });
});
