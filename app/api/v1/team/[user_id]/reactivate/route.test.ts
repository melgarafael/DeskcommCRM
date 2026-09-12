import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";

/**
 * POST /api/v1/team/[user_id]/reactivate — devolver o acesso de quem foi
 * revogado.
 *
 * ─── O defeito que esta rota fecha ──────────────────────────────────────────
 *
 * Medido numa instalação real em 2026-09-10, com uma pessoa de verdade do
 * outro lado: revogar era porta que só abria por fora. O membro sumia da lista
 * e a única volta era emitir convite novo — que o banco aceita, mas cujo
 * caminho tem três becos (o cadastro que diz "tente novamente" e nunca
 * funciona, o login que joga na tela de revogado, e a lista que não mostra
 * ninguém para reativar).
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const ALVO = "33333333-3333-4333-8333-333333333333";

/** O `update` observado, para as asserções. */
let ultimoUpdate: Record<string, unknown> | null = null;

function bancoCom(linha: unknown, erroUpdate: { message: string } | null = null) {
  ultimoUpdate = null;
  const update = vi.fn((valores: Record<string, unknown>) => {
    ultimoUpdate = valores;
    return { eq: vi.fn(async () => ({ error: erroUpdate })) };
  });
  vi.mocked(createClient).mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: linha, error: null }) }) }),
      }),
      update,
    }),
  } as never);
  return { update };
}

function pedido() {
  return new NextRequest("http://localhost/api/v1/team/x/reactivate", { method: "POST" });
}
const ctx = { params: Promise.resolve({ user_id: ALVO }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ADMIN, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
});

describe("reativar membro", () => {
  it("⭐ limpa a revogação e devolve o papel que a pessoa tinha", async () => {
    bancoCom({ id: "m1", user_id: ALVO, role: "agent", revoked_at: "2026-09-10T22:45:53Z" });
    const { POST } = await import("./route");

    const res = await POST(pedido(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.user_id).toBe(ALVO);
    expect(ultimoUpdate).toMatchObject({ revoked_at: null });
  });

  it("NÃO mexe no papel — reativar não é promover", async () => {
    // Juntar as duas coisas faria uma reativação distraída virar promoção
    // silenciosa. Trocar papel tem rota própria.
    bancoCom({ id: "m1", user_id: ALVO, role: "agent", revoked_at: "2026-09-10T22:45:53Z" });
    const { POST } = await import("./route");
    await POST(pedido(), ctx);

    expect(ultimoUpdate).not.toHaveProperty("role");
  });

  it("registra quem devolveu o acesso — a coluna não guarda histórico", async () => {
    bancoCom({ id: "m1", user_id: ALVO, role: "manager", revoked_at: "2026-09-10T22:45:53Z" });
    const { POST } = await import("./route");
    await POST(pedido(), ctx);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.reactivated",
        actorUserId: ADMIN,
        organizationId: ORG,
        metadata: expect.objectContaining({ target_user_id: ALVO, restored_role: "manager" }),
      }),
    );
  });

  it("é idempotente: quem já está ativo não vira erro na cara de quem clica", async () => {
    bancoCom({ id: "m1", user_id: ALVO, role: "agent", revoked_at: null });
    const { POST } = await import("./route");

    const res = await POST(pedido(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.already_active).toBe(true);
    expect(ultimoUpdate).toBeNull();
  });

  it("membro de outra organização não é encontrado", async () => {
    bancoCom(null);
    const { POST } = await import("./route");

    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(404);
  });

  it("CONTROLE — só admin passa", async () => {
    // Sem este caso, uma rota sem gate passaria verde: qualquer membro
    // devolveria o acesso de quem o admin acabou de tirar.
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const { POST } = await import("./route");

    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(403);
  });

  it("falha do banco não vira sucesso silencioso", async () => {
    bancoCom({ id: "m1", user_id: ALVO, role: "agent", revoked_at: "2026-09-10T22:45:53Z" }, {
      message: "deadlock",
    });
    const { POST } = await import("./route");

    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(500);
  });
});
