/**
 * O `test` da suíte: o do Playwright, com uma diferença — `page.goto`,
 * `page.reload`, `page.goBack` e `page.goForward` só devolvem quando o streaming
 * SSR terminou de REVELAR a página (issues #1374 e #884). Toda spec importa
 * daqui, não de `@playwright/test`; a cerca é
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

import {
  EVIDENCIA_DE_ERRO_VAZIA,
  embrulharANavegacao,
  METODOS_DE_NAVEGACAO_REVELADOS,
  mensagemDaCaixaNaoRevelada,
  type EvidenciaDoErroDeServidor,
} from "./revelacao-nas-cargas";

export * from "@playwright/test";
export { METODOS_DE_NAVEGACAO_REVELADOS };

/** Caixa do streaming que ainda não foi revelada. */
export const CAIXA_PENDENTE = 'div[hidden][id^="S:"]';

/**
 * Teto para a revelação. Ela leva centenas de milissegundos; quem estoura isto
 * não está atrasado, está órfão de verdade — o defeito que a #1374 temia.
 */
const TETO_DA_REVELACAO_MS = 15_000;

/**
 * Lê da página o que o `$RX` do erro de servidor deixou: o `data-dgst` do
 * marcador do boundary (é ali que o próprio `$RX` escreve o digest) e os textos
 * dos scripts — o `$RX("B:N","<digest>")` cru. Só é chamada DEPOIS de a espera
 * desistir, e só para montar o diagnóstico; quem decide a mensagem é
 * `mensagemDaCaixaNaoRevelada`, em função pura, no teste unit.
 */
function evidenciaDoErroDeServidor(page: Page): Promise<EvidenciaDoErroDeServidor> {
  return page.evaluate(() => {
    const digestsDoMarcador: string[] = [];
    const mensagensDoMarcador: string[] = [];
    for (const marcador of Array.from(document.querySelectorAll("[data-dgst]"))) {
      const dados = (marcador as HTMLElement).dataset;
      if (dados.dgst) digestsDoMarcador.push(dados.dgst);
      if (dados.msg) mensagensDoMarcador.push(dados.msg);
    }
    return {
      digestsDoMarcador,
      mensagensDoMarcador,
      scripts: Array.from(document.scripts).map((script) => script.textContent ?? ""),
    };
  });
}

export async function esperarARevelacao(page: Page): Promise<void> {
  try {
    await page.waitForFunction((seletor) => document.querySelector(seletor) === null, CAIXA_PENDENTE, {
      polling: 50,
      timeout: TETO_DA_REVELACAO_MS,
    });
  } catch (erro) {
    // Ler a página é DIAGNÓSTICO, não critério: se ela não puder mais ser lida
    // (contexto morto, navegação em curso), fica a evidência vazia e a mensagem
    // de sempre. A espera continua reprovando exatamente como antes.
    let evidencia = EVIDENCIA_DE_ERRO_VAZIA;
    try {
      evidencia = await evidenciaDoErroDeServidor(page);
    } catch {
      evidencia = EVIDENCIA_DE_ERRO_VAZIA;
    }
    throw new Error(
      mensagemDaCaixaNaoRevelada({
        caixaPendente: CAIXA_PENDENTE,
        tetoMs: TETO_DA_REVELACAO_MS,
        url: page.url(),
        evidencia,
      }),
      { cause: erro },
    );
  }
}

const comEspera = new WeakSet<Page>();

/**
 * ⚠️ A COBERTURA VIVE EM `METODOS_DE_NAVEGACAO_REVELADOS`, e o embrulho em
 * `embrulharANavegacao` — os dois em `revelacao-nas-cargas.ts`, porque é lá que
 * o teste unit os prova. A #884 nasceu de um método de fora da cobertura:
 * `goBack`. Não embrulhe método à mão aqui: a cerca de
 * `tests/unit/revelacao-cobre-a-navegacao-inteira.test.ts` reprova.
 */
function esperarARevelacaoNasCargas(page: Page): void {
  if (comEspera.has(page)) return;
  comEspera.add(page);
  embrulharANavegacao(page, () => esperarARevelacao(page));
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
