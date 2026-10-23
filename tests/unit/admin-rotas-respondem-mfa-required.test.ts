// @vitest-environment node
import { readFileSync } from "node:fs";

import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { NextRequest } from "next/server";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * AS ROTAS DE `/api/v1/admin` DIZEM `mfa_required` A QUEM TEM FATOR E NÃO O PROVOU.
 *
 * O guarda (`requirePlatformAdmin`) pede a prova a quem tem fator cadastrado,
 * com a política da plataforma ligada ou não — a mesma regra de `mfaEmDivida`.
 * Na tela isso é o redirect ao desafio; na rota, o 403 `mfa_required` que a
 * escrita já devolvia. Leitura e escrita respondem o mesmo código, e quem não é
 * platform admin segue com `forbidden`.
 *
 * Executa as rotas REAIS com o guarda e o `redirect()` do Next reais; o que
 * varia é o que o Supabase responde sobre a pessoa e a sessão.
 */
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// O `x-pathname` que o `proxy.ts` grava; o guarda monta dele o `next` do desafio.
const cabecalho = vi.hoisted(() => ({ caminho: "/admin" }));
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers({ "x-pathname": cabecalho.caminho }),
}));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: async () => null,
}));

const U = "11111111-1111-4111-8111-111111111111";
const INCIDENTE = "33333333-3333-4333-8333-333333333333";
const linha = { user_id: U, scope: "full", mfa_required: false, revoked_at: null };

function sessao(o: { fator: boolean; nivel: "aal1" | "aal2"; admin: unknown }) {
  const consulta: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is"]) consulta[m] = () => consulta;
  consulta.maybeSingle = async () => ({ data: o.admin, error: null });
  vi.mocked(createClient).mockResolvedValue({
    from: () => consulta,
    auth: {
      getUser: async () => ({
        data: { user: { id: U, factors: o.fator ? [{ factor_type: "totp", status: "verified" }] : [] } },
        error: null,
      }),
      mfa: {
        listFactors: async () => ({
          data: { totp: o.fator ? [{ status: "verified" }] : [] },
          error: null,
        }),
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: o.nivel }, error: null }),
      },
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
}

async function leitura() {
  const { GET } = await import("@/app/api/v1/admin/users/route");
  return GET(new NextRequest("https://crm.exemplo/api/v1/admin/users"));
}

async function escrita() {
  const { POST } = await import("@/app/api/v1/admin/incidents/[id]/resolve/route");
  return POST(
    new NextRequest(`https://crm.exemplo/api/v1/admin/incidents/${INCIDENTE}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution_note: "resolvido no teste" }),
    }),
    { params: Promise.resolve({ id: INCIDENTE }) },
  );
}

async function codigo(r: Response): Promise<[number, unknown]> {
  return [r.status, ((await r.json()) as { error?: { code?: string } }).error?.code];
}

beforeEach(() => {
  vi.clearAllMocks();
  cabecalho.caminho = "/admin";
});

describe("fator verificado + sessão aal1, política da plataforma desligada", () => {
  beforeEach(() => sessao({ fator: true, nivel: "aal1", admin: linha }));

  it("leitura (GET) → 403 mfa_required", async () => {
    expect(await codigo(await leitura())).toEqual([403, "mfa_required"]);
  });

  it("escrita (POST) → 403 mfa_required", async () => {
    expect(await codigo(await escrita())).toEqual([403, "mfa_required"]);
  });

  it("na TELA o mesmo erro é o redirect do Next ao desafio, de volta à página", async () => {
    cabecalho.caminho = "/admin/incidents/33333333-3333-4333-8333-333333333333";
    const { requirePlatformAdmin } = await import("@/lib/auth/requirePlatformAdmin");
    const erro: unknown = await requirePlatformAdmin().then(() => null, (e: unknown) => e);
    expect(isRedirectError(erro)).toBe(true);
    if (isRedirectError(erro)) expect(getURLFromRedirectError(erro)).toBe(
        `/login/mfa?next=${encodeURIComponent(cabecalho.caminho)}`,
      );
  });
});

describe("os outros lados", () => {
  it("política da plataforma ligada e sessão aal1: leitura e escrita → mfa_required", async () => {
    sessao({ fator: false, nivel: "aal1", admin: { ...linha, mfa_required: true } });
    expect(await codigo(await leitura())).toEqual([403, "mfa_required"]);
    expect(await codigo(await escrita())).toEqual([403, "mfa_required"]);
  });

  it("controle: quem não é platform admin segue com forbidden, nos dois", async () => {
    sessao({ fator: true, nivel: "aal1", admin: null });
    expect(await codigo(await leitura())).toEqual([403, "forbidden"]);
    expect(await codigo(await escrita())).toEqual([403, "forbidden"]);
  });

  it("controle: fator provado nesta sessão → o guarda deixa passar", async () => {
    sessao({ fator: true, nivel: "aal2", admin: linha });
    const { requirePlatformAdmin } = await import("@/lib/auth/requirePlatformAdmin");
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ platformAdmin: { scope: "full" } });
  });
});

/**
 * Toda rota que chama o guarda dentro de um `try` traduz o que ele lança pela
 * recusa nomeada (`falhaDaEscritaDePlatformAdmin` ou `instanceof
 * EscritaDePlatformAdminNegada`). Um `catch { fail("forbidden") }` engolia o
 * `mfa_required` e devolvia `forbidden`.
 */
describe("cerca: o catch do guarda não engole a recusa nomeada", () => {
  const GUARDAS = new Set(["requirePlatformAdmin", "requirePlatformAdminEscrita"]);
  const TRADUTORES = new Set(["falhaDaEscritaDePlatformAdmin", "EscritaDePlatformAdminNegada"]);

  function contem(no: ts.Node, nomes: Set<string>, soChamada: boolean): boolean {
    let achou = false;
    const visita = (n: ts.Node): void => {
      if (achou) return;
      if (soChamada && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && nomes.has(n.expression.text)) achou = true;
      if (!soChamada && ts.isIdentifier(n) && nomes.has(n.text)) achou = true;
      ts.forEachChild(n, visita);
    };
    visita(no);
    return achou;
  }

  const rotas = arquivosDeCodigo(["app/api"]).filter((f) => f.endsWith("/route.ts"));
  const guardados: { arquivo: string; traduz: boolean }[] = [];
  for (const arquivo of rotas) {
    const sf = ts.createSourceFile(arquivo, readFileSync(arquivo, "utf-8"), ts.ScriptTarget.Latest, true);
    const visita = (n: ts.Node): void => {
      if (ts.isTryStatement(n) && n.catchClause && contem(n.tryBlock, GUARDAS, true)) {
        guardados.push({ arquivo: caminhoRelativo(arquivo), traduz: contem(n.catchClause, TRADUTORES, false) });
      }
      ts.forEachChild(n, visita);
    };
    visita(sf);
  }

  it("controle positivo: a varredura acha as rotas de admin", () => {
    expect(guardados.length).toBeGreaterThanOrEqual(30);
  });

  it("nenhum catch devolve forbidden por conta própria", () => {
    expect(guardados.filter((g) => !g.traduz).map((g) => g.arquivo)).toEqual([]);
  });
});
