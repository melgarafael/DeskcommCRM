/**
 * E2E — jornada completa de criação de conta (usuário real, browser real):
 *
 * 1. /login → clica "Criar conta"
 * 2. preenche o formulário de signup e envia
 * 3. abre o e-mail de confirmação (Mailpit) e clica no link
 * 4. cai autenticado no onboarding (tenant provisionado)
 * 5. sai e entra de novo com as credenciais criadas
 *
 * Pré-requisitos: Supabase local com Mailpit + app `next start` (ver README
 * da suíte / playwright.config.ts).
 */
import { test, expect } from "./helpers/test";

import { waitForEmail, extractAuthConfirmLink, seguirLinkDeAcesso, uniqueEmail } from "./helpers/auth";

test("criar conta: signup → e-mail de confirmação → onboarding → re-login", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("signup");
  const password = "SenhaForte!123";

  // 1. Login → botão "Criar conta"
  await page.goto("/login");
  await page.getByRole("link", { name: "Crear cuenta" }).click();
  await expect(page).toHaveURL(/\/signup$/);

  // 2. Formulário de signup
  await page.getByLabel("Nombre de la empresa").fill("Loja E2E Signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByLabel("Confirmar contraseña").fill(password);
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await expect(page.getByText("Confirma tu correo")).toBeVisible();

  // 3. Abre o e-mail real no Mailpit e segue o link
  const html = await waitForEmail(email, "Confirma tu correo");
  const link = extractAuthConfirmLink(html, baseURL!);
  await seguirLinkDeAcesso(page, link);

  // 4. Autenticado no onboarding — tenant provisionado
  await expect(page).toHaveURL(/\/onboarding\/welcome/);
  await expect(page.getByText("Boas-vindas ao DeskcommCRM")).toBeVisible();
  await expect(page.getByText("Loja E2E Signup")).toBeVisible();

  // 5. Sai (limpa sessão) e entra de novo com as credenciais criadas
  await context.clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/(app|onboarding)\//, { timeout: 30_000 });
  await expect(page).not.toHaveURL(/\/login/);
});
