/**
 * "ORGANIZAÇÃO OPERANTE" TEM UMA RÉGUA SÓ — `lib/organizacao/operante.ts`.
 *
 * O predicado é `status = 'active'`. Toda DECISÃO sobre operar (redirect, fail,
 * return de gate, `if` que desvia, filtro de seleção por status de org) passa
 * por `ehOperante`/`idsDeOrgsParadas`/`assertOrgOperante` ou pela função SQL
 * `fn_org_operante`. Comparar o status da org com um literal é a segunda régua
 * nascendo: foi assim que as campanhas filtravam só `'suspended'` e deixavam
 * passar a org redigida.
 *
 * Mede AST, não texto: a prosa do repositório cita `status === 'active'` em
 * comentário o tempo todo, e SQL em string (outra tabela, ex.:
 * `lib/agent-engine/agent/org-memory.ts`) não é decisão desta régua.
 *
 * Fora do escopo, de propósito: exibição (JSX, badge) e o painel da plataforma
 * (`app/admin/**`, `app/api/v1/admin/**`), que decide TRANSIÇÃO de estado — ela
 * mora em `fn_suspender_organizacao`/`fn_reativar_organizacao`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const RAIZES = ["app", "lib", "workers"];
const A_REGUA = "lib/organizacao/operante.ts";
const TRANSICAO_DE_ESTADO = ["app/admin/", "app/api/v1/admin/"];
const STATUS_DE_ORG = new Set(["active", "suspended", "redacted", "archived"]);
const RECEPTOR_DE_ORG = /(^|[^a-z])org|Org|organi[sz]a[tcç]/;
const CHAMADAS_DE_DECISAO = new Set(["redirect", "fail", "notFound"]);
const FILTROS = new Set(["eq", "neq", "in", "not", "filter", "match"]);
const COMPARACOES = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Allowlist que só encolhe: cada entrada ainda tem de conter a decisão. */
const ALLOWLIST: Record<string, string> = {
  "app/actions/shell/setActiveOrg.ts": "troca de org só para ativa; molde anterior ao predicado",
};

function ehLiteralDeStatus(e: ts.Node): boolean {
  return (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && STATUS_DE_ORG.has(e.text);
}

function ehStatusDeOrg(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return e.text === "orgStatus" || e.text === "org_status";
  if (!ts.isPropertyAccessExpression(e)) return false;
  const nome = e.name.text;
  if (nome === "orgStatus" || nome === "org_status") return true;
  return nome === "status" && RECEPTOR_DE_ORG.test(e.expression.getText());
}

function ehComparacaoDeStatusDeOrg(no: ts.Node): no is ts.BinaryExpression {
  if (!ts.isBinaryExpression(no) || !COMPARACOES.has(no.operatorToken.kind)) return false;
  return (
    (ehStatusDeOrg(no.left) && ehLiteralDeStatus(no.right)) ||
    (ehStatusDeOrg(no.right) && ehLiteralDeStatus(no.left))
  );
}

function estaNumaDecisao(no: ts.Node): boolean {
  let filho: ts.Node = no;
  let pai = no.parent;
  while (pai && !ts.isSourceFile(pai) && !ts.isFunctionLike(pai)) {
    if (ts.isJsxExpression(pai)) return false; // exibição, não decisão
    if (ts.isReturnStatement(pai)) return true;
    if (ts.isIfStatement(pai) && pai.expression === filho) return true;
    if (
      ts.isCallExpression(pai) &&
      ts.isIdentifier(pai.expression) &&
      CHAMADAS_DE_DECISAO.has(pai.expression.text) &&
      pai.arguments.some((a) => a === filho)
    )
      return true;
    filho = pai;
    pai = pai.parent;
  }
  // arrow concisa: o corpo É o retorno
  return !!pai && ts.isArrowFunction(pai) && pai.body === filho;
}

function cadeiaVemDeOrganizations(e: ts.Expression): boolean {
  let atual: ts.Expression = e;
  for (;;) {
    if (ts.isCallExpression(atual)) {
      const [primeiro] = atual.arguments;
      if (
        ts.isPropertyAccessExpression(atual.expression) &&
        atual.expression.name.text === "from" &&
        primeiro !== undefined &&
        ts.isStringLiteral(primeiro) &&
        primeiro.text === "organizations"
      )
        return true;
      atual = atual.expression;
    } else if (ts.isPropertyAccessExpression(atual) || ts.isParenthesizedExpression(atual) || ts.isAwaitExpression(atual)) {
      atual = atual.expression;
    } else {
      return false;
    }
  }
}

function ehFiltroDeStatusDeOrg(no: ts.Node): boolean {
  if (!ts.isCallExpression(no) || !ts.isPropertyAccessExpression(no.expression)) return false;
  if (!FILTROS.has(no.expression.name.text)) return false;
  const [coluna, ...resto] = no.arguments;
  if (coluna === undefined || !ts.isStringLiteral(coluna)) return false;
  const colunaEmbutida = coluna.text === "organizations.status";
  if (!colunaEmbutida && coluna.text !== "status") return false;
  const temLiteral = resto.some(
    (a) => ehLiteralDeStatus(a) || (ts.isArrayLiteralExpression(a) && a.elements.some(ehLiteralDeStatus)),
  );
  return temLiteral && (colunaEmbutida || cadeiaVemDeOrganizations(no.expression.expression));
}

function decisoesPorStatusDeOrg(fonte: string, nome: string): number[] {
  const arquivo = ts.createSourceFile(
    nome,
    fonte,
    ts.ScriptTarget.Latest,
    true,
    nome.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const linhas: number[] = [];
  const visitar = (no: ts.Node): void => {
    if ((ehComparacaoDeStatusDeOrg(no) && estaNumaDecisao(no)) || ehFiltroDeStatusDeOrg(no)) {
      linhas.push(arquivo.getLineAndCharacterOfPosition(no.getStart(arquivo)).line + 1);
    }
    ts.forEachChild(no, visitar);
  };
  visitar(arquivo);
  return linhas;
}

function arquivosDe(dir: string): string[] {
  const saida: string[] = [];
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules") saida.push(...arquivosDe(rel));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      saida.push(rel);
    }
  }
  return saida;
}

function varrer(): Map<string, number[]> {
  const achados = new Map<string, number[]>();
  for (const raiz of RAIZES) {
    for (const rel of arquivosDe(raiz)) {
      if (rel === A_REGUA || TRANSICAO_DE_ESTADO.some((p) => rel.startsWith(p))) continue;
      const linhas = decisoesPorStatusDeOrg(readFileSync(join(RAIZ, rel), "utf8"), rel);
      if (linhas.length) achados.set(rel, linhas);
    }
  }
  return achados;
}

describe("a sonda (controles no próprio arquivo)", () => {
  it.each([
    [`if (orgRow?.status === "suspended") redirect("/account-suspended");`, "a.ts"],
    [`async function f(){ const { data } = await admin.from("organizations").select("id").eq("status", "suspended"); }`, "b.ts"],
    [`function g(org: { status: string }) { return org.status === "active"; }`, "c.ts"],
    [`db.from("user_organizations").select("x").eq("organizations.status", "active");`, "d.ts"],
    [`if (m.org_status !== "active") return fail("org_suspended", "x", 403);`, "e.ts"],
    [`if (currentOrg.status !== "active") redirect("/x");`, "l.ts"],
    [`if (activeOrg?.status === "suspended") redirect("/x");`, "m.ts"],
    [`const ok = rows.filter((m) => m.org_status === "active");`, "n.ts"],
    [`if (orgRow.status === "active") redirect("/x");`, "o.ts"],
    [`if (Organizacao.status === "active") redirect("/x");`, "p.ts"],
  ])("acusa decisão por literal: %s", (fonte, nome) => {
    expect(decisoesPorStatusDeOrg(fonte, nome)).toHaveLength(1);
  });

  it.each([
    [`if (!ehOperante(orgRow?.status)) redirect("/account-suspended");`, "f.ts"],
    [`if (user.support.status !== "active") redirect("/support-ended");`, "g.ts"],
    [`const sql = "select 1 from organizations where status = 'active'";`, "h.ts"],
    [`export const X = () => <p>{organization.status === "suspended" && "Suspensa"}</p>;`, "i.tsx"],
    [`admin.from("followup_flow_pointers").select("id").eq("status", "active");`, "j.ts"],
    [`// if (org.status === "active") redirect("/x")\nexport const y = 1;`, "k.ts"],
  ])("não acusa o que não é decisão por literal de org: %s", (fonte, nome) => {
    expect(decisoesPorStatusDeOrg(fonte, nome)).toEqual([]);
  });
});

describe("o repositório", () => {
  const achados = varrer();

  it("nenhuma decisão compara o status da org com literal fora da régua", () => {
    const fora = [...achados.entries()]
      .filter(([arquivo]) => !(arquivo in ALLOWLIST))
      .map(([arquivo, linhas]) => `${arquivo}:${linhas.join(",")}`);
    expect(
      fora,
      "Use ehOperante / idsDeOrgsParadas / assertOrgOperante (lib/organizacao/operante.ts) " +
        "ou fn_org_operante no SQL, em vez de comparar organizations.status com literal.",
    ).toEqual([]);
  });

  it("a allowlist só encolhe: cada entrada ainda contém a decisão, e diz por quê", () => {
    for (const [arquivo, motivo] of Object.entries(ALLOWLIST)) {
      expect(achados.has(arquivo), `${arquivo} já não decide por literal — tire da allowlist`).toBe(true);
      expect(motivo.trim().length).toBeGreaterThanOrEqual(20);
    }
  });
});
