/**
 * O FORMULÁRIO DE MODELO CABE NA TELA EM 375px — medido, não fotografado.
 *
 * ## O defeito que esta spec prende
 *
 * No celular (375px), abrir "Criar modelo" em Conexões fazia o `<main>` rolar de
 * lado e cortava os campos na direita (#3702). O `<main>` da casca tem
 * `overflow-auto`: o que passa da largura rola DENTRO dele, então o `body`
 * continua exatamente da largura da janela, e a régua do `body` sozinha não vê
 * nada. É por isso que a conta abaixo é o MAIOR entre as duas:
 * `body - janela` e `main.scrollWidth - main.clientWidth`.
 *
 * Também não vale medir `documentElement.scrollWidth`: `app/globals.css` põe
 * `overflow-x: hidden`/`clip` em `html` e `body`, e sob `hidden` o `scrollWidth`
 * do documentElement é grampeado no `clientWidth` — a conta daria ZERO com um
 * filho de 3000px (ver `celular-cabe-na-tela.spec.ts`).
 *
 * ## Por que a causa era o grid, e não "o texto é grande"
 *
 * O formulário nasce como `grid ... lg:grid-cols-[1fr_20rem]`. Abaixo de `lg` o
 * grid fica com UMA coluna implícita `auto`, que não encolhe abaixo do
 * `min-content` dos filhos; e os campos da coluna da esquerda eram `flex-1` com
 * `min-width: auto` (o `size` padrão de um `<input>`) ou largura fixa (`w-56` no
 * idioma). Somados, o `min-content` do formulário passava da largura útil — 343
 * px numa janela de 375 px, com o `p-4` da casca — e o `<main>` passava a rolar.
 *
 * ## As duas abas, e o que "duas" quer dizer aqui
 *
 * A aba do parceiro e a do canal oficial montam o MESMO formulário — o
 * compartilhado em `FormularioDaDefinicao`, que o parceiro abre por
 * `TemplatesParceiroClient` e o canal oficial por `TemplatesClient` (as duas
 * usam `data-formulario-do-modelo` e o mesmo CSS). Esta spec percorre as duas em
 * 375x812 com o formulário ABERTO — não com a lista fechada, que sempre cabe.
 *
 * Desde que o canal oficial passou a gerenciar modelo pela tela (#3635), "não
 * achei o formulário" deixou de ser um caso legítimo: virou DEFEITO, e o caso
 * fica vermelho. A única ausência aceita é a instalação não ter número oficial
 * conectado — ali não existe formulário nenhum, e o caso se declara PULADO com
 * o motivo, em vez de medir a lista e chamar isso de verde.
 *
 * Cada caso imprime a medida, para que um vermelho diga QUANTO passou em vez de
 * só "não cabe".
 */
import { test, expect, type Page } from "./helpers/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

/**
 * Um login só para todos os casos: dois logins caem na mesma janela TOTP quase
 * sempre, e a espera pela próxima janela comeria o orçamento (ver
 * `tests/unit/e2e-dois-logins-nao-cabem-no-teto-padrao.test.ts`).
 */
test.describe.configure({ timeout: 180_000 });

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

/** As duas abas que montam o formulário. */
const ABAS = [
  { aba: "parceiro", rotulo: "parceiro" },
  { aba: "oficial", rotulo: "canal oficial" },
] as const;

/**
 * Quanto a tela passa da própria largura, em px: o maior entre os dois lados da
 * casca. O `body` pega o que escapa dela; o `<main>` pega o conteúdo, que é onde
 * este formulário estoura.
 */
async function transbordo(page: Page): Promise<{ px: number; detalhe: string }> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const form = document.querySelector<HTMLElement>("[data-formulario-do-modelo]");
    const janela = document.documentElement.clientWidth;
    const doBody = document.body.scrollWidth - janela;
    const doMain = main ? main.scrollWidth - main.clientWidth : 0;
    return {
      px: Math.max(doBody, doMain),
      detalhe:
        `janela=${janela} body=${document.body.scrollWidth} ` +
        `main=${main?.scrollWidth ?? "?"}/${main?.clientWidth ?? "?"} ` +
        `form=${form ? `${form.scrollWidth}/${form.clientWidth}` : "ausente"}`,
    };
  });
}

/**
 * Mede depois que a largura PARA de mudar. Aberto há pouco, o painel ainda está
 * animando, e medir no meio disso dá "falso vermelho hoje, falso verde amanhã".
 */
async function medirEstavel(page: Page) {
  let anterior = Number.NaN;
  for (let i = 0; i < 20; i++) {
    const medida = await transbordo(page);
    if (medida.px === anterior) return medida;
    anterior = medida.px;
    await page.waitForTimeout(150);
  }
  return transbordo(page);
}

/** O que a aba ofereceu ao abrir: o formulário, ou o motivo de ele não existir. */
type Abertura =
  | { formulario: true }
  | { formulario: false; motivo: "canal-oficial-desconectado" | "sem-criacao" };

/**
 * Abre a aba de modelos e o formulário.
 *
 * Devolve o ESTADO da aba, e não um booleano: desde a #3635 as duas abas têm
 * "Criar modelo", então "não achei o formulário" deixou de ser um caso legítimo
 * e passou a ser defeito. Quem chama decide o que é desculpa aceitável (a
 * instalação não ter número oficial conectado) e o que é regressão.
 */
async function abrirAba(page: Page, aba: string): Promise<Abertura> {
  await page.goto(`/app/connections?aba=${aba}&sub=templates`, { waitUntil: "domcontentloaded" });
  // A tela montou quando a sub-aba "Modelos" está lá: ela existe nas duas abas
  // mesmo quando a conexão do canal ainda não foi feita (a lista vazia e o
  // "canal não conectado" convivem com a barra de sub-abas).
  await page
    .getByRole("tab", { name: /^(Modelos|Modelos do parceiro|Templates da Meta)$/ })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });

  // Duas telas possíveis: a aba com o botão que abre o formulário, ou o cartão
  // que avisa que não há canal oficial conectado — a ÚNICA saída sem form.
  const criar = page.getByRole("button", { name: /^Criar modelo$/ });
  const semCanal = page.getByText(/Canal oficial não conectado/);
  await expect(
    criar.or(semCanal).first(),
    `a aba "${aba}" não montou: nem "Criar modelo", nem o aviso de canal desconectado`,
  ).toBeVisible({ timeout: 60_000 });

  if ((await semCanal.count()) > 0)
    return { formulario: false, motivo: "canal-oficial-desconectado" };
  if ((await criar.count()) === 0) return { formulario: false, motivo: "sem-criacao" };

  await criar.first().click();
  // A espera é o FORMULÁRIO, não o botão: sem esta linha, um formulário que não
  // abre deixa o caso medindo a lista e chamando isso de verde.
  await expect(
    page.locator("[data-formulario-do-modelo]"),
    `a aba "${aba}" tem "Criar modelo" e o clique não abriu o formulário`,
  ).toBeVisible();
  return { formulario: true };
}

test("o formulário de modelo não estoura a tela em 375px, nas duas abas", async ({ page }) => {
  const creds = lerCreds();
  await loginComoAdmin(page, creds);

  for (const { aba, rotulo } of ABAS) {
    const abertura = await abrirAba(page, aba);

    if (!abertura.formulario) {
      test
        .info()
        .annotations.push({
          type: "medida",
          description: `${rotulo}: NÃO medido (${abertura.motivo})`,
        });
      // Ficar sem formulário só é desculpa na aba do canal oficial, e só quando a
      // instalação não tem número oficial conectado — ali não existe formulário
      // nenhum para medir, e o caso se declara PULADO com o motivo (nunca verde).
      // Em qualquer outra aba é regressão: o formulário é o que este caso mede.
      expect(
        abertura.motivo,
        `a aba do ${rotulo} abriu sem "Criar modelo" — o formulário deixou de ser oferecido ali`,
      ).toBe("canal-oficial-desconectado");
      test.skip(
        true,
        `a aba do ${rotulo} não existe nesta instalação: canal oficial não conectado`,
      );
    }

    const { px, detalhe } = await medirEstavel(page);
    test.info().annotations.push({
      type: "medida",
      description: `${rotulo} (criar): ${detalhe} → ${px}px`,
    });
    expect(
      px,
      `a aba do ${rotulo} passa da tela em 375px com o formulário aberto — ${detalhe}`,
    ).toBeLessThanOrEqual(1);

    const doFormulario = await page.evaluate(() => {
      const form = document.querySelector<HTMLElement>("[data-formulario-do-modelo]")!;
      return { scroll: form.scrollWidth, client: form.clientWidth };
    });
    expect(
      doFormulario.scroll,
      `o formulário da aba do ${rotulo} passa da própria caixa: ${doFormulario.scroll}/${doFormulario.client}`,
    ).toBeLessThanOrEqual(doFormulario.client + 1);
  }

  // O formulário de EDITAR tem um campo a mais (a linha "Editando <nome>") e
  // nasce preenchido com o texto aprovado — inclusive com nome longo, que é o
  // caso que mais empurra a largura. Sem modelo espelhado, o caso se declara
  // pulado em vez de falhar: o que ele mede é o formulário, não o seed.
  await page.goto("/app/connections?aba=parceiro&sub=templates", { waitUntil: "domcontentloaded" });
  const primeira = page.locator("ul > li button[aria-expanded]").first();
  const temModelo = await primeira
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!temModelo, "a organização não tem modelo espelhado para editar");

  await primeira.click();
  await page
    .getByRole("button", { name: /^Editar$/ })
    .first()
    .click();
  await expect(page.locator('[data-formulario-do-modelo="editar"]')).toBeVisible();

  const doEditar = await medirEstavel(page);
  test.info().annotations.push({
    type: "medida",
    description: `editar: ${doEditar.detalhe} → ${doEditar.px}px`,
  });
  expect(
    doEditar.px,
    `o formulário de editar passa da tela — ${doEditar.detalhe}`,
  ).toBeLessThanOrEqual(1);
});
