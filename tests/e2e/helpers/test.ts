/**
 * O `test` da suíte: o do Playwright, com uma diferença — `page.goto` e
 * `page.reload` só devolvem quando o streaming SSR terminou de REVELAR a página
 * (issue #1374). Toda spec importa daqui, não de `@playwright/test`; a cerca é
 * `tests/unit/e2e-specs-usam-o-test-da-suite.test.ts`.
 *
 * ═══ Por que `load` não basta ═══════════════════════════════════════════════
 *
 * O `react-dom` do Next 16.3.5 não revela um boundary quando o `$RC("B:N","S:N")`
 * chega: ele ENFILEIRA a revelação (`$RB`) e a executa depois, num
 * `requestAnimationFrame` ou num `setTimeout` de até 300 ms contados da revelação
 * anterior (`$RT+300-agora`). O evento `load` dispara antes disso. Nessa janela a
 * página inteira mora escondida em `<div hidden id="S:N">`.
 *
 * Se algum provedor da casca muda um contexto nessa janela, o React não pode
 * hidratar o boundary ainda pendente e o renderiza do zero no cliente: por
 * algumas centenas de milissegundos existem as DUAS cópias — a nova, visível no
 * `<main>`, e a do servidor, escondida na caixa. Quando o `$RV` enfim roda, ele
 * remove a caixa e sobra uma. O usuário nunca vê a cópia escondida; o
 * `getByTestId` vê, e reprova por strict mode ("resolved to 2 elements").
 *
 * Medido nos traces de dois runs vermelhos (36237325664 do PR #1703 e
 * 36072593385 da `main`), `/app/agenda`: logo depois do `goto`, `S:1` escondida
 * com o `tela-agenda` e o `<main>` sem ele; na falha, duas cópias; no snapshot
 * seguinte, `S:1` já não existe e o `<main>` tem uma. A caixa não é órfã — é
 * lida no meio da revelação.
 *
 * O remédio é esperar a revelação terminar, uma vez, aqui — e não `.first()`
 * espalhado, que escolheria às cegas entre a cópia viva e a escondida.
 */
import { test as base, type Page } from "@playwright/test";

export * from "@playwright/test";

/** Caixa do streaming que ainda não foi revelada. */
export const CAIXA_PENDENTE = 'div[hidden][id^="S:"]';

/**
 * Teto para a revelação. Ela leva centenas de milissegundos; quem estoura isto
 * não está atrasado, está órfão de verdade — o defeito que a #1374 temia.
 */
const TETO_DA_REVELACAO_MS = 15_000;

export async function esperarARevelacao(page: Page): Promise<void> {
  try {
    await page.waitForFunction((seletor) => document.querySelector(seletor) === null, CAIXA_PENDENTE, {
      polling: 50,
      timeout: TETO_DA_REVELACAO_MS,
    });
  } catch (erro) {
    throw new Error(
      `a caixa do streaming SSR (${CAIXA_PENDENTE}) não foi revelada em ${TETO_DA_REVELACAO_MS} ms ` +
        `depois da carga de ${page.url()} — caixa órfã de verdade (issue #1374).`,
      { cause: erro },
    );
  }
}

const comEspera = new WeakSet<Page>();

function esperarARevelacaoNasCargas(page: Page): void {
  if (comEspera.has(page)) return;
  comEspera.add(page);

  const goto = page.goto.bind(page);
  page.goto = async (url, opcoes) => {
    const resposta = await goto(url, opcoes);
    // `commit` pede de propósito a página antes de ela existir.
    if (opcoes?.waitUntil !== "commit") await esperarARevelacao(page);
    return resposta;
  };

  const reload = page.reload.bind(page);
  page.reload = async (opcoes) => {
    const resposta = await reload(opcoes);
    if (opcoes?.waitUntil !== "commit") await esperarARevelacao(page);
    return resposta;
  };
}

export const test = base.extend({
  // Sem JavaScript os reveladores não rodam e a caixa fica por definição.
  context: async ({ context, javaScriptEnabled }, usar) => {
    if (javaScriptEnabled !== false) context.on("page", esperarARevelacaoNasCargas);
    await usar(context);
  },
  page: async ({ page, javaScriptEnabled }, usar) => {
    if (javaScriptEnabled !== false) esperarARevelacaoNasCargas(page);
    await usar(page);
  },
});
