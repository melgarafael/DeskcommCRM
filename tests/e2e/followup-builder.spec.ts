/**
 * Task 6.1 — página + lista de fluxos de follow-up.
 *
 * Critério de aceite (1): logado como MANAGER, navega pra /app/ai/followups →
 * clica "Novo fluxo" → digita um nome → o fluxo aparece na lista com badge
 * "Rascunho". Task 6.2 estende este spec com o editor visual (grafo).
 *
 * Sem endpoint DELETE em followup-flows (decisão deliberada da Onda 3+ —
 * fluxos não se apagam, só se desativam). Cada run usa um nome com timestamp
 * único, então não colide entre execuções; os drafts de teste se acumulam no
 * banco e exigem um sweep manual periódico (fora do escopo desta task).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const needsSeed = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (needsSeed()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
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

test.describe("followup flows — lista + criação (Task 6.1)", () => {
  test("manager cria um fluxo e ele aparece na lista com badge Rascunho", async ({ page }) => {
    await login(page, creds.users.manager!.email);

    await page.goto("/app/ai/followups");
    await expect(page.getByRole("heading", { name: "Follow-ups" })).toBeVisible();
    await page.screenshot({ path: "test-results/followup-6.1-01-list.png", fullPage: true });

    const flowName = `E2E Follow-up ${Date.now()}`;

    await page.getByRole("button", { name: "Novo fluxo" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Novo fluxo de follow-up")).toBeVisible();
    await page.screenshot({ path: "test-results/followup-6.1-02-dialog-open.png", fullPage: true });

    const nameInput = dialog.getByLabel("Nome");
    await expect(nameInput).toBeFocused();
    await nameInput.fill(flowName);
    await page.screenshot({ path: "test-results/followup-6.1-03-name-typed.png", fullPage: true });

    await dialog.getByRole("button", { name: "Criar fluxo" }).click();
    await expect(dialog).not.toBeVisible();

    const card = page.locator("li", { hasText: flowName });
    await expect(card).toBeVisible();
    await expect(card.getByText("Rascunho", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/followup-6.1-04-flow-in-list.png", fullPage: true });
  });

  test("viewer não vê o botão de criar fluxo (RBAC)", async ({ page }) => {
    await login(page, creds.users.viewer!.email);
    await page.goto("/app/ai/followups");
    await page.waitForURL(/\/403/);
  });
});

test.describe("followup flow builder — canvas visual (Task 6.2)", () => {
  test("manager cria um fluxo, clica na linha e o canvas React Flow abre", async ({ page }) => {
    await login(page, creds.users.manager!.email);

    await page.goto("/app/ai/followups");
    const flowName = `E2E Builder ${Date.now()}`;
    await page.getByRole("button", { name: "Novo fluxo" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nome").fill(flowName);
    await dialog.getByRole("button", { name: "Criar fluxo" }).click();
    await expect(dialog).not.toBeVisible();

    const card = page.locator("li", { hasText: flowName });
    await expect(card).toBeVisible();
    await card.getByRole("link").click();

    await page.waitForURL(/\/app\/ai\/followups\/[0-9a-f-]+$/);
    await expect(page.getByTestId("flow-builder-shell")).toBeVisible();
    await expect(page.getByTestId("flow-canvas")).toBeVisible();
    await expect(page.getByTestId("node-palette")).toBeVisible();
    // React Flow's own pane element — proves the dynamically-imported canvas actually mounted.
    await expect(page.locator(".react-flow")).toBeVisible();
    await page.screenshot({ path: "test-results/followup-6.2-01-canvas-empty.png", fullPage: true });
  });
});
