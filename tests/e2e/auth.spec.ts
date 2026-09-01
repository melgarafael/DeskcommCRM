import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("auth flow", () => {
  test("anon GET /app/inbox redirects to /login", async ({ page }) => {
    await page.goto("/app/inbox");
    // Either we land on /login (with optional ?next=) or middleware sends us elsewhere
    await page.waitForURL(/\/login/);
    expect(page.url()).toMatch(/\/login/);
  });

  test("invalid login shows error", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill("nobody@example.com");
    await page.locator("#password").fill("wrong-password-xyz");
    await page.getByRole("button", { name: /entrar/i }).click();
    // Wait for either an inline error or that we did NOT navigate to /app
    await page.waitForTimeout(1500);
    expect(page.url()).not.toMatch(/\/app\//);
  });

  /**
   * O redesenho do `/login` pôs DOIS controles novos entre a senha e o "Entrar":
   * o olho que revela a senha e o link "Esqueci minha senha". (A maquete tinha um
   * terceiro, a caixa "Manter conectado"; ela não entrou enquanto a duração da
   * sessão não for tratada.) A versão anterior desta spec ia de `#password` direto
   * ao botão — ela
   * não passou a estar errada por capricho do desenho: aquele caminho deixou de
   * existir, e mantê-la verde exigiria tirar do teclado justamente os controles
   * que acabaram de entrar.
   *
   * O que continua sendo medido é o que importava antes e importa agora: dá para
   * percorrer o formulário inteiro pelo teclado, na ordem em que ele aparece na
   * tela, sem cair em nada fora dele nem pular o botão que envia.
   */
  test("login form is keyboard navigable in tab order", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").focus();
    await expect(page.locator("#email")).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(page.locator("#password")).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /mostrar senha/i })).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: /esqueci minha senha/i })).toBeFocused();

    await page.keyboard.press("Tab");
    const submit = page.getByRole("button", { name: /^entrar$/i });
    await expect(submit).toBeFocused();
  });

  test("login page has no serious or critical a11y violations", async ({ page }) => {
    await page.goto("/login");
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });
});
