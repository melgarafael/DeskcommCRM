/**
 * SONDA — as 6 abas da Inbox alcançáveis e legíveis, medida com
 * `getBoundingClientRect` contra a largura da coluna (#2745).
 *
 * ## Por que browser, e por que este arquivo é uma sonda
 *
 * O jsdom não tem engine de layout: medir largura lá devolve zero em tudo e o
 * teste passa feliz — verde por ausência de motor, o pior falso verde que
 * existe (a mesma decisão escrita em `tests/sonda-inbox-cabe-na-tela.ts`).
 * A faixa de abas é exatamente esse tipo de pergunta: `overflow-x-auto` +
 * `shrink-0` + `justify-between` só dizem o que FAZEM juntos quando um browser
 * calcula o layout.
 *
 * A medição usa as DUAS coisas reais: o DOM que o `InboxFilters` renderiza
 * (jsdom + testing-library, com os mesmos dublês do
 * `inbox-filters-scope.test.tsx`) injetado numa página, e o CSS que o Tailwind
 * compila de `app/globals.css` — mais a fonte real
 * (`app/fonts/atkinson-hyperlegible-400-*.woff2`), porque largura de rótulo é
 * largura de fonte e a fonte substituta muda o número. O que NÃO é real é a
 * coluna ao redor: ela é uma `div` de largura fixa, não o grid do Inbox — o
 * número que importa (a coluna da lista, 240–520px) é o mesmo, e a issue mediu
 * o corte exatamente contra ele.
 *
 * ## LIGA NA BANCADA, NÃO NO CI
 *
 * Exige Chromium (`CHROME_BIN` ou um dos caminhos conhecidos) e compila o
 * Tailwind inteiro. Por isso o gate é uma variável de ambiente — a suíte
 * unitária do CI não tem browser, e um teste que falha lá por falta de
 * browser ensina o time a ignorar o vermelho:
 *
 *   SONDA_ABAS_INBOX=1 pnpm exec vitest run tests/sonda-abas-inbox-1280.test.tsx
 *
 * Sem a variável o arquivo roda e REPORTA que não mediu nada — não confunde
 * "pulado" com "passou". A catraca barata que roda no CI é
 * `tests/unit/inbox-abas-da-faixa-cabem.test.tsx`; esta sonda é a medição.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, type Browser } from "@playwright/test";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    activeOrg: { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" },
  }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  channelLabel: (c: { display_name: string }) => c.display_name,
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
// Contagens de 2 dígitos, como numa instalação viva: elas ALARGAM a aba, e é
// com elas que o corte foi medido na issue.
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({
    data: { fila: 47, automatico: 12, mine: 8, all: 130, closed: 25, archived: 9 },
  }),
}));

const VALUE: InboxFiltersValue = { tab: "ai", search: "", onlyUnread: false };

/**
 * As larguras da coluna da lista: `LIMITES_LISTA` (240–520) e o padrão da
 * faixa `xl` (272) — a grade do inbox é arrastável, então a faixa inteira é
 * régua, não só o padrão. 523 é a largura medida na issue (arrastada no máx.).
 */
const COLUNAS = [240, 272, 300, 380, 450, 523];

function chromeBinario(): string {
  const candidatos = [
    process.env.CHROME_BIN,
    process.env.CHROMIUM_BIN,
  ].filter((x): x is string => !!x);
  for (const binario of candidatos) if (existsSync(binario)) return binario;
  throw new Error(
    "Sem Chromium. Instale um browser ou aponte CHROME_BIN — esta sonda NÃO pula: " +
      "medir layout sem browser seria o verde por ausência de motor que ela existe para evitar.",
  );
}

async function compilarCssDoProduto(): Promise<string> {
  const origem = "app/globals.css";
  const resultado = await postcss([tailwind()]).process(readFileSync(origem, "utf8"), {
    from: origem,
  });
  return resultado.css;
}

/** A fonte real, em data URL — sem ela a largura do rótulo é a do fallback. */
function fonteRealEmBase64(): string {
  const woff2 = "app/fonts/atkinson-hyperlegible-400-latin-latin-ext.woff2";
  return `@font-face{font-family:"AtkinsonSonda";src:url(data:font/woff2;base64,${readFileSync(woff2).toString("base64")}) format("woff2");}`;
}

function htmlDoInboxFilters(): string {
  const { container } = render(<InboxFilters value={VALUE} onChange={() => {}} />);
  const raiz = container.firstElementChild;
  expect(raiz, "o InboxFilters não renderizou nada").toBeTruthy();
  return raiz!.outerHTML;
}

/**
 * O gate de armamento. `skipIf` deixa o CI ver "skipped" — que é a foto honesta
 * de "não medi": um son da desarmado não passa, ele some do placar.
 */
const ARMADA = process.env.SONDA_ABAS_INBOX === "1";

describe("sonda — as 6 abas da Inbox medidas em browser", () => {
  it.skipIf(!ARMADA)(
    "cada aba cabe DENTRO da coluna, em toda largura da faixa xl",
    async () => {
      const css = await compilarCssDoProduto();
      const html = htmlDoInboxFilters();
      let browser: Browser | null = null;
      const linhas: Array<Record<string, unknown>> = [];
      try {
        browser = await chromium.launch({ executablePath: chromeBinario() });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.setContent(
          `<!doctype html><html><head><meta charset="utf-8"><style>${fonteRealEmBase64()}</style>` +
            `<style>:root{--font-atkinson:"AtkinsonSonda"}</style><style>${css}</style></head>` +
            `<body style="margin:0"><div id="coluna" style="width:272px">${html}</div></body></html>`,
        );
        for (const larguraDaColuna of COLUNAS) {
          await page.evaluate((w) => {
            document.getElementById("coluna")!.style.width = `${w}px`;
          }, larguraDaColuna);
          linhas.push(
            await page.evaluate(`(() => {
            const coluna = document.getElementById("coluna");
            const lista = coluna.querySelector('[role="tablist"]');
            const retanguloDaLista = lista.getBoundingClientRect();
            const abas = Array.prototype.map.call(
              lista.querySelectorAll('[role="tab"]'),
              (aba) => {
                const r = aba.getBoundingClientRect();
                return {
                  rotulo: (aba.textContent || "").trim(),
                  largura: Math.round(r.width),
                  // Dentro da FAIXA visível da lista — que é a pergunta da
                  // issue: alcançável e legível, sem depender de rolagem.
                  dentro:
                    r.left >= retanguloDaLista.left - 0.5 &&
                    r.right <= retanguloDaLista.right + 0.5,
                };
              },
            );
            // Linhas = quantas vezes a faixa quebrou (tops distintos).
            const tops = new Set(
              Array.prototype.map.call(lista.querySelectorAll('[role="tab"]'), (aba) =>
                Math.round(aba.getBoundingClientRect().top),
              ),
            );
            return {
              coluna: coluna.getBoundingClientRect().width,
              lista_w: Math.round(retanguloDaLista.width),
              linhas: tops.size,
              faixa_h: Math.round(retanguloDaLista.height),
              // Rolo horizontal = tem aba escondida atrás da seta.
              rolavel: lista.scrollWidth - lista.clientWidth,
              abas,
            };
          })()`),
          );
        }
      } finally {
        await browser?.close();
      }

      // `info`, e não `log`: o `no-console` do projeto só deixa warn/error/info.
      console.info("\n#2745 — medidas das 6 abas (browser real, fonte real)");
      for (const r of linhas) {
        const abas = r.abas as Array<{ rotulo: string; largura: number; dentro: boolean }>;
        console.info(
          `coluna=${String(Math.round(r.coluna as number)).padStart(4)}px ` +
            `lista=${String(r.lista_w).padStart(4)}px rolagem=${String(r.rolavel).padStart(4)}px ` +
            `linhas=${r.linhas} faixa_h=${r.faixa_h}px | ` +
            abas
              .map((a) => `${a.rotulo.replace(/\s+/g, " ")}:${a.largura}${a.dentro ? "" : "✗"}`)
              .join(" "),
        );
      }

      // Guarda de vacuidade: sem aba medida, tudo abaixo passaria por não haver
      // o que verificar.
      expect(linhas).toHaveLength(COLUNAS.length);
      for (const r of linhas) {
        const abas = r.abas as Array<{ rotulo: string; dentro: boolean }>;
        expect(abas, "nenhuma aba foi medida").toHaveLength(6);
        expect(
          r.rolavel,
          `a faixa rolava ${r.rolavel}px em coluna de ${r.coluna}px — aba escondida atrás da seta`,
        ).toBe(0);
        const perdidas = abas.filter((a) => !a.dentro).map((a) => a.rotulo);
        expect(
          perdidas,
          `abas fora da coluna em ${r.coluna}px (corte medido na issue #2745)`,
        ).toEqual([]);
      }
    },
    180_000,
  );
});
