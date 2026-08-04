/**
 * Radar de Risco (C1 — desilhamento da doutrina do sistema vivo). Prova, na
 * perspectiva do usuário real: (1) o atendente entra no Radar e VÊ a demanda
 * aberta que esfriou (5 dias sem atividade, sem próximo passo) — o que antes
 * morria invisível no engine; (2) ele ASSUME a demanda direto da linha e a
 * responsabilidade passa a ser dele. Login como manager (sem MFA).
 *
 * O seed do radar roda a cada execução (reseta a conversa para "sem dono"), então
 * o teste de assumir é repetível.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { rodaSeed } from "./helpers/seed";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  radar?: { at_risk_title: string };
}

function loadCreds(): Creds {
  const needsBase = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (needsBase()) {
    rodaSeed("scripts/seed-e2e-credentials.ts");
  }
  // Sempre reseta o fixture do radar (conversa volta a ficar sem dono).
  rodaSeed("scripts/seed-e2e-radar.ts");
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function gotoRadar(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Radar" }).click();
  await page.waitForURL(/\/app\/radar/);
  await expect(page.getByRole("heading", { name: "Radar de risco" })).toBeVisible();
}

function radarItem(page: Page) {
  return page.locator('[data-testid="radar-item"]', { hasText: creds.radar!.at_risk_title });
}

test("o atendente vê no Radar a demanda aberta que esfriou sem próximo passo", async ({ page }) => {
  await login(page, creds.users.manager!.email);
  await gotoRadar(page);

  const item = radarItem(page);
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("data-risk", "critico");
  await expect(item.getByText("Crítico")).toBeVisible();
  await expect(item.getByText(/Sem próximo passo/)).toBeVisible();
});

test("o atendente assume a demanda direto do Radar e vira o responsável", async ({ page }) => {
  await login(page, creds.users.manager!.email);
  await gotoRadar(page);

  const item = radarItem(page);
  await expect(item).toBeVisible();
  await expect(item.getByTestId("radar-assignee")).toHaveText("Sem dono");

  await item.getByTestId("radar-claim").click();

  // Após assumir, o radar recarrega: a demanda passa a ter atendente e o botão some.
  await expect(radarItem(page).getByTestId("radar-assignee")).toHaveText("Com atendente");
  await expect(radarItem(page).getByTestId("radar-claim")).toHaveCount(0);
});
