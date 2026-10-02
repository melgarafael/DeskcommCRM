import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * ESCRITA DE PLATFORM ADMIN EXIGE SCOPE `full` — PELO MECANISMO, EM `app/**` INTEIRO
 * (spec docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §4,
 * "Scope support_readonly").
 *
 * `requirePlatformAdmin()` devolvia o scope e ninguém o impunha: um
 * `support_readonly` suspendia, reativava, resolvia incidente e disparava
 * atualização do servidor. Três regras, pelo AST (comentário não conta):
 *  A. handler exportado POST|PATCH|PUT|DELETE que chama `requirePlatformAdmin(`
 *     ou lê `.is_platform_admin` — no corpo ou numa função do MESMO arquivo que
 *     ele chama — precisa chamar `requirePlatformAdminEscrita(`;
 *  B. arquivo `"use server"` não importa `requirePlatformAdmin`, e, se lê
 *     `.is_platform_admin` (o atalho "platform admin pula o papel do tenant"),
 *     chama `escreveComoPlatformAdmin(` ou `requirePlatformAdminEscrita(`;
 *  C. `allowPlatformAdmin: "leitura"` só dentro de handler `GET` exportado;
 *  D. arquivo `"use server"` não chama `requirePlatformAdminEscrita(` direto:
 *     passa por `escritaDeAdminOuRecusa(`, que devolve a recusa como
 *     `{ok:false, error}`. O throw cru subia ao error boundary e a tela não
 *     dizia "somente leitura" nem "confirme a verificação em duas etapas".
 * O handler é visto como `export function`, `export const X = …` (alias ou
 * chamada) e `export { h as X }`; função local passada como argumento de
 * chamada (`comX(handle)`) é seguida.
 * Limite conhecido: helper IMPORTADO de outro arquivo não é seguido (nem o
 * re-export `export { X } from "./outro"`).
 */
const METODOS_DE_ESCRITA = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Allowlist que SÓ ENCOLHE. Chave `arquivo#regra:alvo`; valor = porquê (≥ 20 caracteres). */
const EXCECOES: Record<string, string> = {
  "app/api/v1/admin/tenants/[id]/impersonate/route.ts#A:POST":
    "abrir acompanhamento é o trabalho do support_readonly: fn_support_context rebaixa scope diferente de full a support_readonly, e a rota já confere mfaEmDivida",
  "app/actions/auth/politicaDeMfa.ts#B:flag":
    "lê is_platform_admin só para saber se a política de MFA da PLATAFORMA vale para a própria conta; não é atalho de papel nem escrita em nome de outro",
};

export interface Violacao {
  chave: string;
  linha: number;
}
// Qualquer inicializador de const de topo conta: `= handle` (alias) e `= comX(async () => …)` (chamada) também são handlers.
type Funcao = ts.Node;

function funcoesDoTopo(sf: ts.SourceFile): Map<string, { no: Funcao; exportada: boolean }> {
  const mapa = new Map<string, { no: Funcao; exportada: boolean }>();
  for (const st of sf.statements) {
    const exportada = !!(ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined)?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (ts.isFunctionDeclaration(st) && st.name) mapa.set(st.name.text, { no: st, exportada });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) mapa.set(d.name.text, { no: d.initializer, exportada });
      }
    }
  }
  // `export { h as POST }` / `export { DELETE }` (sem `from`): o nome exportado aponta para o local.
  // Segunda passada porque o `export { … }` pode vir antes da função que ele exporta.
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    for (const e of st.exportClause.elements) {
      const local = e.propertyName ?? e.name;
      if (!ts.isIdentifier(local)) continue;
      const alvo = mapa.get(local.text);
      if (local === e.name) {
        if (alvo) alvo.exportada = true;
      } else {
        mapa.set(e.name.text, { no: local, exportada: true }); // identificador nu = alias, seguido em oQueAlcanca
      }
    }
  }
  return mapa;
}

function oQueAlcanca(no: ts.Node, funcoes: ReturnType<typeof funcoesDoTopo>, visitadas: Set<string>) {
  const r = { chamaLeitura: false, leFlag: false, chamaEscrita: false, chamaAtalhoComScope: false };
  const seguir = (nome: string): void => {
    const local = funcoes.get(nome);
    if (!local || visitadas.has(nome)) return;
    visitadas.add(nome);
    const sub = oQueAlcanca(local.no, funcoes, visitadas);
    r.chamaLeitura ||= sub.chamaLeitura;
    r.leFlag ||= sub.leFlag;
    r.chamaEscrita ||= sub.chamaEscrita;
    r.chamaAtalhoComScope ||= sub.chamaAtalhoComScope;
  };
  const visitar = (n: ts.Node): void => {
    // alias `export const POST = handle` / `export { handle as POST }`: o identificador nu aponta para a função de topo
    if (ts.isIdentifier(n) && n === no) seguir(n.text);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const nome = n.expression.text;
      if (nome === "requirePlatformAdmin") r.chamaLeitura = true;
      if (nome === "requirePlatformAdminEscrita" || nome === "escritaDeAdminOuRecusa") r.chamaEscrita = true;
      if (nome === "escreveComoPlatformAdmin") r.chamaAtalhoComScope = true;
      seguir(nome);
    }
    // `comX(handle)`: a função local passada como argumento também roda
    if (ts.isCallExpression(n)) for (const a of n.arguments) if (ts.isIdentifier(a)) seguir(a.text);
    if (ts.isPropertyAccessExpression(n) && n.name.text === "is_platform_admin") r.leFlag = true;
    ts.forEachChild(n, visitar);
  };
  visitar(no);
  return r;
}

export function violacoesDeEscrita(fonte: string, arquivo: string): Violacao[] {
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true,
    arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const funcoes = funcoesDoTopo(sf);
  const linha = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const saida: Violacao[] = [];

  for (const [nome, { no, exportada }] of funcoes) {
    if (!exportada || !METODOS_DE_ESCRITA.has(nome)) continue;
    const r = oQueAlcanca(no, funcoes, new Set([nome]));
    if ((r.chamaLeitura || r.leFlag) && !r.chamaEscrita) saida.push({ chave: `${arquivo}#A:${nome}`, linha: linha(no) });
  }

  const primeira = sf.statements[0];
  const usaServer = !!primeira && ts.isExpressionStatement(primeira) &&
    ts.isStringLiteral(primeira.expression) && primeira.expression.text === "use server";
  if (usaServer) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) ||
          st.moduleSpecifier.text !== "@/lib/auth/requirePlatformAdmin") continue;
      const nomes = st.importClause?.namedBindings;
      if (nomes && ts.isNamedImports(nomes) &&
          nomes.elements.some((e) => (e.propertyName ?? e.name).text === "requirePlatformAdmin")) {
        saida.push({ chave: `${arquivo}#B:use-server`, linha: linha(st) });
      }
    }
    // O atalho de papel: toda server action é endpoint público, e ler só a
    // flag deixa o support_readonly escrever onde é membro comum.
    const doArquivo = oQueAlcanca(sf, funcoes, new Set());
    if (doArquivo.leFlag && !doArquivo.chamaEscrita && !doArquivo.chamaAtalhoComScope) {
      saida.push({ chave: `${arquivo}#B:flag`, linha: 1 });
    }
    const visitarD = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "requirePlatformAdminEscrita") {
        saida.push({ chave: `${arquivo}#D:throw`, linha: linha(n) });
      }
      ts.forEachChild(n, visitarD);
    };
    visitarD(sf);
  }

  const visitar = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "allowPlatformAdmin" &&
        ts.isStringLiteral(n.initializer) && n.initializer.text === "leitura") {
      const dono = [...funcoes].find(([, f]) => f.no.pos <= n.pos && n.end <= f.no.end);
      if (!dono || dono[0] !== "GET" || !dono[1].exportada) saida.push({ chave: `${arquivo}#C:leitura`, linha: linha(n) });
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return saida;
}

const FONTES = arquivosDeCodigo(["app"]).map((abs) => ({ arquivo: caminhoRelativo(abs), fonte: readFileSync(abs, "utf8") }));
const VIOLACOES = FONTES.flatMap(({ arquivo, fonte }) => violacoesDeEscrita(fonte, arquivo));

describe("escrita de platform admin exige scope full (a CLASSE)", () => {
  it("o instrumento enxerga o terreno (controle positivo)", () => {
    expect(FONTES.length).toBeGreaterThan(100);
    expect(FONTES.some(({ fonte }) => fonte.includes('allowPlatformAdmin: "leitura"'))).toBe(true);
    expect(FONTES.some(({ fonte }) => fonte.includes("requirePlatformAdmin("))).toBe(true);
  });

  it("nenhuma violação fora da allowlist", () => {
    const fora = VIOLACOES.filter((v) => !(v.chave in EXCECOES)).map((v) => `${v.chave} (linha ${v.linha})`);
    expect(fora, "support_readonly não escreve: rota usa requirePlatformAdminEscrita; server action (D), escritaDeAdminOuRecusa").toEqual([]);
  });

  it("a allowlist só encolhe: toda exceção ainda viola e tem porquê", () => {
    const chaves = new Set(VIOLACOES.map((v) => v.chave));
    for (const [chave, porque] of Object.entries(EXCECOES)) {
      expect(chaves.has(chave), `${chave} não viola mais — tire da allowlist`).toBe(true);
      expect(porque.length, chave).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("controles do instrumento", () => {
  const imp = `import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";`;
  it("A: POST que chama requirePlatformAdmin sem a de escrita é acusado; GET não", () => {
    expect(violacoesDeEscrita(`${imp}\nexport async function POST() { await requirePlatformAdmin(); }`, "r.ts")).toHaveLength(1);
    expect(violacoesDeEscrita(`${imp}\nexport async function GET() { await requirePlatformAdmin(); }`, "r.ts")).toEqual([]);
  });
  it("A: lê .is_platform_admin por helper do mesmo arquivo, e export const também é visto", () => {
    const fonte = `async function gate(u: { is_platform_admin: boolean }) { return u.is_platform_admin; }
      export const PATCH = async () => gate({ is_platform_admin: true });`;
    expect(violacoesDeEscrita(fonte, "r.ts").map((v) => v.chave)).toEqual(["r.ts#A:PATCH"]);
  });
  it("A: POST que chama requirePlatformAdminEscrita passa", () => {
    expect(violacoesDeEscrita(`export async function POST() { await requirePlatformAdminEscrita(); }`, "r.ts")).toEqual([]);
  });
  it("A: alias `export const POST = handle` e chamada `= comAlgo(async () => …)` são vistos", () => {
    const alias = (f: string) => `async function handle() { await ${f}(); }\nexport const POST = handle;`;
    const chamada = (f: string) => `export const POST = comAlgo(async () => { await ${f}(); });`;
    expect(violacoesDeEscrita(alias("requirePlatformAdmin"), "r.ts").map((v) => v.chave)).toEqual(["r.ts#A:POST"]);
    expect(violacoesDeEscrita(chamada("requirePlatformAdmin"), "r.ts").map((v) => v.chave)).toEqual(["r.ts#A:POST"]);
    expect(violacoesDeEscrita(alias("requirePlatformAdminEscrita"), "r.ts")).toEqual([]);
    expect(violacoesDeEscrita(chamada("requirePlatformAdminEscrita"), "r.ts")).toEqual([]);
  });
  it("A: `= comX(handle)` segue o handle passado como argumento", () => {
    const embrulho = (f: string) => `async function handle() { await ${f}(); }\nexport const POST = comX(handle);`;
    expect(violacoesDeEscrita(embrulho("requirePlatformAdmin"), "r.ts").map((v) => v.chave)).toEqual(["r.ts#A:POST"]);
    expect(violacoesDeEscrita(embrulho("requirePlatformAdminEscrita"), "r.ts")).toEqual([]);
  });
  it("A: `export { h as POST }` e `export { DELETE }` são handlers exportados", () => {
    const renomeado = (f: string) => `export { h as POST };\nasync function h() { await ${f}(); }`;
    expect(violacoesDeEscrita(renomeado("requirePlatformAdmin"), "r.ts").map((v) => v.chave)).toEqual(["r.ts#A:POST"]);
    expect(violacoesDeEscrita(renomeado("requirePlatformAdminEscrita"), "r.ts")).toEqual([]);
    const tardio = `async function DELETE() { await requirePlatformAdmin(); }\nexport { DELETE };`;
    expect(violacoesDeEscrita(tardio, "r.ts").map((v) => v.chave)).toEqual(["r.ts#A:DELETE"]);
  });
  it("B: 'use server' que importa requirePlatformAdmin é acusado; a de escrita passa", () => {
    expect(violacoesDeEscrita(`"use server";\n${imp}`, "a.ts")).toHaveLength(1);
    expect(violacoesDeEscrita(`"use server";\nimport { requirePlatformAdminEscrita } from "@/lib/auth/requirePlatformAdmin";`, "a.ts")).toEqual([]);
  });
  it("B: 'use server' que pula o papel por .is_platform_admin é acusado; com escreveComoPlatformAdmin passa", () => {
    const atalho = `"use server";\nexport async function salvar(u: { is_platform_admin: boolean }, papel: number) { if (!u.is_platform_admin && papel < 4) return; }`;
    expect(violacoesDeEscrita(atalho, "a.ts").map((v) => v.chave)).toEqual(["a.ts#B:flag"]);
    const comScope = `"use server";\nexport async function salvar(u: { is_platform_admin: boolean }, papel: number) { if (!escreveComoPlatformAdmin(u) && papel < 4) return; void u.is_platform_admin; }`;
    expect(violacoesDeEscrita(comScope, "a.ts")).toEqual([]);
    // Fora de "use server" a regra B não vale (a A cobre os handlers de rota).
    expect(violacoesDeEscrita(atalho.replace('"use server";\n', ""), "a.ts")).toEqual([]);
  });
  it("D: 'use server' que chama requirePlatformAdminEscrita direto é acusado; pelo wrapper passa", () => {
    const direto = `"use server";\nexport async function salvar() { const { user } = await requirePlatformAdminEscrita(); return user; }`;
    expect(violacoesDeEscrita(direto, "a.ts").map((v) => v.chave)).toEqual(["a.ts#D:throw"]);
    const pelaRecusa = `"use server";\nexport async function salvar() { const g = await escritaDeAdminOuRecusa(); if (!g.ok) return g; }`;
    expect(violacoesDeEscrita(pelaRecusa, "a.ts")).toEqual([]);
    // Rota de API segue com o helper direto + falhaDaEscritaDePlatformAdmin.
    expect(violacoesDeEscrita(direto.replace('"use server";\n', ""), "a.ts")).toEqual([]);
  });
  it("B: o wrapper conta como escrita para o atalho de .is_platform_admin", () => {
    const fonte = `"use server";\nexport async function salvar(u: { is_platform_admin: boolean }) { await escritaDeAdminOuRecusa(); return u.is_platform_admin; }`;
    expect(violacoesDeEscrita(fonte, "a.ts")).toEqual([]);
  });
  it("C: 'leitura' em POST ou em helper é acusado; em GET passa", () => {
    expect(violacoesDeEscrita(`export async function POST() { requireRole("admin", { allowPlatformAdmin: "leitura" }); }`, "r.ts")).toHaveLength(1);
    expect(violacoesDeEscrita(`async function h() { requireRole("admin", { allowPlatformAdmin: "leitura" }); }\nexport async function GET() { return h(); }`, "r.ts")).toHaveLength(1);
    expect(violacoesDeEscrita(`export async function GET() { requireRole("admin", { allowPlatformAdmin: "leitura" }); }`, "r.ts")).toEqual([]);
  });
  it("comentário não conta (controle do controle)", () => {
    expect(violacoesDeEscrita(`// export async function POST() { await requirePlatformAdmin(); }\nexport const x = 1;`, "r.ts")).toEqual([]);
  });
});
