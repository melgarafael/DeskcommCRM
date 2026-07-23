/**
 * E2E — jornada completa de recuperação de senha (usuário real, browser real):
 *
 * 1. conta existente (seed via GoTrue admin API + provisionamento direto)
 * 2. /login → "Esqueci minha senha" → pede o link
 * 3. abre o e-mail (Mailpit) e clica no link → /login/reset
 * 4. define a senha nova → volta ao login com banner de sucesso
 * 5. prova: senha ANTIGA falha, senha NOVA entra
 */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import {
  waitForEmail,
  extractAuthConfirmLink,
  uniqueEmail,
  loadEnvLocal,
} from "./helpers/auth";

const email = uniqueEmail("recovery");
const oldPassword = "SenhaAntiga!123";
const newPassword = "SenhaNova!456";

test.beforeAll(async () => {
  const envLocal = loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? envLocal.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? envLocal.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SUPABASE_URL/SERVICE_ROLE_KEY ausentes (.env.local)");

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: oldPassword,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`seed createUser: ${error?.message}`);

  const slug = `e2e-recovery-${Date.now()}`;
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .insert({
      slug,
      display_name: "Loja E2E Recovery",
      legal_name: "Loja E2E Recovery",
      status: "active",
      created_by: data.user.id,
    })
    .select("id")
    .single();
  if (orgError || !org) throw new Error(`seed org: ${orgError?.message}`);

  const { error: memberError } = await admin.from("user_organizations").insert({
    user_id: data.user.id,
    organization_id: org.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (memberError) throw new Error(`seed membership: ${memberError.message}`);
});

test("recuperar senha: forgot → e-mail → nova senha → login com a nova", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);

  // 2. Login → link "Esqueci minha senha"
  await page.goto("/login");
  await page.getByRole("link", { name: "Esqueci minha senha" }).click();
  await expect(page).toHaveURL(/\/login\/forgot$/);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Enviar link de redefinição" }).click();
  await expect(page.getByText("Verifique seu e-mail")).toBeVisible();

  // 3. Abre o e-mail real e segue o link de recovery
  const html = await waitForEmail(email, "Redefinir senha");
  const link = extractAuthConfirmLink(html, baseURL!);
  await page.goto(link);
  await expect(page).toHaveURL(/\/login\/reset/);

  // 4. Define a senha nova
  await page.getByLabel("Nova senha", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirmar nova senha").fill(newPassword);
  await page.getByRole("button", { name: "Definir nova senha" }).click();
  await expect(page).toHaveURL(/\/login\?reset=success/);
  await expect(page.getByText("Senha redefinida com sucesso")).toBeVisible();

  // 5a. Senha ANTIGA tem que falhar
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(oldPassword);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText("Email ou senha incorretos.")).toBeVisible();

  // 5b. Senha NOVA entra
  await page.getByLabel("Senha").fill(newPassword);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(app|onboarding)\//, { timeout: 30_000 });
  await expect(page).not.toHaveURL(/\/login/);
});
