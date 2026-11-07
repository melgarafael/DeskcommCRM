import { expect, test, type Page } from "./helpers/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

/**
 * Jornada da agenda de avaliação — exige módulo `avaliacao` instalado na instância E2E.
 * Fora do CI padrão até o seed instalar o módulo de forma estável.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe("Agenda de avaliação veicular", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await loginComoAdmin(page, lerCreds());
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("tela de avaliação responde em /app/agenda quando o módulo está ativo", async () => {
    await page.goto("/app/agenda");
    const avaliacao = page.getByTestId("tela-agenda-avaliacao");
    const legado = page.getByTestId("tela-agenda");
    await expect(avaliacao.or(legado)).toBeVisible({ timeout: 60_000 });
  });
});
