import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { GET } from "./route";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

function request(key = "segredo") {
  return new NextRequest("http://localhost/api/v1/integrations/advomax/carteira?limit=20", { headers: {
    "X-CRM-Integration-Key": key,
    "X-CRM-Organization-Id": "11111111-1111-4111-8111-111111111111",
    "X-Advomax-Empresa-Codigo": "7",
  } });
}

describe("GET carteira Advomax", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADVOMAX_CRM_INTEGRATION_KEY = "segredo";
  });

  it("recusa segredo inválido antes de consultar o banco", async () => {
    const response = await GET(request("errado"));
    expect(response.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("recusa empresa que não corresponde à organização", async () => {
    const query = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => query } as never);
    const response = await GET(request());
    expect(response.status).toBe(403);
  });

  it("mantém consultas da carteira e dos clientes no escopo da organização", async () => {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const resultByTable: Record<string, unknown[]> = {
      organizations: [{ id: "11111111-1111-4111-8111-111111111111" }],
      crm_pipelines: [{ id: "p1", name: "Comercial", slug: "comercial", position: 0, is_default: true, updated_at: "2026-09-17T00:00:00Z" }],
      crm_stages: [{ id: "s1", pipeline_id: "p1", name: "Triagem", slug: "triagem", position: 0, color: null, is_won: false, is_lost: false, updated_at: "2026-09-17T00:00:00Z" }],
      crm_leads: [{ id: "l1", title: "Inventário", status: "open", pipeline_id: "p1", stage_id: "s1", contact_id: "c1", value_cents: 10000, currency: "BRL", expected_close_date: null, last_activity_at: null, created_at: "2026-09-17T00:00:00Z", updated_at: "2026-09-17T00:00:00Z" }],
      contacts: [{ id: "c1", name: "Ana", display_name: null, email: "ana@example.com", phone_number: "5511999999999", source_metadata: { secret: true } }],
      advomax_contact_links: [{ contact_id: "c1", pessoa_codigo: 42 }],
    };
    function from(table: string) {
      const call = { table, filters: [] as Array<[string, unknown]> };
      calls.push(call);
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const method of ["select", "order", "limit", "range", "in", "gte"]) chain[method] = () => chain;
      chain.eq = (column, value) => { call.filters.push([String(column), value]); return chain; };
      chain.maybeSingle = async () => ({ data: resultByTable[table]?.[0] ?? null, error: null });
      chain.then = (resolve) => Promise.resolve({ data: resultByTable[table] ?? [], error: null }).then(resolve as never);
      return chain;
    }
    vi.mocked(createAdminClient).mockReturnValue({ from } as never);

    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body.data.opportunities[0].contact).toEqual({ id: "c1", name: "Ana", email: "ana@example.com", phone: "5511999999999", pessoa_codigo: 42 });
    expect(JSON.stringify(body)).not.toContain("source_metadata");
    expect(calls.find((call) => call.table === "organizations")?.filters).toContainEqual(["id", "11111111-1111-4111-8111-111111111111"]);
    for (const call of calls.filter((call) => call.table !== "organizations")) {
      expect(call.filters).toContainEqual(["organization_id", "11111111-1111-4111-8111-111111111111"]);
    }
  });
});
