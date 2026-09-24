/**
 * POST /api/v1/honorarios/parcelas/[id]/pagar — DIRC "integrar": cria um `financial_entries`
 * do caixa núcleo e liga por `financial_entry_id`, nunca uma tabela de "pagamento" própria.
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

/** Duas tabelas em jogo: `honorarios_parcelas` (lê, depois atualiza) e `financial_entries`
 * (cria o lançamento). O fake decide pela tabela pedida. */
function fakeSupabase(opts: {
  parcela: { status: string; valor_cents: number; numero: number; contrato_id: string } | null;
  erroLeituraParcela?: { code?: string };
  erroLancamento?: { code?: string };
  erroAtualizacao?: { code?: string };
}) {
  return {
    from(table: string) {
      if (table === "honorarios_parcelas") {
        let atualizando = false;
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: () =>
            Promise.resolve(
              opts.erroLeituraParcela
                ? { data: null, error: opts.erroLeituraParcela }
                : { data: opts.parcela ? { id: PARCELA_ID, ...opts.parcela } : null, error: null },
            ),
          update: () => {
            atualizando = true;
            return builder;
          },
          single: () =>
            Promise.resolve(
              opts.erroAtualizacao
                ? { data: null, error: opts.erroAtualizacao }
                : {
                    data: atualizando
                      ? { id: PARCELA_ID, status: "pago", financial_entry_id: "fe-1" }
                      : null,
                    error: null,
                  },
            ),
        };
        return builder;
      }
      if (table === "financial_entries") {
        const builder: Record<string, unknown> = {
          insert: () => builder,
          select: () => builder,
          single: () =>
            Promise.resolve(
              opts.erroLancamento
                ? { data: null, error: opts.erroLancamento }
                : { data: { id: "fe-1" }, error: null },
            ),
        };
        return builder;
      }
      throw new Error(`tabela inesperada: ${table}`);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/honorarios/parcelas/[id]/pagar", () => {
  it("manager paga uma parcela pendente — cria lançamento e liga por financial_entry_id", async () => {
    autorizadoComoManager();
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        parcela: { status: "pendente", valor_cents: 50000, numero: 1, contrato_id: "c1" },
      }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ status: "pago", financial_entry_id: "fe-1" });
  });

  it("viewer/agent não paga — write exige manager+", async () => {
    negado();
    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);
    expect(res.status).toBe(403);
  });

  it("parcela já paga → 422, não duplica lançamento", async () => {
    autorizadoComoManager();
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        parcela: { status: "pago", valor_cents: 50000, numero: 1, contrato_id: "c1" },
      }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);

    expect(res.status).toBe(422);
  });

  it("parcela inexistente → 404", async () => {
    autorizadoComoManager();
    vi.mocked(createClient).mockResolvedValue(fakeSupabase({ parcela: null }) as never);

    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);

    expect(res.status).toBe(404);
  });

  it("conta inválida (23503 do financial_entries) → 422 legível", async () => {
    autorizadoComoManager();
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        parcela: { status: "pendente", valor_cents: 50000, numero: 1, contrato_id: "c1" },
        erroLancamento: { code: "23503" },
      }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(postReq({ account_id: ACCOUNT_ID }), params);

    expect(res.status).toBe(422);
  });
});
