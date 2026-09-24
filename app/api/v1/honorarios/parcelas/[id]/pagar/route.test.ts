/**
 * POST /api/v1/honorarios/parcelas/[id]/pagar — DIRC "integrar": cria um `financial_entries`
 * do caixa núcleo e liga por `financial_entry_id`, nunca uma tabela de "pagamento" própria.
 *
 * Tudo passa por `fn_honorarios_parcela_pagar` (migration 0398, RPC) — uma função com
 * `for update`, não três chamadas separadas do PostgREST. É essa função que garante que
 * pagar a mesma parcela duas vezes (dois cliques, um retry) nunca lança duas vezes no caixa;
 * aqui o fake só prova que a ROTA lê a resposta da RPC certo, incluindo o "já paga" que vem
 * de quem perde a corrida dentro da função.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PARCELA_ID = "66666666-6666-4666-8666-666666666666";
const ACCOUNT_ID = "77777777-7777-4777-8777-777777777777";
const params = { params: Promise.resolve({ id: PARCELA_ID }) };

function autorizadoComoManager(): void {
  const user = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  } as AuthUser;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  } as never);
}

function negado(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: fail("forbidden_role", "Papel insuficiente.", 403, {}),
  } as never);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/honorarios/parcelas/${PARCELA_ID}/pagar`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** Um único ponto de entrada agora: `.rpc("fn_honorarios_parcela_pagar", ...)`. */
function fakeSupabase(resultado: { data?: unknown; error?: { message?: string; code?: string } | null }) {
  const rpc = vi.fn(() => Promise.resolve({ data: resultado.data ?? null, error: resultado.error ?? null }));
  return { rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/honorarios/parcelas/[id]/pagar", () => {
  it("manager paga uma parcela pendente — chama a RPC atômica e devolve o recibo dela", async () => {
    autorizadoComoManager();
    const supabase = fakeSupabase({
      data: {
        id: PARCELA_ID,
        contrato_id: "c1",
        numero: 1,
        valor_cents: 50000,
        status: "pago",
        financial_entry_id: "fe-1",
      },
    });
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ status: "pago", financial_entry_id: "fe-1" });
    expect(supabase.rpc).toHaveBeenCalledWith("fn_honorarios_parcela_pagar", {
      p_org: ORG_ID,
      p_parcela: PARCELA_ID,
      p_account_id: ACCOUNT_ID,
      p_account_plan_id: null,
    });
  });

  it("viewer/agent não paga — write exige manager+", async () => {
    negado();
    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);
    expect(res.status).toBe(403);
  });

  it("a RPC recusa por papel (honorarios_forbidden) → 403, mesmo se requireRole deixasse passar", async () => {
    autorizadoComoManager();
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ error: { message: "honorarios_forbidden", code: "42501" } }) as never,
    );
    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);
    expect(res.status).toBe(403);
  });

  it("parcela já paga (quem perde a corrida do for update) → 422, não duplica lançamento", async () => {
    autorizadoComoManager();
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ error: { message: "parcela_ja_paga", code: "22023" } }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);

    expect(res.status).toBe(422);
  });

  it("parcela inexistente → 404", async () => {
    autorizadoComoManager();
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ error: { message: "parcela_nao_encontrada", code: "P0002" } }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);

    expect(res.status).toBe(404);
  });

  it("conta inválida (23503 dentro da RPC) → 422 legível", async () => {
    autorizadoComoManager();
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ error: { message: "insert or update on table...", code: "23503" } }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);

    expect(res.status).toBe(422);
  });

  it("módulo não instalado (42P01 dentro da RPC) → 409 com mensagem clara", async () => {
    autorizadoComoManager();
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ error: { message: "relation does not exist", code: "42P01" } }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("module_not_installed");
  });
});
