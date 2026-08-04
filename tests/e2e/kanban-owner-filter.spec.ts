/**
 * G3-03 — filtro por responsável no board (deep-linkável via query param).
 *
 * Verifica: os dois leads seed aparecem (um com responsável, um "Sem
 * responsável"); ao filtrar por "Sem responsável" a URL ganha ?owner=unassigned
 * e o card com dono some. Login como manager (sem MFA; vê todos os leads da org).
 *
 * Pré-requisito: seed de credenciais + seed de kanban (rodados aqui se faltarem).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { rodaSeed } from "./helpers/seed";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  kanban?: { pipeline_id: string };
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
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.kanban?.pipeline_id) {
    rodaSeed("scripts/seed-e2e-kanban.ts");
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = loadCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test("filtro por responsável reflete na URL e esconde leads com dono", async ({ page }) => {
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/pipelines/${creds.kanban!.pipeline_id}`);

  const owned = page.getByRole("heading", { name: "Pedido E2E com responsavel" });
  const unowned = page.getByRole("heading", { name: "Pedido E2E sem responsavel" });
  await expect(owned).toBeVisible();
  await expect(unowned).toBeVisible();
  // A badge de ausência de dono está presente em ao menos um card.
  await expect(page.getByText("Sem responsável").first()).toBeVisible();

  // Abre o filtro de responsável e escolhe "Sem responsável".
  await page.getByRole("button", { name: /^Responsável:/ }).click();
  await page.getByRole("menuitem", { name: "Sem responsável" }).click();

  await expect(page).toHaveURL(/owner=unassigned/);
  await expect(unowned).toBeVisible();
  await expect(owned).toHaveCount(0);
});
