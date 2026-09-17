import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireRole = vi.fn();
const createClient = vi.fn();
vi.mock("@/lib/auth/require-role", () => ({ requireRole }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/env", () => ({ env: { ADVOMAX_API_URL: "https://gestao.example", ADVOMAX_CRM_INTEGRATION_KEY: "server-secret" } }));
vi.mock("@/lib/advomax/navigation", () => ({ advomaxAppUrl: (path: string) => `https://advomax.example${path}` }));

function query(data: unknown, error: { message: string } | null = null) {
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => ({ data, error }));
  return q;
}

describe("GET comunicação-contexto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireRole.mockResolvedValue({ ok: true, user: { email: "ana@example.com" }, org: { orgId: "org-1" } });
    createClient.mockResolvedValue({ from: vi.fn()
      .mockReturnValueOnce(query({ id: "contact-1" }))
      .mockReturnValueOnce(query({ pessoa_codigo: 42, status: "linked" })) });
  });

  it("devolve destino seguro sem transportar documentos de outros casos nem segredo", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ codigo: 7, pasta: "CRM-1" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("https://crm.example/api?processo_codigo=7"), { params: Promise.resolve({ id: "contact-1" }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.comunicacao.requer_confirmacao).toBe(true);
    expect(body.data.documentos).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/processos");
    expect(JSON.stringify(body)).not.toContain("server-secret");
  });
});
