import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/env", () => ({ env: {
  INTERNAL_SECRET: "local-secret", INTERNAL_CRON_SECRET: "",
  ADVOMAX_API_URL: "http://127.0.0.1:8080", ADVOMAX_CRM_INTEGRATION_KEY: "local-key",
} }));

const pending = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  pessoa_codigo: 42,
  created_by: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  created_by_email: "ana@example.com",
};

function request(secret = "local-secret") {
  return new NextRequest("http://127.0.0.1:3000/api/v1/cron/advomax-contact-links-reconcile", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

function setup(rows = [pending]) {
  const updated = vi.fn().mockResolvedValue({ data: pending, error: null });
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  let updating = false;
  query.select = vi.fn(() => { if (!updating) return query; return query; });
  query.eq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.limit = vi.fn(async () => ({ data: rows, error: null }));
  query.update = vi.fn(() => { updating = true; return query; });
  query.maybeSingle = vi.fn(async () => ({ data: updating ? await updated() : null, error: null }));
  const admin = { from: vi.fn(() => query) };
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  return { admin, query, updated };
}

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("reconciliação de vínculos Advomax", () => {
  it("recusa chamada sem bearer antes de tocar no banco", async () => {
    expect((await POST(request("errado"))).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("confirma a Pessoa com a identidade original e atualiza somente pending", async () => {
    const s = setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ codigo: 42 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/pessoas/42/resumo"), expect.objectContaining({
      headers: expect.objectContaining({ "X-CRM-User-Email": "ana@example.com", "X-CRM-Organization-Id": pending.organization_id }),
    }));
    expect(s.query.update).toHaveBeenCalledWith(expect.objectContaining({ status: "linked" }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contact.advomax_link_reconciled" }));
  });

  it("mantém pending quando o recibo não confirma a mesma Pessoa", async () => {
    const s = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ codigo: 7 }), { status: 200 })));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(s.query.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
