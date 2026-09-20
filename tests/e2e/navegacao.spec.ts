/** Workspace: discoverability, keyboard, responsive layout and preserved destinations. */
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
let creds = lerCreds();
const EVIDENCE = path.join(process.cwd(), ".superpowers", "evidence", "workspace");
test.use({ locale: "pt-BR" });
test.describe.configure({ timeout: 180_000 });
test.beforeEach(async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  creds = await loginComoAdmin(page, creds);
  await page.goto("/app");
});

test("entrada conversacional, navegação enxuta e catálogo completo por teclado", async ({
  page,
}) => {
  await expect(page.getByRole("heading", { name: /Seu próximo passo/ })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Navegação principal" });
  await expect(nav.getByRole("link")).toHaveCount(6);
  await expect(nav.getByRole("link", { name: "Agentes de IA" })).toBeVisible();
  await page.getByRole("button", { name: "Todas as ferramentas" }).click();
  await page.getByRole("combobox").fill("etapas do funil");
  await expect(page.getByRole("option", { name: /Etapas do funil/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.waitForURL(/settings\/tenant\/pipelines/);
  await expect(page.getByRole("heading", { name: "Etapas do funil", level: 1 })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill("conhec");
  await page.keyboard.press("Enter");
  await page.waitForURL(/knowledge\/sources/);
});

test("desktop claro/escuro, fonte nova e barra sem rolagem", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.getByRole("heading", { name: /Seu próximo passo/ })).toBeVisible();
  const measure = await page
    .getByRole("navigation", { name: "Navegação principal" })
    .evaluate((el) => ({ scroll: el.scrollHeight, height: el.clientHeight }));
  expect(measure.scroll).toBeLessThanOrEqual(measure.height + 1);
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(
    /Geist/i,
  );
  for (const theme of ["light", "dark"]) {
    for (let step = 0; step < 3; step++) {
      const button = page.getByRole("button", { name: /^Tema:/ });
      if ((await button.getAttribute("aria-label"))?.includes(`Tema: ${theme}.`)) break;
      await button.click();
    }
    await expect(page.locator(".workspace-nav-item.is-active")).toHaveCSS(
      "background-color", theme === "dark" ? "rgb(29, 32, 38)" : "rgb(255, 255, 255)",
    );
    await page.screenshot({ path: path.join(EVIDENCE, `desktop-${theme}.png`), fullPage: true, animations: "disabled" });
  }
  await page.getByRole("button", { name: "Recolher sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expandir sidebar" })).toBeVisible();
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expandir sidebar" }).click();
});

test("mobile 360/390, navegação por gaveta e preferência de movimento reduzido", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("heading", { name: /Seu próximo passo/ })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      scroll: document.body.scrollWidth,
      width: document.documentElement.clientWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
    await page.screenshot({ path: path.join(EVIDENCE, `mobile-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Abrir navegação" }).click();
  await page.getByRole("navigation").getByRole("link", { name: "Funis", exact: true }).click();
  await page.waitForURL(/\/app\/kanban/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("sugestão vira pergunta editável e falha de transporte permite tentar novamente", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Resuma as conversas recentes" }).click();
  const input = page.getByLabel("O que você quer saber sobre seu CRM?");
  await expect(input).toHaveValue("Resuma as conversas recentes");
  await expect(page.getByLabel("Onde consultar")).toHaveValue("conversations");
  // Fail the actual server-action request, not a pretend successful model reply.
  await page.route("**/app", async (route) => {
    if (route.request().method() === "POST") await route.abort("failed");
    else await route.continue();
  });
  await page.getByRole("button", { name: "Enviar pergunta" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "pergunta foi mantida" })).toBeVisible();
  await expect(input).toHaveValue("Resuma as conversas recentes");
  await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeEnabled();
});
