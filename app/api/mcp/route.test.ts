/**
 * `/api/mcp` recusa o ator `module` (Spec 33, F3, tarefa 3).
 *
 * O servidor MCP aceita qualquer `dsk_` e decide pelos escopos do token. Um token de módulo
 * (`mcp:read`) leria tudo por ali sem passar pela área consentida; por isso a recusa vem antes
 * de qualquer ferramenta, nos três métodos HTTP que a rota atende.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMcpServer } from "@/lib/mcp/server";

vi.mock("@/lib/mcp/server", () => ({ createMcpServer: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ modulosLigados: vi.fn(async () => ({})) }));
vi.mock("@/lib/organizacao/capacidades", () => ({ capacidadesDaOrganizacao: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG = "22222222-2222-4222-8222-222222222222";

function req(metodo: string) {
  return new NextRequest("http://localhost/api/mcp", {
    method: metodo,
    headers: { authorization: "Bearer dsk_abc_def" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("/api/mcp — token de módulo", () => {
  it.each(["POST", "GET", "DELETE"] as const)("%s ⇒ 403 antes de montar o servidor", async (metodo) => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG,
      role: "viewer",
      actor: { type: "module", id: "tok-1", slug: "acme/comanda" },
      apiTokenId: "tok-1",
      scopes: ["mcp:read", "role:viewer", "actor:module:acme/comanda"],
    });
    const rota = await import("./route");
    const res = await rota[metodo](req(metodo));
    expect(res.status).toBe(403);
    const corpo = (await res.json()) as { error: { code: number; message: string } };
    expect(corpo.error.message).toMatch(/módulo/i);
    expect(createMcpServer).not.toHaveBeenCalled();
  });

  it("token de agente segue para o servidor (nada muda para quem não é módulo)", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG,
      role: "agent",
      actor: { type: "ai_agent", id: "run-1", role: "agent", api_token_id: "tok-2" },
      apiTokenId: "tok-2",
      scopes: ["mcp:read"],
    });
    vi.mocked(createMcpServer).mockImplementation(() => {
      throw new Error("chegou ao servidor");
    });
    const { POST } = await import("./route");
    await expect(POST(req("POST"))).rejects.toThrow("chegou ao servidor");
    expect(createMcpServer).toHaveBeenCalledTimes(1);
  });
});
