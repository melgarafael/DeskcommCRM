/**
 * Regressão: redefinição de senha para conta COM MFA. O link de recuperação dá
 * uma sessão AAL1; o GoTrue exige AAL2 para trocar a senha quando há fator
 * verificado. A tela de reset precisa pedir o código TOTP e elevar a sessão
 * antes do update — senão nenhuma conta com MFA consegue se recuperar.
 *
 * Usa a conta admin seedada (tem TOTP verified + secret conhecido em
 * .e2e-creds.json). Troca a senha durante o fluxo e RESTAURA no afterAll para
 * não quebrar as demais specs.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { test, expect } from "./helpers/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  admin_totp?: { secret: string };
}

function readServiceEnv(): { url: string; serviceRole: string } {
  // `process.env` vence o `.env.local` — ver scripts/lib/env-de-teste.ts.
  const env = carregarEnvLocal();
  return { url: env.NEXT_PUBLIC_SUPABASE_URL!, serviceRole: env.SUPABASE_SERVICE_ROLE_KEY! };
}

const creds: Creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
const { url, serviceRole } = readServiceEnv();
const admin: SupabaseClient = createClient(url, serviceRole, {
  auth: { persistSession: false },
});

async function adminUserId(email: string): Promise<string | null> {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  return data.users.find((u) => u.email === email)?.id ?? null;
}

test.afterAll(async () => {
  const id = await adminUserId(creds.users.admin!.email);
  if (id) await admin.auth.admin.updateUserById(id, { password: creds.password });
});

test("reset de senha com MFA pede o código TOTP e conclui", async ({ page }) => {
  expect(creds.admin_totp?.secret, "seed deve gravar admin_totp").toBeTruthy();

  const link = await admin.auth.admin.generateLink({
    type: "recovery",
    email: creds.users.admin!.email,
  });
  const tokenHash = link.data.properties?.hashed_token;
  expect(tokenHash).toBeTruthy();

  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery`);
  await page.waitForURL(/\/login\/reset/);

  const temp = "TempReset!2026x";
  await page.locator("#password").fill(temp);
  await page.locator("#password_confirm").fill(temp);
  await page.getByRole("button", { name: /definir nova senha/i }).click();

  // Sem AAL2, o app revela o campo de código MFA em vez de falhar.
  await expect(page.locator("#mfa_code")).toBeVisible();

  if (msUntilNextTotpWindow() < 4_000) {
    await page.waitForTimeout(msUntilNextTotpWindow() + 300);
  }
  await page.locator("#mfa_code").fill(generateTotp(creds.admin_totp!.secret));
  await page.getByRole("button", { name: /definir nova senha/i }).click();

  await page.waitForURL(/\/login\?reset=success/);
  await expect(page.getByText(/redefinida com sucesso/i)).toBeVisible();
});
