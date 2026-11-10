import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O PAINEL DO PASSO NÃO PODE NASCER ATRÁS DA BARRA DE ABAS DO CELULAR.
 *
 * Abaixo de `lg`, os painéis do nó e da aresta do construtor de follow-up viram
 * folha de baixo (`fixed`). Ancorados em `bottom-0`, o rodapé deles (o botão de
 * excluir, o fim do formulário) ficava por baixo da barra inferior, que também é
 * `fixed`. A casca publica quanto as peças de baixo ocupam em `--rodape-ocupado`
 * (`lib/ui/rodape-ocupado.tsx`); o painel sobe essa altura. Em `lg` é `static`,
 * e o `bottom` não vale nada. A prova medida é `tests/e2e/ia-no-celular.spec.ts`.
 */
const FONTE = readFileSync("app/app/ai/followups/[id]/_components/FlowCanvas.tsx", "utf8");

describe("painéis do construtor acima da barra inferior", () => {
  it("as duas folhas sobem a altura que o rodapé ocupa", () => {
    for (const testid of ["node-config-sheet", "edge-config-sheet"]) {
      const fim = FONTE.indexOf(`data-testid="${testid}"`);
      expect(fim, testid).toBeGreaterThan(-1);
      const aside = FONTE.slice(FONTE.lastIndexOf("<aside", fim), fim);
      expect(aside, testid).toContain("fixed inset-x-0 bottom-[var(--rodape-ocupado,0px)]");
      expect(aside, testid).not.toMatch(/\bbottom-0\b/);
    }
  });
});
