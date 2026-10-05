/**
 * O NÚCLEO DE `api_tokens` SEPARADO DO PROTOCOLO — e a casca que o traduz.
 *
 * ## Por que esta cerca existe
 *
 * `resolveApiToken` nasceu de dentro de `validateBearerToken`: a validação de
 * um bearer `dsk_...` (hash SHA256 → lookup → `revoked_at`/`expires_at`) foi
 * separada da TRADUÇÃO da recusa para JSON-RPC/HTTP. Uma extração assim é
 * exatamente o tipo de mudança que passa em `typecheck` e em `lint` mudando
 * comportamento no escuro: os dois lados continuam com a mesma assinatura, e
 * quem perde é a resposta que o cliente recebe.
 *
 * O que não pode regredir, e é o que este arquivo mede:
 *
 *   1. Cada motivo de recusa tem seu `reason` neutro — é o contrato que permite
 *      a um consumidor não-MCP usar `api_tokens` sem herdar `McpAuthError`. Um
 *      `reason` trocado não quebra tipo nenhum, e um dia vira 401 onde devia
 *      ser 500 (ou o contrário).
 *   2. `validateBearerToken` devolve os MESMOS códigos MCP e os MESMOS status
 *      HTTP de antes da extração, com as mesmas mensagens. A tabela abaixo é a
 *      régua: ela foi lida do arquivo ANTES da separação.
 *   3. O lookup é pelo HASH, nunca pelo plaintext. É a razão de o banco não
 *      guardar o segredo (doutrina: "Bearer plaintext armazenado no DB").
 *   4. O `last_used_at` fire-and-forget continua acontecendo, DEPOIS de todas
 *      as validações — um token revogado não pode registrar uso.
 *   5. Erro que NÃO é `ApiTokenError` sobe inteiro. Se a casca virasse um
 *      `catch` genérico, todo defeito de infraestrutura passaria a se disfarçar
 *      de "token inválido" e ninguém veria o 500.
 *
 * ## Comando
 *
 *     npx vitest run lib/mcp/auth-resolve-api-token.test.ts
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";

import { ApiTokenError, McpAuthError, resolveApiToken, validateBearerToken } from "./auth";

const TOKEN_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const CRIADOR_ID = "cccccccc-3333-4333-8333-333333333333";

const PLAINTEXT = "dsk_abcd_segredoquenaovaipralugarnenhum";
/** O que a coluna `token_hash` (bytea) guarda: `\x` + sha256 hex do plaintext. */
const HASH_ESPERADO = `\\x${createHash("sha256").update(PLAINTEXT).digest("hex")}`;

const NO_FUTURO = new Date(Date.now() + 3_600_000).toISOString();
const NO_PASSADO = "2020-01-01T00:00:00.000Z";

interface LinhaDoToken {
  id: string;
  organization_id: string;
  scopes: unknown;
  revoked_at: string | null;
  expires_at: string | null;
  created_by: string;
  organizations: { status: string };
}

function linhaViva(patch: Partial<LinhaDoToken> = {}): LinhaDoToken {
  return {
    id: TOKEN_ID,
    organization_id: ORG_ID,
    scopes: ["mcp:read", "mcp:write"],
    revoked_at: null,
    expires_at: null,
    created_by: CRIADOR_ID,
    organizations: { status: "active" },
    ...patch,
  };
}

interface Registro {
  /** Colunas pedidas no `select` — é onde `created_by` tem de aparecer. */
  colunas: string[];
  filtros: Array<[string, unknown]>;
  updates: Array<Record<string, unknown>>;
  idsAtualizados: unknown[];
}

type Resposta = { data: LinhaDoToken | null; error: { message: string } | null };

/**
 * Dublê do admin client. `select(...).eq(...).maybeSingle()` devolve a resposta
 * pedida; `update(...).eq(...)` é thenable, como o builder real — é assim que o
 * `last_used_at` sem `await` se resolve.
 */
function adminDeTokens(resposta: Resposta, reg: Registro) {
  return {
    from: (tabela: string) => {
      if (tabela !== "api_tokens") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        select: (colunas: string) => {
          reg.colunas.push(colunas);
          const c: Record<string, unknown> = {};
          c.eq = (coluna: string, valor: unknown) => {
            reg.filtros.push([coluna, valor]);
            return c;
          };
          c.maybeSingle = async () => resposta;
          return c;
        },
        update: (valores: Record<string, unknown>) => {
          reg.updates.push(valores);
          const c: Record<string, unknown> = {};
          c.eq = (_coluna: string, valor: unknown) => {
            reg.idsAtualizados.push(valor);
            return c;
          };
          c.then = (resolver: (v: unknown) => unknown) => resolver({ error: null });
          return c;
        },
      };
    },
  };
}

function armar(resposta: Resposta): Registro {
  const reg: Registro = { colunas: [], filtros: [], updates: [], idsAtualizados: [] };
  vi.mocked(createAdminClient).mockReturnValue(adminDeTokens(resposta, reg) as never);
  return reg;
}

const achou = (linha: LinhaDoToken): Resposta => ({ data: linha, error: null });
const naoAchou: Resposta = { data: null, error: null };
const falhou: Resposta = { data: null, error: { message: "connection reset" } };

/** O `reason` de `ApiTokenError`, ou explode dizendo que não houve recusa. */
async function reasonDe(plaintext: string): Promise<ApiTokenError["reason"]> {
  try {
    await resolveApiToken(plaintext);
  } catch (err) {
    if (err instanceof ApiTokenError) return err.reason;
    throw err;
  }
  throw new Error("resolveApiToken devolveu um token onde a recusa era esperada");
}

/** O par (código MCP, status HTTP, mensagem) que a casca produz. */
async function recusaMcp(authHeader: string | null) {
  try {
    await validateBearerToken(authHeader);
  } catch (err) {
    if (err instanceof McpAuthError) {
      return { mcpCode: err.mcpCode, httpStatus: err.httpStatus, message: err.message };
    }
    throw err;
  }
  throw new Error("validateBearerToken autenticou onde a recusa era esperada");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveApiToken — os cinco motivos de recusa", () => {
  it("token que não começa com `dsk_` é `malformed`, e o banco nem é aberto", async () => {
    armar(achou(linhaViva()));

    expect(await reasonDe("Bearer-sem-prefixo")).toBe("malformed");
    expect(
      createAdminClient,
      "um plaintext de formato errado chegou a abrir conexão e consultar `api_tokens` — o curto-circuito de formato deixou de existir",
    ).not.toHaveBeenCalled();
  });

  it("hash que não casa com linha nenhuma é `not_found`", async () => {
    armar(naoAchou);
    expect(await reasonDe(PLAINTEXT)).toBe("not_found");
  });

  it("token com `revoked_at` é `revoked`", async () => {
    armar(achou(linhaViva({ revoked_at: "2026-09-01T10:00:00.000Z" })));
    expect(await reasonDe(PLAINTEXT)).toBe("revoked");
  });

  it("token com `expires_at` no passado é `expired`", async () => {
    armar(achou(linhaViva({ expires_at: NO_PASSADO })));
    expect(await reasonDe(PLAINTEXT)).toBe("expired");
  });

  it("token vivo de organização SUSPENSA é `org_suspended` e não registra uso", async () => {
    const reg = armar(achou(linhaViva({ organizations: { status: "suspended" } })));
    expect(await reasonDe(PLAINTEXT)).toBe("org_suspended");
    expect(reg.updates).toEqual([]);
    expect(reg.colunas.join(",")).toContain("organizations!inner(status)");
  });

  it("erro do banco é `lookup_failed` — falha de infra NÃO é token inválido", async () => {
    armar(falhou);
    // A distinção é o que separa 500 de 401 lá na casca. Se as duas colapsarem,
    // um banco fora do ar passa a ser reportado ao cliente como token ruim.
    expect(await reasonDe(PLAINTEXT)).toBe("lookup_failed");
  });
});

describe("resolveApiToken — o caminho feliz (par de vacuidade dos casos acima)", () => {
  it("token vivo resolve, com id, org, scopes e quem provisionou", async () => {
    armar(achou(linhaViva()));

    const r = await resolveApiToken(PLAINTEXT);

    expect(
      r,
      "nem o token vivo resolve: a sonda recusa tudo, e os cinco casos acima estão verdes pelo motivo errado",
    ).toEqual({
      id: TOKEN_ID,
      organizationId: ORG_ID,
      scopes: ["mcp:read", "mcp:write"],
      createdBy: CRIADOR_ID,
    });
  });

  it("`expires_at` no futuro não expira — senão `expired` passaria por acidente", async () => {
    armar(achou(linhaViva({ expires_at: NO_FUTURO })));
    await expect(resolveApiToken(PLAINTEXT)).resolves.toMatchObject({ id: TOKEN_ID });
  });

  it("busca pelo HASH, nunca pelo plaintext, e pede `created_by`", async () => {
    const reg = armar(achou(linhaViva()));

    await resolveApiToken(PLAINTEXT);

    expect(reg.filtros).toEqual([["token_hash", HASH_ESPERADO]]);
    // Redundante de propósito: se o dia em que alguém trocar o filtro por
    // plaintext o hash esperado também for reescrito, esta linha ainda pega.
    expect(
      JSON.stringify(reg.filtros),
      "o plaintext do token apareceu no filtro da consulta — o segredo passou a viajar para o banco em claro",
    ).not.toContain(PLAINTEXT);
    expect(
      reg.colunas.join(","),
      "`created_by` saiu do select: quem consome o núcleo perde o dado de quem provisionou o token",
    ).toContain("created_by");
  });

  it("registra `last_used_at` do token que passou", async () => {
    const reg = armar(achou(linhaViva()));

    await resolveApiToken(PLAINTEXT);

    expect(reg.updates).toHaveLength(1);
    expect(Object.keys(reg.updates[0]!)).toEqual(["last_used_at"]);
    expect(reg.idsAtualizados, "o update de uso não foi filtrado pelo id do token").toEqual([
      TOKEN_ID,
    ]);
  });

  it("token REVOGADO não registra uso — a validação vem antes do efeito", async () => {
    const reg = armar(achou(linhaViva({ revoked_at: "2026-09-01T10:00:00.000Z" })));

    await reasonDe(PLAINTEXT);

    expect(
      reg.updates,
      "um token recusado atualizou `last_used_at`: o efeito colateral subiu para antes das validações",
    ).toEqual([]);
  });
});

/**
 * A RÉGUA. Cada linha foi lida de `lib/mcp/auth.ts` ANTES da extração, onde
 * `validateBearerToken` lançava `McpAuthError` direto. Mudar qualquer célula
 * aqui é mudar o que o cliente MCP recebe.
 */
const TABELA_DE_TRADUCAO: Array<{
  caso: string;
  header: string | null;
  resposta: Resposta;
  mcpCode: number;
  httpStatus: number;
  message: string;
}> = [
  {
    caso: "sem header Authorization",
    header: null,
    resposta: achou(linhaViva()),
    mcpCode: -32001,
    httpStatus: 401,
    message: "Missing or malformed Authorization header.",
  },
  {
    caso: "header sem `Bearer`",
    header: "Token dsk_qualquer",
    resposta: achou(linhaViva()),
    mcpCode: -32001,
    httpStatus: 401,
    message: "Missing or malformed Authorization header.",
  },
  {
    caso: "bearer sem prefixo `dsk_` (malformed)",
    header: "Bearer chave_de_outro_produto",
    resposta: achou(linhaViva()),
    mcpCode: -32001,
    httpStatus: 401,
    message: "Invalid token format.",
  },
  {
    caso: "hash sem linha (not_found)",
    header: `Bearer ${PLAINTEXT}`,
    resposta: naoAchou,
    mcpCode: -32001,
    httpStatus: 401,
    message: "Token not recognized.",
  },
  {
    caso: "token revogado (revoked)",
    header: `Bearer ${PLAINTEXT}`,
    resposta: achou(linhaViva({ revoked_at: "2026-09-01T10:00:00.000Z" })),
    mcpCode: -32001,
    httpStatus: 401,
    message: "Token revoked.",
  },
  {
    caso: "token expirado (expired)",
    header: `Bearer ${PLAINTEXT}`,
    resposta: achou(linhaViva({ expires_at: NO_PASSADO })),
    mcpCode: -32001,
    httpStatus: 401,
    message: "Token expired.",
  },
  {
    caso: "token vivo de organização suspensa (org_suspended)",
    header: `Bearer ${PLAINTEXT}`,
    resposta: achou(linhaViva({ organizations: { status: "suspended" } })),
    mcpCode: -32002,
    httpStatus: 403,
    message: "Organization suspended.",
  },
  {
    caso: "banco falhou (lookup_failed) — o ÚNICO 500 da tabela",
    header: `Bearer ${PLAINTEXT}`,
    resposta: falhou,
    mcpCode: -32603,
    httpStatus: 500,
    message: "Token lookup failed: connection reset",
  },
];

describe("validateBearerToken — a tradução para MCP não mudou", () => {
  for (const linha of TABELA_DE_TRADUCAO) {
    it(`${linha.caso} → ${linha.mcpCode} / HTTP ${linha.httpStatus}`, async () => {
      armar(linha.resposta);

      expect(await recusaMcp(linha.header)).toEqual({
        mcpCode: linha.mcpCode,
        httpStatus: linha.httpStatus,
        message: linha.message,
      });
    });
  }

  it("um token válido continua devolvendo o mesmo `McpAuthResult`", async () => {
    armar(achou(linhaViva()));

    const r = await validateBearerToken(`Bearer ${PLAINTEXT}`);

    expect(r).toEqual({
      organizationId: ORG_ID,
      role: "agent",
      // `api_token`, NUNCA `user` — ver `lib/mcp/auth-ator.test.ts`, que é o
      // arquivo que guarda esta decisão e o motivo dela.
      actor: { type: "api_token", id: TOKEN_ID, role: "agent" },
      apiTokenId: TOKEN_ID,
      scopes: ["mcp:read", "mcp:write"],
    });
  });

  it("`role:` e `actor:ai_agent` nos scopes continuam chegando ao ator", async () => {
    armar(achou(linhaViva({ scopes: ["mcp:write", "role:manager", "actor:ai_agent"] })));

    const r = await validateBearerToken(`Bearer ${PLAINTEXT}`);

    expect(r.role).toBe("manager");
    expect(r.actor).toEqual({
      type: "ai_agent",
      id: TOKEN_ID,
      role: "manager",
      api_token_id: TOKEN_ID,
    });
  });

  it("scopes com lixo continuam filtrados a strings", async () => {
    armar(achou(linhaViva({ scopes: ["mcp:read", 42, null, { a: 1 }] })));
    await expect(validateBearerToken(`Bearer ${PLAINTEXT}`)).resolves.toMatchObject({
      scopes: ["mcp:read"],
    });
  });

  // Decisão do dono (30/09): a ferramenta de privacidade atende empresa suspensa.
  // Só o `/api/mcp` passa a opção; sem ela, a régua acima (403) vale.
  it("com `permiteOrgSuspensa`, token de org suspensa autentica marcado `orgSuspensa`", async () => {
    armar(achou(linhaViva({ organizations: { status: "suspended" } })));
    const r = await validateBearerToken(`Bearer ${PLAINTEXT}`, { permiteOrgSuspensa: true });
    expect(r).toMatchObject({ organizationId: ORG_ID, orgSuspensa: true });
  });

  it("com `permiteOrgSuspensa`, org que opera não ganha a marca", async () => {
    armar(achou(linhaViva()));
    const r = await validateBearerToken(`Bearer ${PLAINTEXT}`, { permiteOrgSuspensa: true });
    expect(r).not.toHaveProperty("orgSuspensa");
  });

  it("erro que NÃO é `ApiTokenError` sobe inteiro, sem virar recusa de auth", async () => {
    // Se a casca tivesse um `catch` genérico, um defeito de infraestrutura
    // (env faltando, client que não constrói) sairia como 401 e ninguém
    // procuraria a causa: o cliente leria "seu token é inválido".
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new TypeError("SUPABASE_SERVICE_ROLE_KEY ausente");
    });

    const erro = await validateBearerToken(`Bearer ${PLAINTEXT}`).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(TypeError);
    expect(
      erro,
      "um erro de infraestrutura foi convertido em recusa de autenticação — o 500 desapareceu e virou 401",
    ).not.toBeInstanceOf(McpAuthError);
  });
});
