/**
 * APARÊNCIA — o admin escolhe um template visual e o sistema inteiro muda, só
 * na estética, sem gravar nada até "Salvar" e sem vazar para quem não escolheu.
 *
 * A jornada provada pela tela, como o admin a faria:
 *   1. sem template, a casca é a de fábrica (nenhum atributo no marcador);
 *   2. Visualizar pinta o sistema em volta e NÃO grava (recarregar desfaz);
 *   3. Aplicar grava para a empresa e vale em outra tela, nos dois modos;
 *   4. os ajustes (arredondamento, efeitos) passam por cima do template e
 *      sobrevivem à troca de template;
 *   5. os dez templates, claro e escuro, numa tela de módulo — a evidência.
 *
 * Medido por `getComputedStyle`, nunca a olho. Cada caso devolve a empresa à
 * aparência de fábrica no fim (pela tela), para não pintar as outras specs.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { TEMPLATES } from "@/lib/aparencia/catalogo";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { expect, test, type Page } from "./helpers/test";

const EVIDENCIA = path.join(process.cwd(), "evidence", "aparencia-templates");
const TELA = "/app/settings/aparencia";

const creds = lerCreds();

async function marcador(page: Page, atributo: string): Promise<string | null> {
  return page.locator("[data-marca-org]").first().getAttribute(atributo);
}

async function estiloDe(page: Page, seletor: string, prop: string): Promise<string> {
  return page.locator(seletor).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

async function tokenDoBody(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => getComputedStyle(document.body).getPropertyValue(t).trim(), token);
}

async function modo(page: Page, qual: "light" | "dark"): Promise<void> {
  // Depois de "Aplicar", a tela dá `router.refresh()`: sem esperar a rede
  // assentar, o `evaluate` cai no meio dessa navegação.
  await page.waitForLoadState("networkidle");
  await page.evaluate((m) => localStorage.setItem("deskcomm-theme", m), qual);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", qual);
  await page.waitForLoadState("networkidle");
}

/** Volta a empresa à aparência de fábrica, pela tela, se ela não estiver lá. */
async function voltarAoPadrao(page: Page): Promise<void> {
  await page.goto(TELA);
  const padrao = page.getByRole("button", { name: "Aplicar Padrão do sistema", exact: true });
  await padrao.waitFor();
  if (await padrao.isEnabled()) {
    await page.getByRole("button", { name: "Voltar ao padrão do template" }).click();
    await padrao.click();
    await expect(page.getByText("Aparência salva para toda a equipe.")).toBeVisible();
  }
  await page.reload();
  await expect.poll(() => marcador(page, "data-aparencia")).toBeNull();
}

test.describe("Configurações › Aparência", () => {
  // Cada caso entra com MFA, volta a empresa ao padrão e troca de modo: só a
  // preparação passa dos 30s de padrão numa máquina comum.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await loginComoAdmin(page, creds);
    await modo(page, "light");
    await voltarAoPadrao(page);
  });

  test.afterEach(async ({ page }) => {
    await voltarAoPadrao(page);
  });

  test("sem template, o marcador não carrega atributo e o menu é o de fábrica", async ({ page }) => {
    for (const nome of [
      "data-aparencia",
      "data-aparencia-fonte",
      "data-aparencia-raio",
      "data-aparencia-densidade",
      "data-aparencia-efeitos",
    ]) {
      expect(await marcador(page, nome), nome).toBeNull();
    }
    // O menu de fábrica: superfície (`bg-card`) e fonte Atkinson.
    const fundoDoMenu = await estiloDe(page, '[data-casca-lugar="lateral"]', "background-color");
    expect(fundoDoMenu).toBe("rgb(255, 255, 255)");
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/atkinson/i);
  });

  test("Visualizar pinta o sistema em volta e não grava nada", async ({ page }) => {
    await page.getByRole("button", { name: "Visualizar Safira", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Só você está vendo");
    // A barra da prévia acompanha a rolagem: no fim da página ela continua à vista.
    await page.mouse.wheel(0, 20_000);
    await expect
      .poll(async () => {
        const caixa = await page.getByRole("status").boundingBox();
        return caixa !== null && caixa.y >= 0 && caixa.y + caixa.height <= page.viewportSize()!.height;
      })
      .toBe(true);
    expect(await marcador(page, "data-aparencia")).toBe("safira");
    // O menu lateral real (não a miniatura) virou o gradiente de safira.
    expect(await estiloDe(page, '[data-casca="menu-painel"]', "background-image")).toMatch(/linear-gradient/);
    expect(await tokenDoBody(page, "--color-bg")).toBe("#f3f6fc");

    await page.reload();
    expect(await marcador(page, "data-aparencia")).toBeNull();
    expect(await tokenDoBody(page, "--color-bg")).not.toBe("#f3f6fc");
  });

  test("Aplicar grava para a empresa e vale em outra tela, no claro e no escuro", async ({ page }) => {
    const aurora = TEMPLATES.find((t) => t.id === "aurora")!;
    await page.getByRole("button", { name: "Aplicar Aurora", exact: true }).click();
    await expect(page.getByText("Aparência salva para toda a equipe.")).toBeVisible();

    await page.goto("/app/contacts");
    await expect.poll(() => marcador(page, "data-aparencia")).toBe("aurora");
    expect(await tokenDoBody(page, "--color-bg")).toBe(aurora.cores.claro.fundo);
    expect(await estiloDe(page, '[data-casca="menu-painel"]', "backdrop-filter")).toContain("blur(24px)");
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/jakarta/i);

    await modo(page, "dark");
    expect(await tokenDoBody(page, "--color-bg")).toBe(aurora.cores.escuro.fundo);
    expect(await tokenDoBody(page, "--color-text")).toBe(aurora.cores.escuro.texto);
    await modo(page, "light");
  });

  test("os ajustes passam por cima do template e sobrevivem à troca de template", async ({ page }) => {
    await page.getByRole("button", { name: "Visualizar Carbono", exact: true }).click();
    await page.getByRole("group", { name: "Arredondamento" }).getByRole("button", { name: "Arredondado" }).click();
    await page.getByRole("group", { name: "Intensidade dos efeitos" }).getByRole("button", { name: "Desligado" }).click();
    expect(await tokenDoBody(page, "--radius-md")).toBe("16px");

    await page.getByRole("button", { name: "Salvar para a equipe" }).first().click();
    await expect(page.getByText("Aparência salva para toda a equipe.")).toBeVisible();
    await page.reload();
    expect(await marcador(page, "data-aparencia-raio")).toBe("arredondado");
    expect(await marcador(page, "data-aparencia-efeitos")).toBe("desligado");

    // Troca o template: o ajuste continua.
    await page.getByRole("button", { name: "Aplicar Mármore", exact: true }).click();
    await expect(page.getByText("Aparência salva para toda a equipe.")).toBeVisible();
    await page.reload();
    expect(await marcador(page, "data-aparencia")).toBe("marmore");
    expect(await tokenDoBody(page, "--radius-md")).toBe("16px");
    // Efeitos desligados: o fundo da casca é a cor sólida do template.
    expect(await estiloDe(page, '[data-casca="raiz"]', "background-image")).toBe("none");
  });

  test("os dez templates, claro e escuro, numa tela de módulo (evidência)", async ({ page }) => {
    test.setTimeout(240_000);
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    // A própria tela: galeria com as miniaturas reais e a personalização.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(TELA);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: path.join(EVIDENCIA, "tela-aparencia.jpg"), type: "jpeg", quality: 70, fullPage: true });
    await page.getByRole("button", { name: "Visualizar Aurora", exact: true }).click();
    await page.screenshot({ path: path.join(EVIDENCIA, "tela-aparencia-previa-aurora.jpg"), type: "jpeg", quality: 70 });
    await page.getByRole("button", { name: "Descartar" }).click();
    for (const t of TEMPLATES) {
      await page.goto(TELA);
      await page.getByRole("button", { name: `Aplicar ${t.nome}`, exact: true }).click();
      await expect(page.getByText("Aparência salva para toda a equipe.")).toBeVisible();
      await page.goto("/app/contacts");
      for (const m of ["light", "dark"] as const) {
        await modo(page, m);
        await expect.poll(() => marcador(page, "data-aparencia")).toBe(t.id);
        const tema = m === "light" ? t.cores.claro : t.cores.escuro;
        expect(await tokenDoBody(page, "--color-bg"), `${t.id} ${m}`).toBe(tema.fundo);
        await page.screenshot({
          path: path.join(EVIDENCIA, `${t.id}-${m === "light" ? "claro" : "escuro"}.jpg`),
          type: "jpeg",
          quality: 70,
        });
      }
      await modo(page, "light");
    }
  });

  test("no celular, o menu da gaveta usa as cores do template e nada estoura a largura", async ({ page }) => {
    await page.getByRole("button", { name: "Aplicar Vinho", exact: true }).click();
    await expect(page.getByText("Aparência salva para toda a equipe.")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/app/contacts");
    const largura = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(largura).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "Abrir navegação", exact: true }).click();
    const gaveta = page.locator('[data-casca="menu"][data-casca-movel]');
    await expect(gaveta).toBeVisible();
    expect(await gaveta.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(58, 10, 29)");
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "vinho-celular-menu.jpg"), type: "jpeg", quality: 70 });
  });
});
