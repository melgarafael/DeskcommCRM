import { describe, expect, it, vi } from "vitest";

import { resolveOrgLlmConfig } from "@/lib/agent-engine/edge/llm/credentials";

const { renovarMock, quarentenarMock } = vi.hoisted(() => ({
  renovarMock: vi.fn(),
  quarentenarMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({}),
}));

vi.mock("@/lib/ai/codex/armazenamento", () => ({
  lerRefreshToken: vi.fn(async (_admin: unknown, orgId: string) =>
    orgId === "org-com-vinculo" ? { id: "vinc-1", refreshToken: "rt-1" } : null,
  ),
  quarentenarVinculo: quarentenarMock,
}));

vi.mock("@/lib/ai/codex/oauth", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  renovarAccessToken: renovarMock,
}));

function poolCom(settings: unknown) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("ai_provider_credentials")) return { rows: [] };
      return [
        {
          rows: [
            { llm: settings, teto: null, modo: null, efetivo_em: null, limiar_pct: null },
          ],
        },
      ][0];
    }),
  } as never;
}

describe("codex no resolver", () => {
  it("com vínculo OAuth válido → access token renovado vira a apiKey do turno", async () => {
    renovarMock.mockResolvedValueOnce({ accessToken: "at-novo", expiresIn: 3600 });
    const cfg = await resolveOrgLlmConfig(poolCom({ provider: "openai-codex" }), {}, "org-com-vinculo");
    expect(cfg.provider).toBe("openai-codex");
    expect(cfg.apiKey).toBe("at-novo");
  });

  it("sem vínculo OAuth → LlmNotConfiguredError (não fallback silencioso)", async () => {
    await expect(resolveOrgLlmConfig(poolCom({ provider: "openai-codex" }), {}, "org-sem-vinculo")).rejects.toThrow(
      /org sem credencial/,
    );
  });

  it("refresh revogado → quarentena + LlmNotConfiguredError", async () => {
    const err = new Error("codex_refresh_401") as Error & { status: number };
    err.status = 401;
    renovarMock.mockRejectedValueOnce(err);
    await expect(resolveOrgLlmConfig(poolCom({ provider: "openai-codex" }), {}, "org-com-vinculo")).rejects.toThrow(
      /org sem credencial/,
    );
    expect(quarentenarMock).toHaveBeenCalledOnce();
  });
});
