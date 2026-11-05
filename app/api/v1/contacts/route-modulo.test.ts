/**
 * `GET /api/v1/contacts` recusa o ator `module` (Spec 33, F3, tarefa 3).
 *
 * Esta rota autentica o Bearer por conta própria e lê pelos escopos do token, sem passar pela
 * área consentida. Um token de módulo (`mcp:read`, `role:viewer`) leria todos os contatos por
 * aqui. Token de pessoa/agente continua igual (a suíte de `route.test.ts` cobre).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";

import { listContactsHandler } from "./_handler";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
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

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/contacts — token de módulo", () => {
  it("403 module_token_not_allowed_here, sem tocar o handler nem a sessão", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG,
      role: "viewer",
      actor: { type: "module", id: "tok-1", slug: "acme/comanda" },
      apiTokenId: "tok-1",
      scopes: ["mcp:read", "role:viewer", "actor:module:acme/comanda"],
    });
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest("http://localhost/api/v1/contacts", {
        headers: { authorization: "Bearer dsk_abc_def" },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("module_token_not_allowed_here");
    expect(listContactsHandler).not.toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
  });
});
