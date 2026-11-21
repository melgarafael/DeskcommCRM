/**
 * REVOGAR O TOKEN DE UM MÓDULO NA TELA DE TOKENS DESATIVA A ATIVAÇÃO DO PAR (spec 33, F2, tarefa 6).
 *
 * O banco revoga o token na mesma transação da desativação (`fn_extensions_configure`). Aqui se cobre a
 * rota: token de módulo chama o caminho de desativação com a organização ATIVA (não a do corpo), a
 * resposta diz que o módulo foi desativado, e token comum segue revogando só a linha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  support: vi.fn(),
  role: vi.fn(),
  audit: vi.fn(),
  desativar: vi.fn(),
  linha: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/extensions/desativar-do-token", () => ({ desativarAtivacaoDoModulo: deps.desativar }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => {
        const c: Record<string, unknown> = {};
        c.eq = () => c;
        c.maybeSingle = deps.linha;
        return c;
      },
      update: (valores: unknown) => {
        deps.update(valores);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

import { POST } from "@/app/api/v1/settings/api-tokens/[id]/revoke/route";
import { NextRequest } from "next/server";

const ORG = "bbbbbbbb-2222-4222-8222-222222222222";
const USER = "cccccccc-3333-4333-8333-333333333333";
const TOKEN = "aaaaaaaa-1111-4111-8111-111111111111";
const INSTALACAO = "dddddddd-4444-4444-8444-444444444444";

const chamar = () =>
  POST(new NextRequest(`http://localhost/api/v1/settings/api-tokens/${TOKEN}/revoke`, { method: "POST" }), {
    params: Promise.resolve({ id: TOKEN }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR", support: false },
    org: { orgId: ORG },
  });
});

describe("POST /settings/api-tokens/[id]/revoke", () => {
  it("token de módulo: desativa a ativação do par na organização ativa e diz que o módulo foi desativado", async () => {
    const quando = "2026-11-05T12:00:00.000Z";
    deps.linha
      // 1ª leitura: o token vivo de módulo
      .mockResolvedValueOnce({
        data: { id: TOKEN, revoked_at: null, extension_installation_id: INSTALACAO, module_slug: "acme/comanda" },
        error: null,
      })
      // 2ª leitura: depois da desativação o banco já revogou o token
      .mockResolvedValueOnce({ data: { revoked_at: quando }, error: null });
    deps.desativar.mockResolvedValue(true);

    const res = await chamar();
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(deps.desativar).toHaveBeenCalledWith(USER, ORG, INSTALACAO);
    expect(corpo.data).toMatchObject({ id: TOKEN, revoked_at: quando, module_deactivated: true });
    // Quem revogou foi o banco, na mesma transação: a rota não repete o update.
    expect(deps.update).not.toHaveBeenCalled();
  });

  it("token de módulo com a ativação já desligada: revoga só a linha", async () => {
    deps.linha.mockResolvedValueOnce({
      data: { id: TOKEN, revoked_at: null, extension_installation_id: INSTALACAO, module_slug: "acme/comanda" },
      error: null,
    });
    deps.desativar.mockResolvedValue(false);

    const res = await chamar();
    expect(res.status).toBe(200);
    expect(deps.update).toHaveBeenCalledTimes(1);
    expect((await res.json()).data.module_deactivated).toBeUndefined();
  });

  it("erro da desativação sobe como erro da extensão e NÃO revoga a linha por fora", async () => {
    deps.linha.mockResolvedValueOnce({
      data: { id: TOKEN, revoked_at: null, extension_installation_id: INSTALACAO, module_slug: "acme/comanda" },
      error: null,
    });
    deps.desativar.mockRejectedValue(new Error("falha qualquer"));

    const res = await chamar();
    expect(res.status).toBe(503);
    expect(deps.update).not.toHaveBeenCalled();
  });

  it("token comum: não toca a ativação, revoga a linha", async () => {
    deps.linha.mockResolvedValueOnce({
      data: { id: TOKEN, revoked_at: null, extension_installation_id: null, module_slug: null },
      error: null,
    });

    const res = await chamar();
    expect(res.status).toBe(200);
    expect(deps.desativar).not.toHaveBeenCalled();
    expect(deps.update).toHaveBeenCalledTimes(1);
  });

  it("acompanhamento de suporte não desativa módulo", async () => {
    deps.role.mockResolvedValue({
      ok: true,
      user: { id: USER, idioma: "pt-BR", support: true },
      org: { orgId: ORG },
    });
    deps.linha.mockResolvedValueOnce({
      data: { id: TOKEN, revoked_at: null, extension_installation_id: INSTALACAO, module_slug: "acme/comanda" },
      error: null,
    });

    const res = await chamar();
    expect(res.status).toBe(403);
    expect(deps.desativar).not.toHaveBeenCalled();
  });
});
