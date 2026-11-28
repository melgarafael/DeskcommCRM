/**
 * O BOTÃO «EDITAR HORÁRIO» CABE NA PRÓPRIA CAIXA (issue #5230) — medido por geometria.
 *
 * Na tabela de Equipe, aba Atendimento, o botão que abre o editor de jornada é
 * `size="icon"`: a partir de `lg` ele tem 36 px de largura (`lg:w-9`), e o rótulo
 * visível — «Editar», pedido pela #2312 e mostrado a partir de `lg` — não cabe
 * nela. O `md:h-7 md:w-7` do `className` só vale entre 768 e 1023 px; de 1024
 * para cima quem manda é o `lg:w-9` do tamanho `icon`. Resultado medido na prova
 * do #5213, a 1280 px: caixa de 36 px, `scrollWidth` 51, ícone saindo 15 px pela
 * esquerda e o texto 15 px pela direita.
 *
 * ═══ Por que não basta olhar a largura do botão ═══
 *
 * `getBoundingClientRect()` devolve a CAIXA, não o conteúdo: ela continua com 36
 * px enquanto o texto transborda por cima da coluna vizinha. Quem acusa o
 * transbordo é `scrollWidth - clientWidth` no próprio botão (o `overflow` é
 * visível, então o `scrollWidth` soma o que passa). E, para provar que ícone e
 * texto estão DENTRO, cada filho é medido contra as bordas da caixa — a folga
 * de 1 px cobre o arredondamento sub-pixel do Chromium.
 *
 * ═══ O outro lado ═══
 *
 * O conserto não pode criar rolagem lateral no celular: a 375 px a mesma tela
 * continua sem transbordar no `<main>` nem no invólucro da tabela, e o botão
 * continua clicável (abre e fecha o editor sem gravar nada). O rótulo é
 * `hidden lg:inline`, então no celular o botão segue sendo de ícone.
 *
 * ═══ Dados ═══
 *
 * Nada é semeado: os atendentes são os do seed de credenciais (`admin`,
 * `manager`, `agent`, `viewer`, `dono`), que já têm disponibilidade. Só o
 * admin entra (é ele que enxerga o botão — a coluna depende de `canManage`).
 */
import { test, type Locator, type Page } from "./helpers/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { creds, expect } from "./qa-l12-comum";

/** A largura da prova da issue e a do celular em que a tela já era vigiada. */
const LARGURA_DO_COMPUTADOR = 1280;
const LARGURA_DO_CELULAR = 375;

/**
 * A folga aceita: 1 px de arredondamento sub-pixel. Não é tolerância de
 * projeto — 15 px de transbordo (o medido na issue) passam longe disto.
 */
const FOLGA = 1;

test.use({ viewport: { width: LARGURA_DO_COMPUTADOR, height: 900 }, locale: "pt-BR" });

interface MedidaDoBotao {
  caixa: { left: number; right: number; width: number; height: number };
  /** `scrollWidth` do próprio botão: o conteúdo que passa da caixa entra aqui. */
  scrollWidth: number;
  clientWidth: number;
  icone: { left: number; right: number };
  texto: { left: number; right: number; visivel: boolean };
}

/** Uma leitura só, no mesmo frame: caixa, conteúdo e os dois filhos. */
async function medirBotao(botao: Locator): Promise<MedidaDoBotao> {
  return botao.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const icone = el.querySelector("svg")!.getBoundingClientRect();
    const rotulo = el.querySelector("span")!;
    const texto = rotulo.getBoundingClientRect();
    return {
      caixa: { left: r.left, right: r.right, width: r.width, height: r.height },
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      icone: { left: icone.left, right: icone.right },
      texto: { left: texto.left, right: texto.right, visivel: getComputedStyle(rotulo).display !== "none" },
    };
  });
}

/** O botão da linha do atendente, na aba Atendimento da tela de Equipe. */
async function abrirAtendimento(page: Page, emailDoAtendente: string): Promise<Locator> {
  await page.goto("/app/team");
  // `click`, não `tap`: o gatilho de aba do Radix ativa no `mousedown`.
  await page.getByRole("tab", { name: "Atendimento" }).click();
  await expect(page.getByTestId("atendentes-e-horarios")).toBeVisible({ timeout: 30_000 });
  const tabela = page.getByRole("tabpanel").locator("table");
  const linha = tabela.locator("tbody tr").filter({ hasText: emailDoAtendente });
  await expect(linha).toBeVisible({ timeout: 30_000 });
  const botao = linha.getByRole("button", { name: /^Editar horário de / });
  await expect(botao).toBeVisible();
  return botao;
}

test.describe("o botão «Editar horário» cabe na caixa", () => {
  test.describe.configure({ timeout: 180_000 });

  test("[P1] a 1280px o ícone e o rótulo «Editar» ficam dentro da caixa do botão", async ({ page }) => {
    const c = creds();
    await loginComoAdmin(page, lerCreds());
    const botao = await abrirAtendimento(page, c.users.agent!.email);
    await page.evaluate(() => document.fonts.ready);

    const medida = await medirBotao(botao);
    // Os números das duas rodadas (antes/depois) saem no log da lane.
    console.log(`[#5230 1280px] ${JSON.stringify(medida)}`);

    // (a) a caixa acomoda o conteúdo — é este número que a issue traz como 51 vs 36.
    expect(
      medida.scrollWidth - medida.clientWidth,
      `o conteúdo do botão passa da caixa (scrollWidth ${medida.scrollWidth} > clientWidth ${medida.clientWidth})`,
    ).toBeLessThanOrEqual(FOLGA);

    // (b) o rótulo está visível a partir de `lg` — sem isso a medida seria de um
    // botão de ícone, e o defeito que a issue descreve não estaria em cena.
    expect(medida.texto.visivel, "o rótulo «Editar» deveria estar visível a 1280px").toBe(true);

    // (b) ícone e texto dentro das bordas da caixa, com 1 px de folga.
    expect(medida.icone.left, "o ícone passa da borda esquerda da caixa").toBeGreaterThanOrEqual(
      medida.caixa.left - FOLGA,
    );
    expect(medida.icone.right, "o ícone passa da borda direita da caixa").toBeLessThanOrEqual(
      medida.caixa.right + FOLGA,
    );
    expect(medida.texto.left, "o texto passa da borda esquerda da caixa").toBeGreaterThanOrEqual(
      medida.caixa.left - FOLGA,
    );
    expect(medida.texto.right, "o texto passa da borda direita da caixa").toBeLessThanOrEqual(
      medida.caixa.right + FOLGA,
    );
  });

  test("[P1] a 375px a tela não rola para o lado e o botão continua abrindo o editor", async ({ page }) => {
    const c = creds();
    await loginComoAdmin(page, lerCreds());
    const botao = await abrirAtendimento(page, c.users.agent!.email);

    await page.setViewportSize({ width: LARGURA_DO_CELULAR, height: 844 });
    await page.evaluate(() => document.fonts.ready);

    // O `<main>` do AppShell é o que rola; o invólucro do primitivo de tabela
    // (`div.overflow-auto`) é o que NÃO pode rolar para o lado no cartão.
    const rolagemDoMain = await page
      .locator("main")
      .first()
      .evaluate((m) => m.scrollWidth - m.clientWidth);
    expect(rolagemDoMain, "a tela rola para o lado a 375px").toBeLessThanOrEqual(FOLGA);
    const rolagemDaTabela = await page
      .getByRole("tabpanel")
      .locator("table")
      .first()
      .evaluate((t) => t.parentElement!.scrollWidth - t.parentElement!.clientWidth);
    expect(rolagemDaTabela, "a tabela rola para o lado dentro da própria caixa a 375px").toBeLessThanOrEqual(
      FOLGA,
    );

    // E o botão continua ao alcance: abre o editor e fecha sem gravar.
    const rotulo = await botao.getAttribute("aria-label");
    expect(rotulo, "o botão perdeu o aria-label da issue").toMatch(/^Editar horário de /);
    await botao.click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible();
    try {
      await expect(dialogo.getByRole("heading", { name: /horário|jornada/i })).toBeVisible({ timeout: 5_000 });
    } finally {
      await dialogo.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(dialogo).toBeHidden();
    }
    expect(c.users.agent!.email).toContain("@");
  });
});
