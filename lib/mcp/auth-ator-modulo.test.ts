/**
 * O TOKEN DE MÓDULO É O ATOR `module` — E SÓ ELE (spec 33, F2, tarefa 6).
 *
 * O ator decide duas coisas que não aparecem como erro de tipo: o que o audit grava (token em
 * `actor_api_token_id`, módulo em `metadata.module`) e o que NÃO vai para coluna de pessoa. Um escopo
 * malformado não pode virar módulo, e `created_by` nulo (token de módulo) não pode quebrar a resolução.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/rate-limit", () => ({
  registrarFalhaDeToken: vi.fn(),
  tokenFailureLimited: vi.fn(async () => false),
}));

import { createAdminClient } from "@/lib/supabase/admin";

import { deriveActor, resolveApiToken, validateBearerToken } from "./auth";

const TOKEN_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const SLUG = "acme/comanda";
const ESCOPOS_DO_MODULO = ["mcp:read", "role:viewer", `actor:module:${SLUG}`];

describe("deriveActor — módulo", () => {
  it("devolve `module` com o id do token e o slug quando o escopo está certo", () => {
    expect(deriveActor(ESCOPOS_DO_MODULO, TOKEN_ID)).toEqual({
      type: "module",
      id: TOKEN_ID,
      slug: SLUG,
    });
  });

  it.each([
    ["sem barra", "actor:module:acme"],
    ["vazio", "actor:module:"],
    ["com maiúscula", "actor:module:Acme/comanda"],
    ["com três partes", "actor:module:acme/comanda/extra"],
    ["com espaço", "actor:module:acme/com anda"],
    ["começando com hífen", "actor:module:-acme/comanda"],
    ["com ponto", "actor:module:acme/co.manda"],
  ])("escopo malformado (%s) continua `api_token`", (_motivo, escopo) => {
    const ator = deriveActor(["mcp:read", escopo], TOKEN_ID);
    expect(ator.type).toBe("api_token");
    expect(ator.id).toBe(TOKEN_ID);
  });

  it("sem escopo de módulo, nada muda: token comum e agente", () => {
    expect(deriveActor(["mcp:read"], TOKEN_ID).type).toBe("api_token");
    expect(deriveActor(["mcp:write", "actor:ai_agent"], TOKEN_ID).type).toBe("ai_agent");
  });

  it("módulo nunca é `user`: o `=== \"user\"` dos handlers continua falso", () => {
    expect(deriveActor(ESCOPOS_DO_MODULO, TOKEN_ID).type).not.toBe("user");
  });
});

describe("token de módulo no banco — created_by nulo", () => {
  const PLAINTEXT = "dsk_abcd1234_segredodomodulo";
  const HASH = `\\x${createHash("sha256").update(PLAINTEXT).digest("hex")}`;

  function adminComLinha(linha: Record<string, unknown>) {
    const filtros: Array<[string, unknown]> = [];
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue({
      from: (tabela: string) => {
        if (tabela !== "api_tokens") throw new Error(`tabela inesperada: ${tabela}`);
        return {
          select: () => {
            const c: Record<string, unknown> = {};
            c.eq = (coluna: string, valor: unknown) => {
              filtros.push([coluna, valor]);
              return c;
            };
            c.maybeSingle = async () => ({ data: linha, error: null });
            return c;
          },
          update: () => {
            const c: Record<string, unknown> = {};
            c.eq = () => c;
            c.then = (resolver: (v: unknown) => unknown) => resolver({ error: null });
            return c;
          },
        };
      },
    });
    return filtros;
  }

  const linhaDoModulo = () => ({
    id: TOKEN_ID,
    organization_id: ORG_ID,
    scopes: ESCOPOS_DO_MODULO,
    revoked_at: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_by: null,
    organizations: { status: "active" },
  });

  beforeEach(() => vi.clearAllMocks());

  it("`resolveApiToken` devolve `createdBy: null` sem quebrar", async () => {
    const filtros = adminComLinha(linhaDoModulo());
    const resolvido = await resolveApiToken(PLAINTEXT);
    expect(resolvido.createdBy).toBeNull();
    expect(resolvido.id).toBe(TOKEN_ID);
    expect(resolvido.organizationId).toBe(ORG_ID);
    expect(filtros).toContainEqual(["token_hash", HASH]);
  });

  it("`validateBearerToken` entrega o ator `module` e o papel viewer", async () => {
    adminComLinha(linhaDoModulo());
    const auth = await validateBearerToken(`Bearer ${PLAINTEXT}`);
    expect(auth.actor).toEqual({ type: "module", id: TOKEN_ID, slug: SLUG });
    expect(auth.role).toBe("viewer");
    expect(auth.apiTokenId).toBe(TOKEN_ID);
  });
});
