/**
 * CONTATOS EM CARTÃO NO CELULAR (ADR-0006, fase F3) — medido por geometria.
 *
 * Abaixo de `md`, a tabela de contatos vira um cartão por linha só com classes
 * `max-md:`: o DOM é o mesmo do computador, como no Inbox. O que esta spec mede
 * é o que isso promete a quem atende com o celular na mão:
 *
 * 1. nada rola para o lado — nem a página, nem a caixa da tabela. A tabela base
 *    (`components/ui/table.tsx`) embrulha tudo num `overflow-auto`, e a régua do
 *    `body` não enxerga rolagem interna: era ali que a tabela de 8 colunas
 *    escondia metade de si;
 * 2. o cabeçalho some e cada cartão fica dentro da tela;
 * 3. o nome e as ações têm 44 px para o dedo; a caixa de seleção desenha 16 px e
 *    ainda pega o toque 20 px além do centro;
 * 4. "Selecionar todos os contatos visíveis" faz o papel da caixa do cabeçalho,
 *    que sumiu junto com ele;
 * 5. no computador volta a ser a tabela de sempre, sem o botão.
 *
 * ⚠️ EMULAÇÃO, DECLARADA: Chromium de computador com `isMobile` + `hasTouch`.
 * Prova a regra da tela, não o Safari do iPhone.
 *
 * Um login (agent) num caso só: ver `e2e-dois-logins-nao-cabem-no-teto-padrao`.
 */
import { randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { test, type Locator } from "./helpers/test";

import { admin, creds, expect, insere, login, type Creds } from "./qa-l12-comum";

const EVIDENCIA = path.join(process.cwd(), "evidence", "contatos-em-cartao-no-celular-20261021");

/** O piso de alvo de toque, o mesmo de `celular-cabe-na-tela.spec.ts`. */
const PISO_DE_TOQUE = 44;

/** Só letras: a busca também casa dígitos com o telefone de outros contatos. */
const MARCA = `${Date.now()}`.slice(-7).replace(/\d/g, (d) => "bcdfghjklm".charAt(Number(d)));
const ANA = `Ana Cartao ${MARCA}`;
const BRUNO = `Bruno ${MARCA} Albuquerque de Vasconcelos Figueiredo`;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "pt-BR" });

async function medir(alvo: Locator) {
  return alvo.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, height: r.height };
  });
}

test.describe("contatos em cartão no celular", () => {
  test.describe.configure({ timeout: 180_000 });

  let c: Creds;
  const contatos: string[] = [];

  test.beforeAll(async () => {
    c = creds();
    contatos.push(
      await insere("contacts", {
        organization_id: c.org_id,
        name: ANA,
        email: `ana.cartao.${MARCA}@um-dominio-bem-comprido-de-teste.com.br`,
        phone_number: `+5511${randomInt(100000000, 1000000000)}`,
        tags: [`etiqueta-bem-comprida-${MARCA}`, `outra-etiqueta-longa-${MARCA}`],
      }),
    );
    contatos.push(await insere("contacts", { organization_id: c.org_id, name: BRUNO, tags: [] }));
  });

  test.afterAll(async () => {
    if (contatos.length) await admin.from("contacts").delete().in("id", contatos);
  });

  test("[P1] cabe na tela, o dedo alcança cada ação e o computador continua tabela", async ({ page }) => {
    mkdirSync(EVIDENCIA, { recursive: true });
    await login(page, c.users.agent!.email, c.password);
    // Sem toque emulado o `pointer-coarse:` da caixa não vale, e o caso mediria o mouse.
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

    await page.goto("/app/contacts");
    await page.getByPlaceholder("Buscar por nome, email ou telefone…").fill(MARCA);
    const linhas = page.locator("tbody tr");
    await expect(linhas).toHaveCount(2, { timeout: 30_000 });
    const linhaDaAna = linhas.filter({ hasText: ANA });
    await page.screenshot({ path: path.join(EVIDENCIA, "01-cartoes.png") });

    // 1. Nada rola para o lado.
    const rolagemDaTabela = await page
      .locator("table")
      .evaluate((tabela) => tabela.parentElement!.scrollWidth - tabela.parentElement!.clientWidth);
    expect(rolagemDaTabela, "a caixa da tabela rola para o lado").toBeLessThanOrEqual(1);
    const rolagemDaPagina = await page.evaluate(
      () => document.body.scrollWidth - document.documentElement.clientWidth,
    );
    expect(rolagemDaPagina, "a página rola para o lado").toBeLessThanOrEqual(1);
    // O <main> do AppShell tem overflow-auto: o que estoura dentro da tela rola
    // nele, e o body não enxerga. É ele o rolador que a régua precisa medir.
    const rolagemDoMain = await page.locator("main").evaluate((m) => m.scrollWidth - m.clientWidth);
    expect(rolagemDoMain, "o conteúdo rola para o lado dentro do <main>").toBeLessThanOrEqual(1);

    // 2. Sem cabeçalho, e cada cartão dentro da tela (o <main> tem 16 px de respiro).
    expect(await page.locator("thead").evaluate((el) => getComputedStyle(el).display)).toBe("none");
    for (const linha of await linhas.all()) {
      const r = await medir(linha);
      expect(r.left, "cartão passa da borda esquerda").toBeGreaterThanOrEqual(15);
      expect(r.right, "cartão passa da borda direita").toBeLessThanOrEqual(375);
    }

    // 3. Alvos de toque: o nome leva à ficha; as ações são quadrados de 44 px.
    const nomeDaAna = linhaDaAna.getByRole("link", { name: ANA });
    expect((await medir(nomeDaAna)).height).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    for (const rotulo of [
      `Iniciar conversa com ${ANA} no Inbox`,
      `Editar contato ${ANA}`,
      `Excluir contato ${ANA}`,
    ]) {
      const r = await medir(linhaDaAna.getByRole("button", { name: rotulo }));
      expect(r.height, rotulo).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
      expect(r.width, rotulo).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
      expect(r.right, rotulo).toBeLessThanOrEqual(375);
    }

    const caixaDaAna = linhaDaAna.getByRole("checkbox");
    const toque = await caixaDaAna.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const acerta = (x: number, y: number) => {
        const alvo = document.elementFromPoint(x, y);
        return alvo !== null && (alvo === el || el.contains(alvo));
      };
      return { cx, cy, acertos: [acerta(cx - 20, cy), acerta(cx + 20, cy), acerta(cx, cy - 20), acerta(cx, cy + 20)] };
    });
    expect(toque.acertos, "o toque a 20 px do centro da caixa (esq, dir, cima, baixo)").toEqual([
      true,
      true,
      true,
      true,
    ]);
    await page.touchscreen.tap(toque.cx + 20, toque.cy);
    await expect(caixaDaAna).toHaveAttribute("aria-checked", "true");
    const barra = page.getByTestId("barra-de-contatos-em-lote");
    await expect(barra).toBeVisible();
    await page.getByTestId("lote-limpar").tap();
    await expect(barra).toHaveCount(0);

    // 4. A porta "selecionar todos" que sumiu com o cabeçalho.
    const todos = page.getByRole("button", { name: "Selecionar todos os contatos visíveis" });
    expect((await medir(todos)).height).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    await todos.tap();
    await expect(barra).toBeVisible();
    for (const linha of await linhas.all()) {
      await expect(linha.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    }
    await page.screenshot({ path: path.join(EVIDENCIA, "02-todos-selecionados.png") });

    // 5. Controle: no computador, a tabela de sempre e nenhum botão a mais.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator("thead")).toBeVisible();
    await expect(todos).toBeHidden();
    // Os botões de ação voltam ao tamanho de sempre no computador (36 px do size=icon).
    const editarNoComputador = await medir(linhaDaAna.getByRole("button", { name: `Editar contato ${ANA}` }));
    expect(editarNoComputador.height).toBe(36);
    await page.screenshot({ path: path.join(EVIDENCIA, "03-computador-tabela.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await nomeDaAna.tap();
    await page.waitForURL(new RegExp(`/app/contacts/${contatos[0]}`), { timeout: 30_000 });
  });
});
