/**
 * O FORMATO DO TOKEN DE SERVIDOR É UM SÓ — código, emissão e spec dizendo a mesma coisa.
 *
 * A Spec 01 e a Spec 11 declaravam `tok_` (com ambiente dentro do prefixo) e o
 * código exigia `dsk_`: dois enunciados do formato para uma credencial só, e a
 * spec é o que alguém abre para IMPLEMENTAR a emissão — quem seguisse o
 * documento criaria um token que `lib/mcp/auth.ts` recusa (issue #1129).
 *
 * Este teste prende as três pontas juntas:
 *
 *   1. a VALIDAÇÃO só aceita o prefixo implementado (`dsk_`) e recusa o outro
 *      como `malformed`, antes de tocar o banco;
 *   2. a EMISSÃO monta `dsk_<8 hex>_<segredo base64url>`, cujos 12 primeiros
 *      caracteres são o `prefix` que a UI mostra;
 *   3. as SPECS declaram `dsk_` e já não declaram `tok_` — é a cerca que
 *      impede que a divergência volte pelo outro lado.
 *
 * O prefixo não carrega ambiente (`tok_live_...`): o esquema nunca chegou ao
 * código e o produto não tem ambiente por token — a separação é por
 * organização, e o estado vive em `revoked_at`/`expires_at`. O motivo está
 * escrito na própria Spec 01 (§2.4), como a issue pede.
 *
 * Comando:
 *     npx vitest run tests/unit/formato-do-token-de-servidor-bate-com-a-spec.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";

import { ApiTokenError, resolveApiToken } from "@/lib/mcp/auth";

const SPEC_01 = readFileSync(
  join(process.cwd(), "docs/specs/01-spec-platform-base.md"),
  "utf8",
);
const SPEC_11 = readFileSync(
  join(process.cwd(), "docs/specs/11-spec-mcp-server-internal.md"),
  "utf8",
);
const EMISSAO = readFileSync(
  join(process.cwd(), "app/api/v1/settings/api-tokens/route.ts"),
  "utf8",
);
const EMISSAO_DA_ORG = readFileSync(
  join(process.cwd(), "lib/tenants/api-key.ts"),
  "utf8",
);

/** O `reason` da recusa, ou falha dizendo que não houve recusa. */
async function reasonDe(plaintext: string): Promise<ApiTokenError["reason"]> {
  try {
    await resolveApiToken(plaintext);
  } catch (err) {
    if (err instanceof ApiTokenError) return err.reason;
    throw err;
  }
  throw new Error("resolveApiToken aceitou um token onde a recusa era esperada");
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => ({ data: null, error: null });
      return c;
    },
  } as never);
});

describe("formato do token de servidor", () => {
  it("a validação exige `dsk_` e recusa o prefixo da spec antiga como malformed", async () => {
    // A recusa acontece ANTES do hash e do lookup: prefixo errado nunca consulta.
    expect(await reasonDe("tok_live_a3f9b2c4d5e6f7g8h9i0j1k2l3m4n5o6")).toBe("malformed");
    expect(await reasonDe("sk-livre-de-prefixo")).toBe("malformed");
    // Com o prefixo certo o formato passa e a recusa vem do BANCO (não há token),
    // provando que a checagem de formato é só o prefixo.
    expect(await reasonDe("dsk_a3f9b2c4_segredo")).toBe("not_found");
  });

  it("as DUAS portas de emissão montam `dsk_` + 8 hex + `_` + segredo", () => {
    for (const [nome, texto] of [
      ["rota de api_tokens", EMISSAO],
      ["rotateIntegrationApiKey", EMISSAO_DA_ORG],
    ] as const) {
      expect(texto, `${nome}: o prefixo emitido não é o dsk_ de 12 chars`).toContain(
        'const prefix = `dsk_${randomBytes(4).toString("hex")}`',
      );
      expect(texto, `${nome}: o segredo não é base64url de 32 bytes`).toContain(
        'randomBytes(32).toString("base64url")',
      );
    }
  });

  it("a Spec 01 declara o formato implementado e já não declara o prefixo antigo", () => {
    expect(SPEC_01).toContain("**Formato do plaintext**: `dsk_");
    expect(SPEC_01).toContain("primeiros 12 chars (`dsk_");
    expect(SPEC_01).not.toContain("tok_");
    // O motivo escrito, como a condição de fechamento da issue pede.
    expect(SPEC_01).toContain("Por que o prefixo NÃO carrega ambiente");
  });

  it("a Spec 11 declara `dsk_` no bearer do MCP e já não declara o prefixo antigo", () => {
    expect(SPEC_11).toContain("Bearer token (`dsk_...`)");
    expect(SPEC_11).toContain("Token plain prefix `dsk_`");
    expect(SPEC_11).not.toContain("tok_");
  });
});
