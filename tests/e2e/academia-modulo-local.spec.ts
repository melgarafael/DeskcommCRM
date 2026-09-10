import { test, expect } from "@playwright/test";

// Prova opt-in: usa SOMENTE o administrador e a instalação local indicados.
// Não cria/apaga organizações, usuários, agentes, canais ou mensagens.
test("administrador liga, desliga e religa Academia pela interface", async ({ page }) => {
  test.skip(!process.env.ACADEMIA_E2E_EMAIL || !process.env.ACADEMIA_E2E_PASSWORD, "Informe o administrador local dedicado à verificação.");
  test.setTimeout(120_000);
  await page.goto("/login");
  await page.locator("#email").fill(process.env.ACADEMIA_E2E_EMAIL!);
  await page.locator("#password").fill(process.env.ACADEMIA_E2E_PASSWORD!);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/);
  await page.goto("/app/settings/modules");
  const toggle=page.getByRole("switch",{name:"Habilitar módulo Academia"});
  await expect(toggle).toBeVisible();
  async function setEnabled(enabled:boolean) {
    if ((await toggle.getAttribute("aria-checked"))!==String(enabled)) {
      await toggle.click();
      const response=page.waitForResponse(r=>r.url().endsWith("/api/v1/modules")&&r.request().method()==="PATCH");
      await page.getByRole("button",{name:"Salvar alteração"}).click();
      expect((await response).status()).toBe(200);
    }
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked",String(enabled));
  }
  await setEnabled(false);
  await expect(page.locator('aside a[href="/app/academia"]')).toHaveCount(0);
  expect((await page.request.get("/api/v1/academia")).status()).toBe(403);
  await page.goto("/app/academia");
  await expect(page.getByRole("heading",{name:"Minha Academia",exact:true})).toHaveCount(0);
  await page.goto("/app/settings/modules");
  await setEnabled(true);
  await expect(page.locator('aside a[href="/app/academia"]')).toBeVisible();
  expect((await page.request.get("/api/v1/academia")).status()).toBe(200);
  await page.getByRole("link",{name:"Abrir Minha Academia"}).click();
  await expect(page.getByRole("heading",{name:"Minha Academia",exact:true})).toBeVisible();
  await page.getByRole("link",{name:"Gerenciar módulos"}).click();
  await setEnabled(false);
  expect((await page.request.get("/api/v1/academia")).status()).toBe(403);
  await setEnabled(true);
  await page.screenshot({path:".superpowers/evidence/academia-module-enabled.png",fullPage:true});
});
