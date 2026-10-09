import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * ROTA DE API NÃO REDIRECIONA A EMPRESA SUSPENSA: RESPONDE 403 `org_suspended`
 * (spec docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §4;
 * acabamentos do PR 1, itens 6 e 23).
 *
 * `resolveActiveOrg` faz `redirect("/account-suspended")` — certo para página,
 * errado para rota de API: o `fetch` segue o 307 e entrega o HTML da página à
 * tela como se fosse o dado. A rota usa `orgAtivaDaApi` (lib/auth/require-role.ts),
 * que responde o mesmo 403 JSON de `requireRole`, e o cliente
 * (lib/api/client.ts) leva a janela ao hub.
 *
 * Duas direções, pelo AST (comentário não conta):
 *  1. `resolveActiveOrg` não aparece em `app/api/**`;
 *  2. `orgAtivaSemPortao` — a org SEM o portão — só aparece em `app/api/**`
 *     onde ver a org parada é o objetivo. Sem esta direção, o conserto "óbvio"
 *     de quem topar com o 307 seria trocar pela variante sem portão e abrir a
 *     rota para a empresa suspensa.
 */
const SEM_PORTAO_PERMITIDO = new Map<string, string>([
  [
    "app/api/v1/admin/tenants/[id]/impersonate/route.ts",
    "só GUARDA para qual org voltar ao fim do acompanhamento; a do admin pode estar suspensa",
  ],
]);

/** Linhas onde o identificador aparece no código (import, chamada, referência). */
export function usosDoIdentificador(fonte: string, arquivo: string, nome: string): number[] {
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true,
    arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const linhas: number[] = [];
  const visitar = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === nome) {
      linhas.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return linhas;
}

const API = arquivosDeCodigo(["app/api"]).map((abs) => ({
  arquivo: caminhoRelativo(abs),
  fonte: readFileSync(abs, "utf8"),
}));

const acusar = (nome: string, pular: (arquivo: string) => boolean = () => false) =>
  API.filter((f) => !pular(f.arquivo))
    .flatMap((f) => usosDoIdentificador(f.fonte, f.arquivo, nome).map((l) => `${f.arquivo}:${l}`));

describe("rota de API não redireciona org suspensa (a CLASSE)", () => {
  it("o instrumento enxerga o terreno (controle positivo)", () => {
    expect(API.length).toBeGreaterThan(100);
    // Basta enxergar o identificador: um piso perto da contagem do dia (era
    // 20, exatamente o que a main tinha) reprovava quem troca `orgAtivaDaApi`
    // pelo portão mais forte, `requireRole` — medido no #2456, na rota de
    // modelos. Quem diz se as rotas estão certas são os dois casos abaixo.
    expect(API.filter((f) => usosDoIdentificador(f.fonte, f.arquivo, "orgAtivaDaApi").length > 0).length)
      .toBeGreaterThan(0);
  });

  it("nenhuma rota de app/api usa resolveActiveOrg (redirect vira 307 HTML no fetch)", () => {
    expect(acusar("resolveActiveOrg"), "use orgAtivaDaApi: 403 org_suspended em JSON").toEqual([]);
  });

  it("orgAtivaSemPortao só onde enxergar a org parada é o objetivo", () => {
    expect(acusar("orgAtivaSemPortao", (a) => SEM_PORTAO_PERMITIDO.has(a)),
      "a variante sem portão abre a rota para a empresa suspensa").toEqual([]);
  });

  it("a allowlist não guarda arquivo que já não precisa dela (só encolhe)", () => {
    const mortas = [...SEM_PORTAO_PERMITIDO.keys()].filter((a) => {
      const f = API.find((x) => x.arquivo === a);
      return !f || usosDoIdentificador(f.fonte, a, "orgAtivaSemPortao").length === 0;
    });
    expect(mortas).toEqual([]);
  });
});

describe("controles do instrumento", () => {
  it("acusa import e chamada", () => {
    const fonte = `import { resolveActiveOrg } from "@/lib/auth/server";\nconst o = await resolveActiveOrg(u);`;
    expect(usosDoIdentificador(fonte, "x.ts", "resolveActiveOrg")).toEqual([1, 2]);
  });
  it("não confunde comentário nem string com código", () => {
    const fonte = `// resolveActiveOrg(user)\n/** \`resolveActiveOrg\` redireciona */\nconst s = "resolveActiveOrg";`;
    expect(usosDoIdentificador(fonte, "x.ts", "resolveActiveOrg")).toEqual([]);
  });
});
