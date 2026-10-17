/**
 * ARQUIVO "use server" SÓ EXPORTA FUNÇÃO ASYNC.
 *
 * O Next recusa, no `next start`, o módulo de Server Actions que exporta outra
 * coisa: "A 'use server' file can only export async functions, found object".
 * E recusa o MÓDULO INTEIRO — todas as actions do arquivo param de responder.
 *
 * Foi o que a prova pela tela achou no #2809: `updateTaskReminderPrefs.ts`
 * exportava a schema Zod ao lado das duas actions. typecheck, lint, test:unit e
 * o CI inteiro ficaram verdes — nenhum deles carrega o módulo pelo runtime de
 * Server Actions —, e na tela a preferência nunca gravava, sem erro nenhum.
 *
 * O conserto de cada caso é mover o valor para um módulo comum (sem a diretiva)
 * e importar de lá. Tipo (`export type`, `export interface`) pode ficar: some
 * na compilação.
 *
 * Ancorado no AST, não em regex: a prosa do repositório cita "use server" e
 * `export const` em comentário o tempo todo.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const DIRETORIOS = ["app", "lib", "components", "hooks", "workers"];

function arquivosTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const caminho = join(dir, e.name);
    if (e.isDirectory()) return arquivosTs(caminho);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [caminho] : [];
  });
}

function temDiretivaUseServer(arquivo: ts.SourceFile): boolean {
  for (const st of arquivo.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) return false;
    if (st.expression.text === "use server") return true;
  }
  return false;
}

const ehAsync = (no: ts.Node): boolean =>
  ts.canHaveModifiers(no) &&
  (ts.getModifiers(no) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

const exportado = (no: ts.Node): boolean =>
  ts.canHaveModifiers(no) &&
  (ts.getModifiers(no) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const funcaoAsync = (expr: ts.Expression | undefined): boolean =>
  !!expr && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) && ehAsync(expr);

/** Os nomes exportados que NÃO são função async, no fonte de um arquivo "use server". */
export function exportacoesProibidas(fonte: string, nome: string): string[] {
  const arquivo = ts.createSourceFile(nome, fonte, ts.ScriptTarget.Latest, true);
  if (!temDiretivaUseServer(arquivo)) return [];

  const locaisAsync = new Set<string>();
  for (const st of arquivo.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && ehAsync(st)) locaisAsync.add(st.name.text);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && funcaoAsync(d.initializer)) locaisAsync.add(d.name.text);
      }
    }
  }

  const proibidas: string[] = [];
  for (const st of arquivo.statements) {
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
    if (ts.isFunctionDeclaration(st) && exportado(st)) {
      if (!ehAsync(st)) proibidas.push(st.name?.text ?? "default");
    } else if (ts.isVariableStatement(st) && exportado(st)) {
      for (const d of st.declarationList.declarations) {
        if (!funcaoAsync(d.initializer)) proibidas.push(d.name.getText(arquivo));
      }
    } else if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      const elementos = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : null;
      // `export * from` / `export { x } from "..."`: o valor vem de outro
      // módulo e daqui não se prova que é função async.
      if (!elementos || st.moduleSpecifier) {
        proibidas.push(st.getText(arquivo));
        continue;
      }
      for (const el of elementos) {
        if (el.isTypeOnly) continue;
        if (!locaisAsync.has((el.propertyName ?? el.name).text)) proibidas.push(el.name.text);
      }
    } else if (ts.isExportAssignment(st)) {
      if (!funcaoAsync(st.expression) && !(ts.isIdentifier(st.expression) && locaisAsync.has(st.expression.text))) {
        proibidas.push("default");
      }
    } else if (exportado(st)) {
      proibidas.push(ts.SyntaxKind[st.kind]); // class, enum, namespace
    }
  }
  return proibidas;
}

describe('arquivo "use server" só exporta função async', () => {
  it("o detector acusa o formato do defeito do #2809 e aceita o formato certo", () => {
    const defeito = `"use server";
import { z } from "zod";
export const schema = z.object({});
export async function gravar() {}`;
    expect(exportacoesProibidas(defeito, "a.ts")).toEqual(["schema"]);

    const certo = `"use server";
export type Resposta = { ok: boolean };
export interface Erro { codigo: string }
export async function gravar() {}
export const carregar = async () => 1;
const interna = async () => 2;
export { interna };`;
    expect(exportacoesProibidas(certo, "b.ts")).toEqual([]);

    expect(exportacoesProibidas(`"use server";\nexport function sincrona() {}`, "c.ts")).toEqual(["sincrona"]);
    // Sem a diretiva no topo do módulo, a regra não se aplica.
    expect(exportacoesProibidas(`export const x = 1;`, "d.ts")).toEqual([]);
  });

  it("nenhum arquivo do repositório com a diretiva exporta outra coisa", () => {
    const comDiretiva: string[] = [];
    const violacoes: string[] = [];
    for (const dir of DIRETORIOS) {
      for (const caminho of arquivosTs(join(RAIZ, dir))) {
        const fonte = readFileSync(caminho, "utf8");
        if (!fonte.includes("use server")) continue;
        const rel = relative(RAIZ, caminho);
        const arquivo = ts.createSourceFile(rel, fonte, ts.ScriptTarget.Latest, true);
        if (!temDiretivaUseServer(arquivo)) continue;
        comDiretiva.push(rel);
        for (const nome of exportacoesProibidas(fonte, rel)) violacoes.push(`${rel}: ${nome}`);
      }
    }
    // Varredura que não acha arquivo nenhum seria um verde sem medição.
    expect(comDiretiva.length).toBeGreaterThan(0);
    expect(violacoes).toEqual([]);
  });
});
