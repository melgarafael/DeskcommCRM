import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Jornada da Recompra (Radar sobre pedidos reais).
 *
 * Seed com 5 vendas espaçadas ~22 dias e última há 30 → "Recompra atrasada".
 * Sem tocar em lead, conversa ou follow-up: a fonte é commercial_orders.
 */
const RAIZ = path.join(__dirname, "..", "..");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
}

async function entrar(page: Page, creds: Creds) {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test.beforeAll(() => {
  execFileSync("npx", ["tsx", "scripts/seed-e2e-recompra.ts"], { stdio: "inherit", cwd: RAIZ });
});

test("recompra atrasada aparece com atraso e link para os pedidos", async ({ page }) => {
  const creds = lerCreds();
  await entrar(page, creds);
  await page.goto("/app/radar");

  await expect(page.getByRole("button", { name: /recompra/i }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Mercado E2E Recompra", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/recompra atrasada/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/\+8/i).first()).toBeVisible({ timeout: 20_000 });

  const verPedidos = page.getByRole("link", { name: /ver pedidos/i }).first();
  await expect(verPedidos).toBeVisible({ timeout: 20_000 });
  await verPedidos.click();
  await page.waitForURL(/\/app\/contacts\//, { timeout: 20_000 });
  await expect(page.getByText("Mercado E2E Recompra", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
});
