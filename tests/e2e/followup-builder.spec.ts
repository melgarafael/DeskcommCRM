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
  // Canvas grande: com 4+ nós o fitView inicial pode chegar a zoom 2x (maxZoom
  // default) — um viewport pequeno deixa nós fora da área visível, e
  // coordenadas de handle fora do viewport quebram os drags de conexão.
  test.use({ viewport: { width: 1600, height: 900 } });

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

  /**
   * Drags from a node's source handle to another node's target handle.
   * `steps` on the 2nd move gives React Flow's connection-line drag enough
   * intermediate pointermove events to register the gesture reliably.
   */
  async function connectHandles(page: Page, sourceNodeId: string, targetNodeId: string): Promise<void> {
    const source = page.locator(`.react-flow__node[data-id="${sourceNodeId}"] .react-flow__handle.source`);
    const target = page.locator(`.react-flow__node[data-id="${targetNodeId}"] .react-flow__handle.target`);
    const sBox = await source.boundingBox();
    const tBox = await target.boundingBox();
    if (!sBox || !tBox) throw new Error(`handle não encontrado: ${sourceNodeId} -> ${targetNodeId}`);
    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sBox.x + sBox.width / 2 + 5, sBox.y + sBox.height / 2 + 5, { steps: 3 });
    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }

  test("adiciona os 4 nós via paleta e conecta trigger→wait→action→end", async ({ page }) => {
    await login(page, creds.users.manager!.email);

    await page.goto("/app/ai/followups");
    const flowName = `E2E Connect ${Date.now()}`;
    await page.getByRole("button", { name: "Novo fluxo" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nome").fill(flowName);
    await dialog.getByRole("button", { name: "Criar fluxo" }).click();
    await expect(dialog).not.toBeVisible();
    await page.locator("li", { hasText: flowName }).getByRole("link").click();
    await page.waitForURL(/\/app\/ai\/followups\/[0-9a-f-]+$/);
    await expect(page.locator(".react-flow")).toBeVisible();

    await page.getByTestId("palette-add-trigger").click();
    await page.getByTestId("palette-add-wait").click();
    await page.getByTestId("palette-add-action").click();
    await page.getByTestId("palette-add-end").click();

    const triggerCard = page.locator('[data-testid^="node-card-trigger-"]');
    const waitCard = page.locator('[data-testid^="node-card-wait-"]');
    const actionCard = page.locator('[data-testid^="node-card-action-"]');
    const endCard = page.locator('[data-testid^="node-card-end-"]');
    await expect(triggerCard).toBeVisible();
    await expect(waitCard).toBeVisible();
    await expect(actionCard).toBeVisible();
    await expect(endCard).toBeVisible();

    // fitView pode chegar ao maxZoom (2x) com poucos nós — zoom out garante
    // que todos os handles fiquem dentro do viewport pros drags de conexão.
    const zoomOut = page.locator(".react-flow__controls-zoomout");
    for (let i = 0; i < 5; i++) await zoomOut.click();

    const triggerId = await page.locator('.react-flow__node[data-id^="trigger-"]').getAttribute("data-id");
    const waitId = await page.locator('.react-flow__node[data-id^="wait-"]').getAttribute("data-id");
    const actionId = await page.locator('.react-flow__node[data-id^="action-"]').getAttribute("data-id");
    const endId = await page.locator('.react-flow__node[data-id^="end-"]').getAttribute("data-id");
    if (!triggerId || !waitId || !actionId || !endId) throw new Error("node ids ausentes");

    await connectHandles(page, triggerId, waitId);
    await connectHandles(page, waitId, actionId);
    await connectHandles(page, actionId, endId);

    await expect(page.locator(".react-flow__edge")).toHaveCount(3);
    await page.screenshot({ path: "test-results/followup-6.2-02-connected.png", fullPage: true });
  });
});
