import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O BOTÃO CONFIRMAR DA AGENDA É ALCANÇÁVEL EM JANELA BAIXA — cerca de FORMA.
 *
 * O defeito: de `lg` para cima o Sheet de "Novo agendamento" era
 * `lg:overflow-hidden`, e o painel de marcar só ganhava a altura que o
 * formulário acima dele deixava (`lg:flex-1 lg:min-h-0`). O formulário cresceu
 * (vínculo, tipos, convidado, endereço, observação) e, em janela larga e baixa,
 * sobra uma fresta — ou nada. O Sheet cortava horários e o Confirmar EM
 * SILÊNCIO: sem barra de rolagem, sem como chegar.
 *
 * Como na cerca irmã (`agenda-lista-de-horarios-nao-estica.test.ts`), isto lê o
 * código-fonte e NÃO mede pixel: o jsdom não faz layout. A prova de tela é do
 * `tests/e2e/agenda-painel-cabe-na-tela.spec.ts`. A forma basta porque o
 * defeito É uma forma, e das que passam por typecheck, lint e suíte sem um
 * arranhão: duas classes de CSS.
 *
 * As duas metades são necessárias, e cada uma reprova a `main` de antes:
 *   1. o Sheet ROLA em todo breakpoint — sem isso o excedente é cortado;
 *   2. o painel NÃO encolhe para caber — sem isso o Sheet rolável não tem o
 *      que rolar: o painel é espremido até a fresta e o `overflow-hidden` DELE
 *      corta o Confirmar por dentro.
 */

const RAIZ = process.cwd();
const FONTE = fs.readFileSync(path.join(RAIZ, "app", "app", "agenda", "_client.tsx"), "utf8");

/** O `className` literal logo depois de `ancora` no fonte (até 400 caracteres). */
function classesApos(ancora: number): string {
  if (ancora < 0) return "";
  return /className="([^"]+)"/.exec(FONTE.slice(ancora, ancora + 400))?.[1] ?? "";
}

/** O Sheet de marcar é o que envolve o `PainelDeMarcacao`, não o de cancelar. */
const posPainel = FONTE.indexOf("<PainelDeMarcacao");
const classesDoSheet = classesApos(FONTE.lastIndexOf("<SheetContent", posPainel));
const classesDoInvolucro = (() => {
  const i = FONTE.lastIndexOf("<div", posPainel);
  return i < 0 ? "" : (/className="([^"]+)"/.exec(FONTE.slice(i, posPainel))?.[1] ?? "");
})();

describe("o Confirmar da Agenda é alcançável em janela baixa", () => {
  it("CONTROLE: o Sheet e o invólucro do painel foram encontrados", () => {
    expect(posPainel).toBeGreaterThan(0);
    expect(classesDoSheet).toMatch(/max-w-\[1040px\]/);
    expect(classesDoInvolucro.length).toBeGreaterThan(0);
  });

  it("⛔ o Sheet rola na vertical em TODO breakpoint — nada de `*:overflow-hidden`", () => {
    expect(classesDoSheet.split(/\s+/)).toContain("overflow-y-auto");
    // Qualquer variante que desligue a rolagem vertical num breakpoint volta a
    // cortar em silêncio naquele breakpoint — foi exatamente `lg:`.
    expect(classesDoSheet).not.toMatch(/(^|\s)([a-z0-9-]+:)*overflow(-y)?-(hidden|clip|visible)(\s|$)/);
  });

  it("⛔ o painel tem a altura do conteúdo — não divide a altura do Sheet com o formulário", () => {
    // `flex-1 min-h-0` é o par que deixa o painel encolher até a fresta. Com
    // `shrink-0` ele mantém a altura natural e o excedente vira rolagem do Sheet.
    expect(classesDoInvolucro.split(/\s+/)).toContain("shrink-0");
    expect(classesDoInvolucro).not.toMatch(/(^|\s)([a-z0-9-]+:)*(flex-1|min-h-0)(\s|$)/);
  });
});
