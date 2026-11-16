import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * SOBREPOSTO QUE FECHA — o fundo tem de receber clique no MESMO quadro.
 *
 * ## O defeito (medido, não suposto)
 *
 * `tests/e2e/fluxo-de-atendimento.spec.ts:185` reprovou no CI do #4606
 * (`e2e-parte (5)`, job 132418618829) com "o canvas precisa ter fundo exposto
 * para fechar o painel". O trace do Playwright guardou o DOM daquele instante:
 *
 *     <body style="pointer-events: none;" data-scroll-locked="1">
 *     <div class="react-flow__renderer" aria-hidden="true" data-aria-hidden="true">
 *     <div role="listbox" data-state="closed" class="ds-painel …">
 *
 * A camada do Select "Tipo da resposta" fechou 17ms antes de a spec amostrar o
 * fundo do canvas (snapshots 140 → 144 do trace) e continuava MONTADA. Enquanto
 * ela existe, o `DismissableLayer` do Radix segura `pointer-events: none` no
 * body: `elementFromPoint()` nos doze pontos do `.react-flow__pane`
 * devolvia `<html>`, nunca o pane — a asserção caiu com o canvas visível e
 * vazio na tela.
 *
 * ## Por que a camada continuava montada
 *
 * O `Presence` (`@radix-ui/react-presence`) só manda `UNMOUNT` quando chega o
 * `animationend`, e o atalho global de movimento reduzido (este arquivo,
 * `app/globals.css`) encurta a animação para `0.01ms` — não para nenhuma.
 * Duração minúscula ainda é animação: o evento chega no quadro seguinte, e
 * nesse intervalo a camada invisível (`opacity: 0` do `both`) segura o clique
 * da página inteira.
 *
 * ## O conserto
 *
 * Sob `prefers-reduced-motion: reduce`, a saída de `.ds-painel` e `.ds-modal` é
 * `animation: none !important`: o `Presence` vê `animationName === "none"` e
 * desmonta no próprio efeito de layout, devolvendo `pointer-events` ao body no
 * mesmo quadro. É exatamente o que o comentário de `contextOptions` em
 * `playwright.config.ts` já prometia ("com `reduce` … a suíte volta ao
 * comportamento instantâneo") e não acontecia.
 *
 * A sabotagem (apagar o par `.ds-painel[data-state="closed"],
 * .ds-modal[data-state="closed"]` do bloco de movimento reduzido) deixa o
 * primeiro caso VERMELHO — e reproduz o vermelho do CI: uma camada de 0.01ms
 * sobrevive a um quadro e o fundo não recebe o clique.
 */

const CSS = fs.readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");

/** Texto entre a chave que abre em `abre` e a que a fecha (com aninhamento). */
function corpoDoBloco(css: string, abre: number): string {
  let nivel = 0;
  for (let i = abre; i < css.length; i++) {
    if (css[i] === "{") nivel++;
    else if (css[i] === "}") {
      nivel--;
      if (nivel === 0) return css.slice(abre + 1, i);
    }
  }
  throw new Error("bloco @media sem fechamento em app/globals.css");
}

/** Todo bloco `@media (prefers-reduced-motion: reduce)`, com onde começa/termina. */
function blocosDeMovimentoReduzido(css: string): { inicio: number; fim: number; corpo: string }[] {
  const aberturas = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g)];
  return aberturas.map((m) => {
    const abre = (m.index ?? 0) + m[0].length - 1;
    const corpo = corpoDoBloco(css, abre);
    return { inicio: abre - m[0].length + 1, fim: abre + corpo.length + 2, corpo };
  });
}

type Regra = { seletor: string; corpo: string };

/** Regras de um bloco (sem aninhamento): `seletor { corpo }`. */
function regras(bloco: string): Regra[] {
  const semComentario = bloco.replace(/\/\*[\s\S]*?\*\//g, "");
  const saida: Regra[] = [];
  let i = 0;
  while (i < semComentario.length) {
    const abre = semComentario.indexOf("{", i);
    if (abre === -1) break;
    const fecha = semComentario.indexOf("}", abre);
    if (fecha === -1) break;
    saida.push({
      seletor: semComentario.slice(i, abre).replace(/\s+/g, " ").trim(),
      corpo: semComentario.slice(abre + 1, fecha),
    });
    i = fecha + 1;
  }
  return saida;
}

const BLOCOS_REDUZIDOS = blocosDeMovimentoReduzido(CSS);
const REGRAS_REDUZIDAS = BLOCOS_REDUZIDOS.flatMap((bloco) => regras(bloco.corpo));

/** A regra, dentro de um bloco de movimento reduzido, que atende ao seletor. */
function regraReduzida(seletor: string): Regra | undefined {
  return REGRAS_REDUZIDAS.find((regra) =>
    regra.seletor
      .split(",")
      .map((parte) => parte.trim())
      .includes(seletor),
  );
}

describe("o sobreposto que fecha devolve o clique ao fundo no mesmo quadro", () => {
  it.each(['.ds-painel[data-state="closed"]', '.ds-modal[data-state="closed"]'])(
    "%s não anima sob movimento reduzido (sem animationend, sem quadro de espera)",
    (seletor) => {
      const regra = regraReduzida(seletor);
      expect(
        regra,
        `falta ${seletor} dentro de @media (prefers-reduced-motion: reduce): sem isso a camada ` +
          "de 0.01ms sobrevive a um quadro segurando pointer-events: none no body",
      ).toBeDefined();
      expect(regra?.corpo).toMatch(/animation:\s*none\s*!important/);
    },
  );

  /**
   * O CONSERTO É SÓ DO MOVIMENTO REDUZIDO.
   *
   * Quem não pediu movimento reduzido continua com a saída animada — e ali o
   * `animationend` chega dentro dos 120ms da animação, como sempre. Se alguém
   * "consertar" apagando a animação da saída no caminho normal, o produto perde
   * o movimento que a lei de design prescreve e este caso avisa.
   */
  it("o produto com movimento continua animando a saída de painel e de modal", () => {
    let foraDoReduce = CSS;
    for (const bloco of [...BLOCOS_REDUZIDOS].reverse()) {
      foraDoReduce = foraDoReduce.slice(0, bloco.inicio) + foraDoReduce.slice(bloco.fim);
    }

    expect(foraDoReduce).toMatch(
      /\.ds-painel\[data-state="closed"\]\s*\{\s*animation:\s*ds-painel-sai\b/,
    );
    expect(foraDoReduce).toMatch(/\.ds-modal\[data-state="closed"\]\s*\{\s*animation:\s*ds-modal-sai\b/);
  });

  /**
   * O ATALHO GLOBAL CONTINUA SENDO O PADRÃO.
   *
   * A saída instantânea é a EXCEÇÃO dos dois sobrepostos, não a regra da casa:
   * o resto do produto segue com `0.01ms`, como a lei manda ("o destino é o
   * mesmo, só sem o percurso"). Trocar o atalho inteiro por `animation: none`
   * apagaria também esqueleto e spinner — que têm exceções próprias logo acima
   * justamente para não congelar.
   */
  it("o atalho global de 0.01ms continua valendo para o resto do produto", () => {
    const global = REGRAS_REDUZIDAS.find((regra) => regra.seletor.includes("*"));
    expect(global, "sumiu o bloco global de movimento reduzido").toBeDefined();
    expect(global?.corpo).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });
});
