/**
 * O scroll lock do Radix não desloca a navegação após rolar Configurações.
 * Mede a geometria real no desktop e mantém a gaveta alcançável no celular.
 * Pré-condição: seed-e2e-credentials.ts no banco local do baseline.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "./helpers/test";
import { lerCreds, loginComoDono } from "./helpers/login-admin";
import { afirmarDonoDoServidor } from "./utils/precondicao";

const evidencia = join(process.cwd(), "evidence", "sidebar-scroll-lock");
test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  await afirmarDonoDoServidor(lerCreds().users.dono!.email);
});

async function semEstouro(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("desktop: menus e diálogo preservam a posição da barra lateral", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await loginComoDono(page, lerCreds());
  await page.goto("/app/settings");
  const aside = page.locator('[data-casca="raiz"] > .hidden > aside');
  await expect(aside).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
  const antes = await aside.evaluate((el) => el.getBoundingClientRect().y);
  expect(antes).toBeGreaterThanOrEqual(0);
  mkdirSync(evidencia, { recursive: true });

  const medidas: Array<{ controle: string; antes: number; depois: number }> = [];
  for (const rotulo of [/^Menu do usuário:/, /^Organização:/, /Buscar/]) {
    await page.getByRole("button", { name: rotulo }).click();
    await expect(page.locator("body")).toHaveAttribute("data-scroll-locked");
    await expect
      .poll(async () =>
        Math.abs((await aside.evaluate((el) => el.getBoundingClientRect().y)) - antes),
      )
      .toBeLessThan(1);
    await semEstouro(page);
    medidas.push({
      controle: rotulo.source,
      antes,
      depois: await aside.evaluate((el) => el.getBoundingClientRect().y),
    });
    if (rotulo.source.includes("usuário")) {
      await page.screenshot({ path: join(evidencia, "desktop-perfil.png") });
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked");
  }
  for (const rota of ["/app/inbox", "/app/pipelines"]) {
    await page.goto(rota);
    await semEstouro(page);
  }
  writeFileSync(join(evidencia, "medidas-desktop.json"), JSON.stringify(medidas, null, 2) + "\n");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowX)).toBe(
    "visible",
  );
});

test("celular: a gaveta abre sem rolagem horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginComoDono(page, lerCreds());
  await page.goto("/app/settings");
  await semEstouro(page);
  await page.getByRole("button", { name: "Abrir navegação", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await semEstouro(page);
  mkdirSync(evidencia, { recursive: true });
  await page.screenshot({ path: join(evidencia, "celular-navegacao.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
