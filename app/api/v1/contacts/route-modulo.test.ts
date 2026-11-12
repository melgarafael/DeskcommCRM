/**
 * `GET /api/v1/contacts` com token de MÓDULO (Spec 33, F3).
 *
 * Esta rota autentica o Bearer por conta própria. Para o ator `module` ela entrega a decisão ao portão
 * (`resolveAuthDual`), que confere a área `contatos` em leitura (declarada E consentida), o papel
 * efetivo e o teto de chamadas. Um módulo sem a área não lê contato; um módulo com a área lê.
 * Token de pessoa/agente continua igual (a suíte de `route.test.ts` cobre).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { autorizarModulo } from "@/lib/auth/modulo-autorizado";
import { requireRole } from "@/lib/auth/require-role";

import { listContactsHandler } from "./_handler";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/auth/modulo-autorizado", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/modulo-autorizado")>(
    "@/lib/auth/modulo-autorizado",
  );
  return { ...actual, autorizarModulo: vi.fn() };
});
vi.mock("./_handler", () => ({
  listContactsHandler: vi.fn(async () => ({ contacts: [], cursor: null, has_more: false })),
  createContactHandler: vi.fn(),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG = "22222222-2222-4222-8222-222222222222";

function pedido(): NextRequest {
  return new NextRequest("http://localhost/api/v1/contacts", {
    headers: { authorization: "Bearer dsk_abc_def" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: "viewer",
    actor: { type: "module", id: "tok-1", slug: "acme/comanda" },
    apiTokenId: "tok-1",
    scopes: ["mcp:read", "role:viewer", "actor:module:acme/comanda"],
  });
});

describe("GET /api/v1/contacts — token de módulo", () => {
  it("sem a área `contatos` consentida: 403 module_area_not_granted, sem tocar o handler nem a sessão", async () => {
    vi.mocked(autorizarModulo).mockResolvedValue({ ok: false, codigo: "module_area_not_granted" });
    const { GET } = await import("./route");
    const res = await GET(pedido());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("module_area_not_granted");
    expect(listContactsHandler).not.toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("com a área `contatos` consentida: lê, pela organização da LINHA DO TOKEN, com o módulo como ator", async () => {
    vi.mocked(autorizarModulo).mockResolvedValue({
      ok: true,
      installationId: "inst-1",
      contatoVisivel: true,
    });
    const { GET } = await import("./route");
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(autorizarModulo).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, tokenId: "tok-1", metodo: "GET" }),
    );
    expect(listContactsHandler).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(listContactsHandler).mock.calls[0]?.[1];
    expect(ctx?.organization_id).toBe(ORG);
    expect(ctx?.actor.type).toBe("module");
    expect(requireRole).not.toHaveBeenCalled();
  });
});
