/**
 * O teto de falhas de token do MCP — o que o endpoint não tinha (issue #1447).
 *
 * Por que esta cerca existe: `POST /api/mcp` respondia 401 a qualquer `dsk_...`
 * sem contar a recusa. Cada tentativa custava um SELECT em `api_tokens` e nada
 * registrava o fracasso, então varrer tokens saía de graça — sem teto, sem
 * rastro. A correção conta a falha em dois baldes (`lib/auth/rate-limit.ts`):
 * por ORIGEM (30 falhas / 5 min) e pelo VALOR APRESENTADO (5 falhas / 5 min,
 * chave = hash do valor apresentado, nunca o valor).
 *
 * O que estes casos travam — e que os vizinhos (`auth-resolve-api-token.test.ts`,
 * `auth-ator.test.ts`) não travam, porque lá cada caso é uma falha isolada:
 *   1. chute repetido cai no teto, e o teto é 429/-32004 (não 401);
 *   2. 30 chutes DIFERENTES do mesmo IP também caem — é o balde por origem que
 *      pega quem troca de token a cada palpite;
 *   3. token válido em uso não paga imposto nenhum: sucesso não incrementa;
 *   4. trocar de IP não salva quem repete o MESMO valor — é o balde por valor
 *      que pega a varredura distribuída;
 *   5. `lookup_failed` (banco fora) não debita nada: indisponibilidade nossa não
 *      tranca cliente nenhum.
 *
 * Comando: npx vitest run lib/mcp/auth-teto-de-token.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

import type * as AuthModulo from "./auth";

let auth: typeof AuthModulo;

beforeEach(async () => {
  // Contadores vivem no módulo: cada caso começa do zero.
  vi.resetModules();
  vi.clearAllMocks();
  auth = await import("./auth");
});

/** Diz de onde a requisição vem. `clientIp` lê qualquer um dos headers do proxy. */
function chamandoDe(ip: string): void {
  vi.mocked(headers).mockResolvedValue({ get: () => ip } as never);
}

/**
 * Supabase falso: o encadeamento inteiro (`select(...).eq(...).maybeSingle()`,
 * `update(...).eq(...)`) devolve a si mesmo e o `await` resolve no resultado
 * passado. O teste fica preso ao contrato (linha → dado), não ao formato da query.
 */
function bancoFalso(resultado: { data: unknown; error: { message: string } | null }): void {
  const cadeia = new Proxy(
    {},
    {
      get(_alvo, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve(resultado);
        }
        return () => cadeia;
      },
    },
  ) as never;
  vi.mocked(createAdminClient).mockReturnValue({ from: () => cadeia } as never);
}

/** Linha de `api_tokens` como o lookup devolve (schema real, token morto ou vivo). */
function linhaDeToken(extra: { revoked_at?: string | null; expires_at?: string | null } = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "22222222-2222-4222-8222-222222222222",
    scopes: ["mcp:read"],
    revoked_at: null,
    expires_at: null,
    created_by: "33333333-3333-4333-8333-333333333333",
    ...extra,
  };
}

const SEM_TOKEN = { data: null, error: null };

/** Uma tentativa de autenticação, como dado: `tipo: "ok"` ou o erro do MCP. */
type Tentativa =
  | { tipo: "ok" }
  | { tipo: "falha"; mcpCode: number; httpStatus: number; message: string };

async function tentar(token: string | null, ip = "10.0.0.1"): Promise<Tentativa> {
  chamandoDe(ip);
  try {
    await auth.validateBearerToken(token === null ? null : `Bearer ${token}`);
    return { tipo: "ok" };
  } catch (err) {
    const e = err as { mcpCode?: number; httpStatus?: number; message?: string };
    return {
      tipo: "falha",
      mcpCode: e.mcpCode ?? NaN,
      httpStatus: e.httpStatus ?? NaN,
      message: e.message ?? "",
    };
  }
}

describe("validateBearerToken: teto de falhas (issue #1447)", () => {
  it("chute repetido: 5 recusas de 401 e a 6ª já é 429/-32004", async () => {
    bancoFalso(SEM_TOKEN);

    const tentativas: Tentativa[] = [];
    for (let i = 0; i < 7; i++) {
      tentativas.push(await tentar("dsk_chute_de_valor_fixo"));
    }

    for (const recusa of tentativas.slice(0, 5)) {
      expect(recusa).toMatchObject({ tipo: "falha", mcpCode: -32001, httpStatus: 401 });
    }
    expect(tentativas[5]).toMatchObject({ tipo: "falha", mcpCode: -32004, httpStatus: 429 });
    // E continua barrado enquanto a janela não passa.
    expect(tentativas[6]).toMatchObject({ tipo: "falha", mcpCode: -32004, httpStatus: 429 });
  });

  it("30 chutes DIFERENTES do mesmo IP caem pelo balde por origem", async () => {
    bancoFalso(SEM_TOKEN);

    const tentativas: Tentativa[] = [];
    for (let i = 0; i < 32; i++) {
      tentativas.push(await tentar(`dsk_chute_${i}`));
    }

    expect(tentativas[28]).toMatchObject({ tipo: "falha", mcpCode: -32001, httpStatus: 401 });
    expect(tentativas[30]).toMatchObject({ tipo: "falha", mcpCode: -32004, httpStatus: 429 });
  });

  it("trocar de IP a cada palpite não salva quem repete o MESMO valor", async () => {
    bancoFalso(SEM_TOKEN);

    const tentativas: Tentativa[] = [];
    for (let i = 0; i < 6; i++) {
      // IP novo a cada tentativa: cada origem fica com 1 falha, longe do teto.
      tentativas.push(await tentar("dsk_mesmo_valor_em_ips_diferentes", `10.7.7.${i}`));
    }

    expect(tentativas[4]).toMatchObject({ tipo: "falha", mcpCode: -32001, httpStatus: 401 });
    expect(tentativas[5]).toMatchObject({ tipo: "falha", mcpCode: -32004, httpStatus: 429 });
  });

  it("token válido em uso não paga imposto: 40 chamadas seguidas, nenhuma barrada", async () => {
    bancoFalso({ data: linhaDeToken(), error: null });

    for (let i = 0; i < 40; i++) {
      expect(await tentar("dsk_token_valido", "10.5.5.5")).toEqual({ tipo: "ok" });
    }
  });

  it("buraco de banco (lookup_failed) não tranca cliente: 40 falhas de 500 e zero 429", async () => {
    bancoFalso({ data: null, error: { message: "conexão recusada pelo pool" } });

    for (let i = 0; i < 40; i++) {
      expect(await tentar("dsk_token_valido", "10.6.6.6")).toMatchObject({
        tipo: "falha",
        mcpCode: -32603,
        httpStatus: 500,
      });
    }
  });

  it("token expirado debita só o balde do valor: a 6ª repetição é 429, mesmo trocando de IP", async () => {
    bancoFalso({ data: linhaDeToken({ expires_at: "2020-01-01T00:00:00.000Z" }), error: null });

    const tentativas: Tentativa[] = [];
    for (let i = 0; i < 6; i++) {
      tentativas.push(await tentar("dsk_token_expirado", `10.8.8.${i}`));
    }

    expect(tentativas[0]).toMatchObject({ tipo: "falha", mcpCode: -32001, httpStatus: 401 });
    expect(tentativas[4]).toMatchObject({ tipo: "falha", mcpCode: -32001, httpStatus: 401 });
    expect(tentativas[5]).toMatchObject({ tipo: "falha", mcpCode: -32004, httpStatus: 429 });
  });
});
