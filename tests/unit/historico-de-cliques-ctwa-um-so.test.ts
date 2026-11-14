/**
 * O painel de cliques CTWA é MONTADO num lugar só — e o e2e só o lê DEPOIS da
 * revelação do streaming.
 *
 * ═══ O vermelho que este arquivo fecha (PR #4618, job `e2e-parte (8)`) ═══════
 *
 * `tests/e2e/meta-lead-submitted-causal.spec.ts:609` reprovou com
 *
 *     Error: strict mode violation: getByTestId('historico-de-cliques-ctwa')
 *     resolved to 2 elements
 *
 * O PR é o das tarefas recorrentes (cron + migration) e não toca a tela de
 * Conversões: o diff dele não tem um arquivo de `app/app/settings/conversoes/`.
 * A segunda cópia não vem do produto. Ela vem da caixa do streaming SSR que o
 * servidor manda e o React esvazia no cliente — medida no trace do run
 * 43577447655: logo depois do clique em "Histórico de envios" o documento tem
 * `<div hidden id="S:0">` com o bloco inteiro da página, e é a MESMA família de
 * vermelho da #1374 (caixa escondida), do #884 (`goBack` fora do embrulho) e do
 * #4454 (`browser.newPage()` fora do embrulho).
 *
 * O que faltava aqui é o mesmo buraco, num quarto caminho: a troca de aba desta
 * tela é navegação de CLIENTE (`<Link href="?aba=historico">`), e a fixture
 * embrulha `goto`, `reload`, `goBack` e `goForward` — clique não. Entre o
 * clique e a revelação existem as duas cópias do painel, e o modo estrito conta
 * a escondida.
 *
 * ═══ Por que a cerca, e não só a linha na spec ══════════════════════════════
 *
 * Porque a spec seguinte que ler o painel depois de um clique herda o mesmo
 * vermelho intermitente, em PR que não toca a tela — que é exatamente o custo
 * que a #1374 vem cobrando. A varredura é de TEXTO, como as irmãs
 * (`e2e-contexto-proprio-espera-a-revelacao`, `revelacao-cobre-a-navegacao-inteira`):
 * ela não executa a spec, então quem ler o testid por outro caminho (helper de
 * outra arquivo) fica fora da conta — o limite está escrito aqui para não ser
 * redescoberto por um verde falso.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "../..");
const RAIZ_E2E = join(RAIZ, "tests/e2e");
const RAIZ_APP = join(RAIZ, "app");
const TESTID = "historico-de-cliques-ctwa";
/** O componente que é a ÚNICA origem do testid na árvore do produto. */
const COMPONENTE_DO_PAINEL = "app/app/settings/conversoes/_historicoCliques.tsx";
const ESPERA = "esperarARevelacao(";

/** Uma leitura do testid dentro de uma spec. */
export type Leitura = {
  /** Linha (1-based) do `getByTestId(...)`. */
  linha: number;
  /** `true` quando há uma espera da revelação entre o último clique e a leitura. */
  protegida: boolean;
};

/**
 * As leituras do testid numa spec, e se cada uma vem precedida da espera da
 * revelação. Função pura sobre o TEXTO: o caso de sonda a exercita com fontes
 * sintéticas, e a varredura roda contra `tests/e2e/*.spec.ts`.
 *
 * A janela é do ÚLTIMO `click()` até a leitura — não do começo do arquivo: uma
 * espera no `beforeAll` não protege a navegação que veio depois.
 */
export function leiturasDoTestid(fonte: string, testid = TESTID): Leitura[] {
  const linhas = fonte.split("\n");
  const leituras: Leitura[] = [];
  let ultimoClique = -1;

  linhas.forEach((linha, indice) => {
    if (/\.click\s*\(/.test(linha)) ultimoClique = indice;
    const citaTestid =
      linha.includes(`getByTestId("${testid}")`) || linha.includes(`getByTestId('${testid}')`);
    if (!citaTestid) return;

    const janela = linhas.slice(ultimoClique + 1, indice + 1).join("\n");
    // Sem clique antes, não há navegação de cliente a revelar: a página já veio
    // revelada pela carga (`goto`/`reload` da fixture).
    leituras.push({ linha: indice + 1, protegida: ultimoClique === -1 || janela.includes(ESPERA) });
  });

  return leituras;
}

function arquivos(diretorio: string, extensao: string): string[] {
  return readdirSync(diretorio, { recursive: true, encoding: "utf8" })
    .filter((arquivo) => arquivo.endsWith(extensao))
    .map((arquivo) => join(diretorio, arquivo));
}

describe("o histórico de cliques CTWA é um só, lido depois da revelação (#4618)", () => {
  it("a sonda enxerga clique sem espera, clique com espera e leitura sem clique", () => {
    const semEspera = [
      'import { expect, test } from "./helpers/test";',
      'await page.getByRole("link", { name: "Histórico de envios" }).click();',
      'const painel = page.getByTestId("historico-de-cliques-ctwa");',
    ].join("\n");
    expect(leiturasDoTestid(semEspera)).toEqual([{ linha: 3, protegida: false }]);

    const comEspera = [
      'await page.getByRole("link", { name: "Histórico de envios" }).click();',
      "await esperarARevelacao(page);",
      'const painel = page.getByTestId("historico-de-cliques-ctwa");',
    ].join("\n");
    expect(leiturasDoTestid(comEspera)).toEqual([{ linha: 3, protegida: true }]);

    // Sem clique antes (a página já veio revelada pelo `goto` da fixture) não há
    // corrida a proteger: a leitura conta como protegida.
    const semClique = 'const painel = page.getByTestId("historico-de-cliques-ctwa");';
    expect(leiturasDoTestid(semClique)).toEqual([{ linha: 1, protegida: true }]);

    // A espera ANTES do clique não vale: a corrida nasce no clique.
    const esperaAntesDoClique = [
      "await esperarARevelacao(page);",
      'await page.getByRole("link", { name: "Histórico de envios" }).click();',
      'const painel = page.getByTestId("historico-de-cliques-ctwa");',
    ].join("\n");
    expect(leiturasDoTestid(esperaAntesDoClique)).toEqual([{ linha: 3, protegida: false }]);
  });

  it("nenhuma spec lê o painel depois de um clique sem esperar a revelação", () => {
    const specs = arquivos(RAIZ_E2E, ".spec.ts");
    expect(specs.length).toBeGreaterThan(0);

    const pendentes: string[] = [];
    for (const spec of specs) {
      const fonte = readFileSync(spec, "utf8");
      if (!fonte.includes(TESTID)) continue;
      for (const leitura of leiturasDoTestid(fonte)) {
        if (leitura.protegida) continue;
        pendentes.push(
          `${spec.slice(RAIZ.length + 1)}:${leitura.linha} — lê \`${TESTID}\` depois de um clique sem ` +
            `\`${ESPERA}page)\`: até o React esvaziar a caixa do streaming o bloco existe 2x e o modo estrito reprova`,
        );
      }
    }

    expect(
      pendentes,
      "o clique que troca de aba é navegação de cliente, e a fixture só espera `goto`/`reload`/`goBack`/`goForward`: " +
        "espere a revelação antes de ler o testid",
    ).toEqual([]);
  });

  it("o painel tem um componente só, montado uma vez na página", () => {
    const comOTestid = arquivos(RAIZ_APP, ".tsx").filter((arquivo) =>
      readFileSync(arquivo, "utf8").includes(`data-testid="${TESTID}"`),
    );
    expect(comOTestid.map((arquivo) => arquivo.slice(RAIZ.length + 1))).toEqual([
      COMPONENTE_DO_PAINEL,
    ]);

    const pagina = readFileSync(join(RAIZ, "app/app/settings/conversoes/page.tsx"), "utf8");
    expect(pagina.match(/<HistoricoDeCliques\b/g) ?? []).toHaveLength(1);
  });
});
