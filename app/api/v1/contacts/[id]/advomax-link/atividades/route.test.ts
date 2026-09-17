import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ audit: vi.fn(), supportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.supportWrite }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/env", () => ({ env: { ADVOMAX_API_URL: "https://gestao.example", ADVOMAX_CRM_INTEGRATION_KEY: "server-secret" } }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const request = (payload: unknown) => new NextRequest(`http://localhost/api/v1/contacts/${CONTACT}/advomax-link/atividades`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
});
const ctx = { params: Promise.resolve({ id: CONTACT }) };
const payload = { processo_codigo: 91, titulo: "Solicitar contrato", data_limite: "2026-09-20", chave_idempotencia: "crm-msg-12345678" };

function query(data: unknown) {
  const q = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data, error: null })) };
  q.select.mockReturnValue(q);
  q.eq.mockReturnValue(q);
  return q;
}

beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllGlobals();
  mocks.supportWrite.mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "user-1", email: "ana@example.com" }, org: { orgId: ORG } } as never);
});

describe("atividade jurídica no Advomax", () => {
  it("confere contato e vínculo na organização antes de enviar a atividade, sem devolver segredo", async () => {
    const contact = query({ id: CONTACT });
    const link = query({ pessoa_codigo: 42, status: "linked" });
    vi.mocked(createClient).mockResolvedValue({ from: vi.fn((table: string) => table === "contacts" ? contact : link) } as never);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ codigo: 77, idempotente: false, internal: "secret" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(payload), ctx);
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.data).toEqual({ codigo: 77, idempotente: false });
    expect(contact.eq).toHaveBeenCalledWith("organization_id", ORG);
    expect(link.eq).toHaveBeenCalledWith("organization_id", ORG);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe("https://gestao.example/integracoes/crm/pessoas/42/processos/91/atividades");
    expect(calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ "X-CRM-Idempotency-Key": payload.chave_idempotencia, "X-CRM-Organization-Id": ORG }),
    }));
  });

  it("não encaminha atividade sem Pessoa vinculada", async () => {
    vi.mocked(createClient).mockResolvedValue({ from: vi.fn((table: string) => query(table === "contacts" ? { id: CONTACT } : null)) } as never);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await POST(request(payload), ctx);
    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
