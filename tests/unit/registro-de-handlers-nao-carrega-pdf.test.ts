/**
 * Registrar os handlers do event_log NÃO pode arrastar a cadeia do PDF.
 *
 * `@react-pdf/renderer` puxa `@react-pdf/textkit`, que faz
 * `require('@react-pdf/hyphenate/en-us')`. Aquele pacote declara `exports` só
 * com `import`, sem `require` — e o worker roda por `tsx`, que resolve em CJS.
 * Resultado: o módulo não carrega.
 *
 * Enquanto `lgpd-export-worker.ts` importava o renderizador no topo, essa
 * falha subia por `register-handlers.ts` e caía no `try/catch` de
 * `lib/event-log/drain-loop.ts` — um catch escrito para "não derrubar o
 * worker" que, na prática, desligava os QUATORZE handlers de uma vez. Medido
 * na instalação do piloto em 10/09/2026: "event-log drain OFF" em 7 de 7
 * inicializações, com mídia, follow-up, automações e notificações sobrevivendo
 * só pelo cron de 1×/min.
 *
 * O defeito é de ACOPLAMENTO, não do pacote de terceiros: um handler que não
 * carrega deve derrubar a si mesmo, nunca o registro inteiro.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/** Especificadores de import ESTÁTICO de um arquivo (dynamic import fica de fora). */
function importsEstaticos(arquivo: string): string[] {
  const texto = readFileSync(join(RAIZ, arquivo), "utf8");
  const fonte = ts.createSourceFile(arquivo, texto, ts.ScriptTarget.Latest, true);
  const achados: string[] = [];
  const visitar = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      // `import type` some na compilação e não carrega módulo nenhum.
      const soTipo = n.importClause?.isTypeOnly === true;
      if (!soTipo) achados.push(n.moduleSpecifier.text);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(fonte);
  return achados;
}

describe("o registro de handlers não carrega a cadeia do PDF", () => {
  it("o worker de export de LGPD não importa o renderizador no topo", () => {
    const estaticos = importsEstaticos("workers/lgpd-export-worker.ts");
    expect(
      estaticos.filter((e) => e.includes("lgpd/pdf-renderer")),
      "importe `@/lib/lgpd/pdf-renderer` DENTRO da função (await import) — no topo, " +
        "ele derruba os 14 handlers do event_log no boot do worker",
    ).toEqual([]);
  });

  it("o renderizador segue sendo usado por lá — a correção não pode ter virado remoção", () => {
    // Sem esta guarda, apagar o PDF do export deixaria o teste acima verde e o
    // titular de dados sem o documento que a LGPD manda entregar.
    const texto = readFileSync(join(RAIZ, "workers/lgpd-export-worker.ts"), "utf8");
    expect(texto).toContain("renderLgpdPdf");
    expect(texto).toMatch(/await import\((["'])@\/lib\/lgpd\/pdf-renderer\1\)/);
  });

  it("nenhum handler registrado no boot importa @react-pdf no topo", () => {
    // A regra vale para a família inteira, não só para o arquivo que mordeu:
    // qualquer handler novo que puxe PDF no topo repete o apagão.
    const registro = importsEstaticos("lib/event-log/register-handlers.ts")
      .filter((e) => e.startsWith("@/"))
      .map((e) => e.replace(/^@\//, ""));

    const culpados: string[] = [];
    for (const modulo of registro) {
      for (const ext of [".ts", ".tsx"]) {
        try {
          if (importsEstaticos(modulo + ext).some((i) => i.startsWith("@react-pdf"))) {
            culpados.push(modulo + ext);
          }
          break;
        } catch {
          // outra extensão, ou módulo que não é arquivo — segue.
        }
      }
    }
    expect(culpados, `handler(s) puxando @react-pdf no topo: ${culpados.join(", ")}`).toEqual([]);
  });
});
