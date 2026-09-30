import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * ROTA DE API NÃO USA `resolveActiveOrg` — empresa suspensa responde 403, não 307.
 * (issue #2001, pós-PR #1987)
 *
 * `resolveActiveOrg` redireciona (`redirect("/account-suspended")`) quando a
 * organização não opera. Em página isso leva o operador ao hub; em rota de API
 * vira um 307 para HTML, e o cliente (`lib/api/client.ts`) não vai a lugar
 * nenhum. Rota de API resolve a org por `orgAtivaSemPortao` (+ a guarda
 * `respostaDeOrgSuspensa`) e responde 403 `org_suspended` em JSON.
 *
 * Esta cerca mede por AST (comentário e prosa não contam): nenhum identificador
 * `resolveActiveOrg` pode aparecer em código em `app/api/**`. Os usos legítimos
 * ficam em páginas/server actions (`app/app/**`) e em `lib/auth/server.ts`
 * (definição) / `lib/auth/require-role.ts` (docstring da sem-gera externa).
 */
const FONTES = arquivosDeCodigo(["app"])
  .map((abs) => ({ arquivo: caminhoRelativo(abs), fonte: readFileSync(abs, "utf8") }))
  .filter((f) => f.arquivo.startsWith("app/api/"));

function arvore(fonte: string, arquivo: string): ts.SourceFile {
  return ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true,
    arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Linhas onde o identificador `resolveActiveOrg` é usado como código (chamada, import, bind). */
export function usosDeResolveActiveOrg(fonte: string, arquivo: string): number[] {
  const sf = arvore(fonte, arquivo);
  const linhas: number[] = [];
  const visitar = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === "resolveActiveOrg") {
      linhas.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return linhas;
}

describe("rotas de API usam o caminho que responde 403 org_suspended, não o 307", () => {
  it("o instrumento enxerga o terreno (controle positivo)", () => {
    expect(FONTES.length).toBeGreaterThan(50);
    expect(usosDeResolveActiveOrg(`import { resolveActiveOrg } from "@/lib/auth/server";\nexport const a = 1;`, "x.ts")).toEqual([1]);
    expect(usosDeResolveActiveOrg(`const org = await resolveActiveOrg(user);`, "y.ts")).toEqual([1]);
  });

  it("nenhum arquivo de app/api usa resolveActiveOrg em código", () => {
    const foras = FONTES.flatMap((f) =>
      usosDeResolveActiveOrg(f.fonte, f.arquivo).map((l) => `${f.arquivo}:${l}`),
    );
    expect(
      foras,
      "resolveActiveOrg redireciona (307 HTML); use orgAtivaSemPortao + respostaDeOrgSuspensa " +
        "(403 org_suspended) em rota de API.",
    ).toEqual([]);
  });

  it("comentário e prosa mencionando o helper não contam", () => {
    expect(usosDeResolveActiveOrg(`// resolveActiveOrg redireciona ao hub\nexport const a = 1;`, "z.ts")).toEqual([]);
  });
});