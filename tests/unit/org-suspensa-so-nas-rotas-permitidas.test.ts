import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * ORG SUSPENSA SÓ PASSA NAS ROTAS DE LGPD E DE COBRANÇA
 * (spec docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §4 item 21).
 *
 * `requireRole({ permiteOrgSuspensa: true })` é a única porta de uma org parada
 * para a API de sessão. Pelo AST (comentário não conta):
 *  1. a chave só aparece em `app/api/v1/lgpd/**`, `app/api/v1/cobranca/**` e nos
 *     dois arquivos do MCP abaixo;
 *  2. TODA chamada de `requireRole(` em `app/api/v1/lgpd/**` a passa — LGPD
 *     nunca é bloqueada, nem para quem teve a conta suspensa;
 *  3. o `/api/mcp` a passa ao validar o token, e a ferramenta de privacidade a
 *     declara (decisão do dono, 30/09: a privacidade do MCP fica liberada para a
 *     empresa suspensa). Quem recusa as DEMAIS ferramentas é `lib/mcp/server.ts`,
 *     provado em `tests/unit/mcp-org-suspensa-so-a-lgpd.test.ts`.
 */
const MCP_ROTA = "app/api/mcp/route.ts";
const MCP_PRIVACIDADE = "lib/mcp/tools/privacidade.ts";
const PREFIXOS_PERMITIDOS = ["app/api/v1/lgpd/", "app/api/v1/cobranca/", MCP_ROTA, MCP_PRIVACIDADE] as const;
const DEFINICAO = "lib/auth/require-role.ts";

function arvore(fonte: string, arquivo: string): ts.SourceFile {
  return ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true,
    arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** `permiteOrgSuspensa` e `"permiteOrgSuspensa"` são a mesma chave. */
const eAChave = (nome: ts.PropertyName): boolean =>
  (ts.isIdentifier(nome) || ts.isStringLiteral(nome)) && nome.text === "permiteOrgSuspensa";

/** Linhas onde `permiteOrgSuspensa` aparece como propriedade de objeto. */
export function usosDaPermissao(fonte: string, arquivo: string): number[] {
  const sf = arvore(fonte, arquivo);
  const linhas: number[] = [];
  const visitar = (n: ts.Node): void => {
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && eAChave(n.name)) {
      linhas.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return linhas;
}

/** Chamadas de `requireRole(` cujo 2º argumento não é objeto literal com `permiteOrgSuspensa: true`. */
export function requireRoleSemPermissao(fonte: string, arquivo: string): number[] {
  const sf = arvore(fonte, arquivo);
  const linhas: number[] = [];
  const visitar = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "requireRole") {
      const opts = n.arguments[1];
      const libera = !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) =>
        ts.isPropertyAssignment(p) && eAChave(p.name) &&
        p.initializer.kind === ts.SyntaxKind.TrueKeyword);
      if (!libera) linhas.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return linhas;
}

const FONTES = arquivosDeCodigo(["app", "lib", "workers", "components", "hooks"]).map((abs) => ({
  arquivo: caminhoRelativo(abs),
  fonte: readFileSync(abs, "utf8"),
}));
const permitido = (arquivo: string) => PREFIXOS_PERMITIDOS.some((p) => arquivo.startsWith(p));
const LGPD = FONTES.filter((f) => f.arquivo.startsWith("app/api/v1/lgpd/"));

describe("org suspensa só nas rotas permitidas (a CLASSE)", () => {
  it("o instrumento enxerga o terreno (controle positivo)", () => {
    expect(FONTES.length).toBeGreaterThan(100);
    expect(LGPD.some((f) => f.fonte.includes("requireRole("))).toBe(true);
  });

  it("permiteOrgSuspensa não aparece fora de LGPD e cobrança", () => {
    const fora = FONTES.filter((f) => f.arquivo !== DEFINICAO && !permitido(f.arquivo))
      .flatMap((f) => usosDaPermissao(f.fonte, f.arquivo).map((l) => `${f.arquivo}:${l}`));
    expect(fora, "org parada passaria por uma rota que custa ou sai para fora").toEqual([]);
  });

  it("o /api/mcp abre a porta, e a ferramenta de privacidade a atravessa (decisão do dono, 30/09)", () => {
    for (const arquivo of [MCP_ROTA, MCP_PRIVACIDADE]) {
      const f = FONTES.find((x) => x.arquivo === arquivo);
      expect(f, `não achei ${arquivo}`).toBeDefined();
      expect(usosDaPermissao(f!.fonte, arquivo), `${arquivo} não passa permiteOrgSuspensa`).toHaveLength(1);
    }
  });

  it("toda requireRole de app/api/v1/lgpd/** libera a org suspensa", () => {
    const presas = LGPD.flatMap((f) => requireRoleSemPermissao(f.fonte, f.arquivo).map((l) => `${f.arquivo}:${l}`));
    expect(presas, "LGPD nunca é bloqueada (spec §1.3)").toEqual([]);
  });
});

describe("controles do instrumento", () => {
  it("acusa a chave fora do lugar e a requireRole de LGPD sem ela", () => {
    expect(usosDaPermissao(`requireRole("admin", { permiteOrgSuspensa: true });`, "x.ts")).toEqual([1]);
    expect(requireRoleSemPermissao(`requireRole("admin", { requestId });`, "x.ts")).toEqual([1]);
    expect(requireRoleSemPermissao(`requireRole("admin", { permiteOrgSuspensa: false });`, "x.ts")).toEqual([1]);
  });
  it("a chave entre aspas é a mesma chave, nas duas direções", () => {
    expect(usosDaPermissao(`requireRole("admin", { "permiteOrgSuspensa": true });`, "x.ts")).toEqual([1]);
    expect(requireRoleSemPermissao(`requireRole("admin", { 'permiteOrgSuspensa': true });`, "x.ts")).toEqual([]);
  });
  it("não confunde comentário com código", () => {
    expect(usosDaPermissao(`// requireRole(x, { permiteOrgSuspensa: true })\nexport const a = 1;`, "x.ts")).toEqual([]);
    expect(requireRoleSemPermissao(`requireRole("admin", { permiteOrgSuspensa: true });`, "x.ts")).toEqual([]);
  });
});
