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

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
// test-results/ é limpo pelo outputDir do Playwright a cada run — preserva a
// prova da Task 7.2 aqui (mesmo padrão de followup-queue.spec.ts).
const ARTIFACTS_DIR = path.join(process.cwd(), "e2e-artifacts");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  admin_totp?: { factor_id: string; secret: string };
  followup_agent_fixtures?: { credential_id: string; channel_session_id: string };
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

/**
 * Login com MFA TOTP (mesmo padrão de rbac-roles.spec.ts). Necessário pro
 * admin: o editor de agente (`AgentForm.tsx`) passa `readOnly` quando
 * `role<admin` (page.tsx §RBAC — manager só VÊ o formulário, não salva), e a
 * Task 7.2 precisa salvar o rascunho.
 */
async function loginWithTotp(page: Page, email: string, secret: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/login\/mfa/);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (msUntilNextTotpWindow() < 3_000) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
    const code = generateTotp(secret);
    const firstDigit = page.locator('input[aria-label="Dígito 1"]');
    await firstDigit.click();
    await page.keyboard.type(code, { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 8_000 });
      return;
    } catch {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA challenge failed after 2 TOTP attempts");
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
    // Achado ao rodar a suíte completa desta task: este teste ficou
    // desatualizado pela Task 7.1 (commit 6546271, já na main deste worktree
    // antes desta sessão) — o gate de PÁGINA que redirecionava viewer pra
    // /403 foi deliberadamente relaxado (viewer é dono da aba "Fila"; só
    // "Fluxos" exige manager+ via `canWrite` DENTRO da aba, não mais na
    // rota). A asserção velha (`waitForURL(/\/403/)`) nunca mais bate —
    // corrigida aqui pra refletir o RBAC atual: a página carrega, mas o
    // botão "Novo fluxo" não aparece pro viewer.
    await login(page, creds.users.viewer!.email);
    await page.goto("/app/ai/followups");
    await expect(page.getByRole("heading", { name: "Follow-ups" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Novo fluxo" })).toHaveCount(0);
  });
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

/** All React Flow node ids currently rendered whose id starts with `${prefix}-`, in DOM order. */
async function nodeIdsByPrefix(page: Page, prefix: string): Promise<string[]> {
  const els = await page.locator(`.react-flow__node[data-id^="${prefix}-"]`).all();
  const ids: string[] = [];
  for (const el of els) {
    const id = await el.getAttribute("data-id");
    if (id) ids.push(id);
  }
  return ids;
}

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

  test("clica no nó Aguardar e configura 10min; clica no nó Ação e configura o prompt_hint", async ({ page }) => {
    await login(page, creds.users.manager!.email);

    await page.goto("/app/ai/followups");
    const flowName = `E2E Config ${Date.now()}`;
    await page.getByRole("button", { name: "Novo fluxo" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nome").fill(flowName);
    await dialog.getByRole("button", { name: "Criar fluxo" }).click();
    await expect(dialog).not.toBeVisible();
    await page.locator("li", { hasText: flowName }).getByRole("link").click();
    await page.waitForURL(/\/app\/ai\/followups\/[0-9a-f-]+$/);
    await expect(page.locator(".react-flow")).toBeVisible();

    await page.getByTestId("palette-add-wait").click();
    await page.getByTestId("palette-add-action").click();

    // Wait node → 10 min.
    await page.locator('[data-testid^="node-card-wait-"]').click();
    const panel = page.getByTestId("node-config-panel");
    await expect(panel).toBeVisible();
    const durationInput = panel.getByLabel("Duração (minutos)");
    await durationInput.fill("10");
    await durationInput.blur();
    // Subtitle on the card derives straight from committed config — proves the
    // panel wrote through to the live FlowGraph state, not just local form state.
    await expect(page.locator('[data-testid^="node-card-wait-"]')).toContainText("10 min");
    await page.screenshot({ path: "test-results/followup-6.2-03-wait-configured.png", fullPage: true });

    // Action node → prompt_hint.
    await page.locator('[data-testid^="node-card-action-"]').click();
    const promptHint = panel.getByLabel("Instrução para a IA");
    await promptHint.fill("Reforce o benefício e pergunte se ainda tem interesse.");
    await promptHint.blur();
    await expect(page.locator('[data-testid^="node-card-action-"]')).toContainText("Reforce o benefício");
    await page.screenshot({ path: "test-results/followup-6.2-04-action-configured.png", fullPage: true });
  });

  /**
   * MANDATORY acceptance sequence (Task 6.2 wave gate): build the graph,
   * publish it INCOMPLETE first (errors anchored to the offending nodes, not
   * a generic banner), fix it, publish for real, reload and prove the graph
   * persisted identically, and confirm Rollback is disabled with 1 version.
   */
  test("fluxo completo: montar, publicar incompleto (422 ancorado), corrigir, publicar, recarregar, rollback desabilitado", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email);

    await page.goto("/app/ai/followups");
    const flowName = `E2E Acceptance ${Date.now()}`;
    await page.getByRole("button", { name: "Novo fluxo" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nome").fill(flowName);
    await dialog.getByRole("button", { name: "Criar fluxo" }).click();
    await expect(dialog).not.toBeVisible();
    await page.locator("li", { hasText: flowName }).getByRole("link").click();
    await page.waitForURL(/\/app\/ai\/followups\/([0-9a-f-]+)$/);
    const flowUrl = page.url();
    await expect(page.locator(".react-flow")).toBeVisible();

    // 1. Build: trigger + wait + action + end.
    await page.getByTestId("palette-add-trigger").click();
    await page.getByTestId("palette-add-wait").click();
    await page.getByTestId("palette-add-action").click();
    await page.getByTestId("palette-add-end").click();

    const zoomOut = page.locator(".react-flow__controls-zoomout");
    for (let i = 0; i < 5; i++) await zoomOut.click();

    const triggerId = await page.locator('.react-flow__node[data-id^="trigger-"]').getAttribute("data-id");
    const waitId = await page.locator('.react-flow__node[data-id^="wait-"]').getAttribute("data-id");
    const actionId = await page.locator('.react-flow__node[data-id^="action-"]').getAttribute("data-id");
    const endId = await page.locator('.react-flow__node[data-id^="end-"]').getAttribute("data-id");
    if (!triggerId || !waitId || !actionId || !endId) throw new Error("node ids ausentes");

    // 2. Connect trigger→wait→action — deliberately WITHOUT wiring to end yet.
    await connectHandles(page, triggerId, waitId);
    await connectHandles(page, waitId, actionId);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);

    // 3. Configure wait=10min + action prompt_hint.
    await page.locator(`[data-testid="node-card-${waitId}"]`).click();
    const panel = page.getByTestId("node-config-panel");
    await panel.getByLabel("Duração (minutos)").fill("10");
    await panel.getByLabel("Duração (minutos)").blur();
    await expect(page.locator(`[data-testid="node-card-${waitId}"]`)).toContainText("10 min");

    await page.locator(`[data-testid="node-card-${actionId}"]`).click();
    await panel.getByLabel("Instrução para a IA").fill("Reforce o benefício e pergunte se ainda tem interesse.");
    await panel.getByLabel("Instrução para a IA").blur();
    await expect(page.locator(`[data-testid="node-card-${actionId}"]`)).toContainText("Reforce o benefício");
    // Close the config panel — it's a docked aside that narrows the canvas and
    // can occlude nodes, which would break the next handle-to-handle drag.
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("node-config-sheet")).toHaveCount(0);
    await page.screenshot({ path: "test-results/followup-6.2-05-built-incomplete.png", fullPage: true });

    // 4. Publish INCOMPLETE — expect 422 anchored to the offending nodes.
    await page.getByTestId("publish-button").click();
    await expect(page.getByText(/reprovado na validação/i)).toBeVisible();
    await expect(page.locator(`[data-testid="node-error-${waitId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="node-error-${actionId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="node-error-${endId}"]`)).toBeVisible();
    await page.screenshot({ path: "test-results/followup-6.2-06-publish-422-anchored.png", fullPage: true });

    // 5. Fix: connect action→end.
    await connectHandles(page, actionId, endId);
    await expect(page.locator(".react-flow__edge")).toHaveCount(3);

    // 6. Publish for real — expect success + "Ativo" badge + toast.
    await page.getByTestId("publish-button").click();
    await expect(page.getByText("Fluxo publicado.")).toBeVisible();
    await expect(page.locator('[aria-label="status: Ativo"]')).toBeVisible();
    await expect(page.locator(`[data-testid="node-error-${waitId}"]`)).toHaveCount(0);
    await page.screenshot({ path: "test-results/followup-6.2-07-published.png", fullPage: true });

    // Normalize the viewport (pan/zoom drifted from the manual connect drags)
    // so the before/after position comparison isn't comparing two arbitrary
    // transforms — both sides fit the same 4 nodes to the same container.
    await page.locator(".react-flow__controls-fitview").click();
    // fitView's viewport transform settles on the next animation frame(s) —
    // under load (full suite run) reading positions immediately can catch a
    // mid-transition frame. Wait for it to settle before the "before" capture.
    await page.waitForTimeout(400);

    const positionsBefore: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const id of [triggerId, waitId, actionId, endId]) {
      const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
      if (!box) throw new Error(`nó ${id} sem bounding box antes do reload`);
      positionsBefore[id] = box;
    }

    // 7. Reload — the graph must persist identically.
    await page.reload();
    await page.waitForURL(flowUrl);
    await expect(page.locator(".react-flow")).toBeVisible();
    await expect(page.locator('[aria-label="status: Ativo"]')).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await expect(page.locator(".react-flow__edge")).toHaveCount(3);
    await expect(page.locator(`[data-testid="node-card-${waitId}"]`)).toContainText("10 min");
    await expect(page.locator(`[data-testid="node-card-${actionId}"]`)).toContainText("Reforce o benefício");
    // Same settle wait as the "before" capture — the post-reload fitView (on
    // mount) needs the same grace period before its transform is comparable.
    await page.waitForTimeout(400);

    const TOLERANCE_PX = 10;
    for (const id of [triggerId, waitId, actionId, endId]) {
      const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
      if (!box) throw new Error(`nó ${id} sem bounding box depois do reload`);
      const before = positionsBefore[id]!;
      expect(Math.abs(box.x - before.x)).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(Math.abs(box.y - before.y)).toBeLessThanOrEqual(TOLERANCE_PX);
    }
    await page.screenshot({ path: "test-results/followup-6.2-08-reloaded-persisted.png", fullPage: true });

    // 8. Rollback disabled — only 1 version exists (this is the first publish).
    await expect(page.getByTestId("rollback-button")).toBeDisabled();
  });
});

test.describe("followup flow builder — editor de condição de aresta / ai_classify (Task 6.3)", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  /**
   * The palette's default add-position grid (`addNodeAt` in FlowCanvas) lays
   * nodes out in same-height rows 220px apart — narrower than a card's own
   * 224px width, and blind to each card's Top/Bottom handle orientation. For
   * a >4-node branching graph that produces overlapping cards and looping
   * bezier edges whose label sits under a neighboring card. Dragging each
   * node (by its header, away from the Top/Bottom handles) to an explicit,
   * handle-respecting position — sources above targets, siblings apart on X —
   * is what a real user would do before wiring a non-trivial flow; this
   * mirrors that instead of fighting the demo grid.
   */
  async function moveNodeTo(page: Page, nodeId: string, targetX: number, targetY: number): Promise<void> {
    const card = page.locator(`[data-testid="node-card-${nodeId}"]`);
    const box = await card.boundingBox();
    if (!box) throw new Error(`nó ${nodeId} sem bounding box`);
    const startX = box.x + box.width / 2;
    const startY = box.y + 20; // inside the header, clear of the Top handle
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move((startX + targetX) / 2, (startY + targetY) / 2, { steps: 5 });
    await page.mouse.move(targetX, targetY, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  }

  /**
   * Clicks an edge's own condition-label background rect (always present —
   * every edge renders a label from Task 6.3's `edgesForRender`, defaulting to
   * "Sempre") — a precise, always-solid hit target, instead of guessing where
   * on the curved path the bounding-box center lands.
   */
  async function clickEdge(page: Page, edgeId: string): Promise<void> {
    await page.locator(`[data-testid="rf__edge-${edgeId}"] .react-flow__edge-textbg`).click();
  }

  async function setEdgeCondition(page: Page, edgeId: string, optionLabel: string): Promise<void> {
    await clickEdge(page, edgeId);
    const edgePanel = page.getByTestId("edge-config-panel");
    await expect(edgePanel).toBeVisible();
    await edgePanel.getByRole("combobox").click();
    await page.getByRole("option", { name: optionLabel, exact: true }).click();
  }

  /**
   * MANDATORY acceptance (Task 6.3 wave gate): the SAME graph shape — trigger
   * → ai_classify(2 classes) → 2 actions → 2 ends — genuinely fails publish
   * while every classify-outgoing edge is still the hardcoded `always` from
   * Task 6.2 (`missing_class_edge`/`missing_no_reply_edge`, anchored to the
   * classify node), and genuinely succeeds once the new EdgeConfigPanel is
   * used to set `class_match`/`always` per edge. That flip is the whole point
   * of this task: the editor is what unblocks ai_classify in the canvas.
   */
  test("ai_classify só publica depois de configurar class_match/no_reply/always nas arestas de saída", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email);

    await page.goto("/app/ai/followups");
    const flowName = `E2E Classify ${Date.now()}`;
    await page.getByRole("button", { name: "Novo fluxo" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nome").fill(flowName);
    await dialog.getByRole("button", { name: "Criar fluxo" }).click();
    await expect(dialog).not.toBeVisible();
    await page.locator("li", { hasText: flowName }).getByRole("link").click();
    await page.waitForURL(/\/app\/ai\/followups\/[0-9a-f-]+$/);
    await expect(page.locator(".react-flow")).toBeVisible();

    // 1. Build: trigger, ai_classify, 2x action, 2x end. Two ends are required, not
    // decorative: a classify node needs 4 distinct outgoing edges (positivo, objecao,
    // no_reply, always-fallback) and React Flow's own `addEdge` refuses a 2nd edge
    // between the same (source, target, handle) pair — no_reply and the always
    // fallback can't both point at a single "end" node.
    await page.getByTestId("palette-add-trigger").click();
    await page.getByTestId("palette-add-ai_classify").click();
    await page.getByTestId("palette-add-action").click();
    await page.getByTestId("palette-add-action").click();
    await page.getByTestId("palette-add-end").click();
    await page.getByTestId("palette-add-end").click();

    const triggerId = await page.locator('.react-flow__node[data-id^="trigger-"]').getAttribute("data-id");
    const classifyId = await page.locator('.react-flow__node[data-id^="ai_classify-"]').getAttribute("data-id");
    const [action1Id, action2Id] = await nodeIdsByPrefix(page, "action");
    const [end1Id, end2Id] = await nodeIdsByPrefix(page, "end");
    if (!triggerId || !classifyId || !action1Id || !action2Id || !end1Id || !end2Id) {
      throw new Error("node ids ausentes");
    }

    // `fitView` re-fits (and can hit its 2x maxZoom) every time a newly-added node
    // finishes its first measurement — settle it to a known, stable zoom BEFORE doing
    // any screen-space math below, or the 6 sequential palette adds keep moving the
    // goalposts mid-repositioning (see the 6.2 canvas test for the same caveat).
    const zoomOut = page.locator(".react-flow__controls-zoomout");
    for (let i = 0; i < 6; i++) await zoomOut.click();
    await page.waitForTimeout(300);

    // 1b. Spread the 6 nodes into a real branching layout (source above target, siblings
    // apart on X) — see `moveNodeTo` for why the default add-grid can't be used here.
    const canvasBox = await page.getByTestId("flow-canvas").boundingBox();
    if (!canvasBox) throw new Error("flow-canvas sem bounding box");
    const at = (dx: number, dy: number): [number, number] => [canvasBox.x + dx, canvasBox.y + dy];
    await moveNodeTo(page, triggerId, ...at(150, 60));
    await moveNodeTo(page, classifyId, ...at(150, 220));
    await moveNodeTo(page, action1Id, ...at(50, 420));
    await moveNodeTo(page, action2Id, ...at(400, 420));
    await moveNodeTo(page, end1Id, ...at(225, 620));
    await moveNodeTo(page, end2Id, ...at(650, 220));

    // 2. Configure ai_classify classes = positivo, objecao (replacing the hot/cold default).
    await page.locator(`[data-testid="node-card-${classifyId}"]`).click();
    const panel = page.getByTestId("node-config-panel");
    await panel.getByLabel("Classes (separadas por vírgula)").fill("positivo, objecao");
    await panel.getByLabel("Classes (separadas por vírgula)").blur();
    await expect(page.locator(`[data-testid="node-card-${classifyId}"]`)).toContainText("2 classes");

    // 3. Configure the 2 action nodes' prompt_hint.
    await page.locator(`[data-testid="node-card-${action1Id}"]`).click();
    await panel.getByLabel("Instrução para a IA").fill("Envie uma oferta especial reforçando o interesse.");
    await panel.getByLabel("Instrução para a IA").blur();
    await page.locator(`[data-testid="node-card-${action2Id}"]`).click();
    await panel.getByLabel("Instrução para a IA").fill("Pergunte com empatia qual é a objeção específica.");
    await panel.getByLabel("Instrução para a IA").blur();

    // Close the config panel — docked aside narrows the canvas, would break the drags below.
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("node-config-sheet")).toHaveCount(0);

    // 4. Connect the graph. Order fixes each edge's deterministic id (edge-1..edge-7 —
    // FlowCanvas assigns ids from a monotonic counter in connection order).
    await connectHandles(page, triggerId, classifyId); // edge-1: trigger -> classify
    await connectHandles(page, classifyId, action1Id); // edge-2: classify -> action1
    await connectHandles(page, classifyId, action2Id); // edge-3: classify -> action2
    await connectHandles(page, classifyId, end1Id); // edge-4: classify -> end1 (will become no_reply)
    await connectHandles(page, classifyId, end2Id); // edge-5: classify -> end2 (stays always-fallback)
    await connectHandles(page, action1Id, end1Id); // edge-6: action1 -> end1
    await connectHandles(page, action2Id, end1Id); // edge-7: action2 -> end1
    await expect(page.locator(".react-flow__edge")).toHaveCount(7);
    await page.screenshot({ path: "test-results/followup-6.3-01-built.png", fullPage: true });

    // 5. NEGATIVE CHECK — publish with every classify-outgoing edge still `always` (the
    // Task 6.2 state, before this task's editor existed). It must fail: `ai_classify`
    // has no `class_match` edge for either declared class and no `no_reply` edge.
    await page.getByTestId("publish-button").click();
    await expect(page.getByText(/reprovado na validação/i)).toBeVisible();
    await expect(page.locator(`[data-testid="node-error-${classifyId}"]`)).toBeVisible();
    // Exactly one node carries an error — proves the failure is scoped to the classify
    // node's edge coverage, not some unrelated structural problem in the graph.
    await expect(page.locator('[data-testid^="node-error-"]')).toHaveCount(1);
    const classifyErrorText = await page.locator(`[data-testid="node-error-${classifyId}"]`).textContent();
    expect(classifyErrorText).toMatch(/class_match|no_reply/i);
    await page.screenshot({ path: "test-results/followup-6.3-02-publish-422-all-always.png", fullPage: true });

    // 6. Fix it: use the new EdgeConfigPanel to set each classify-outgoing edge's condition.
    await setEdgeCondition(page, "edge-2", "positivo");
    await setEdgeCondition(page, "edge-3", "objecao");
    await setEdgeCondition(page, "edge-4", "Sem resposta");
    // edge-5 is already the "always" fallback by default — open it and confirm rather
    // than change it, proving the option is genuinely selected, not just left untouched.
    await clickEdge(page, "edge-5");
    await expect(page.getByTestId("edge-config-panel").getByRole("combobox")).toContainText("Sempre");

    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("edge-config-sheet")).toHaveCount(0);
    await page.screenshot({ path: "test-results/followup-6.3-03-edges-configured.png", fullPage: true });

    // 7. Publish for real — expect SUCCESS this time, where the identical graph shape
    // with all-`always` edges failed above.
    await page.getByTestId("publish-button").click();
    await expect(page.getByText("Fluxo publicado.")).toBeVisible();
    await expect(page.locator('[aria-label="status: Ativo"]')).toBeVisible();
    await expect(page.locator(`[data-testid="node-error-${classifyId}"]`)).toHaveCount(0);

    // 8. Prove the wire labels reflect each condition — the acceptance screenshot.
    await expect(page.getByTestId("rf__edge-edge-2")).toContainText("positivo");
    await expect(page.getByTestId("rf__edge-edge-3")).toContainText("objecao");
    await expect(page.getByTestId("rf__edge-edge-4")).toContainText("Sem resposta");
    await expect(page.getByTestId("rf__edge-edge-5")).toContainText("Sempre");
    await page.locator(".react-flow__controls-fitview").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/followup-6.3-04-published-branching.png", fullPage: true });
  });
});

/**
 * Task 7.2 — seletor de fluxo no editor do agente.
 *
 * Setup 100% via API (não UI): publica um fluxo mínimo trigger→end como
 * admin (mesmo padrão de followup-queue.spec.ts), cria um mcp_agent + v1
 * draft via `POST /api/v1/ai/agents` usando as fixtures de credential/canal
 * seedadas por scripts/seed-e2e-followup-agent.ts (não existe rota pública
 * pra credential validada nem fixture pronta no repo — grep confirmou).
 * Login como ADMIN (não manager, como o brief original sugeria): o gate de
 * `page.tsx` deixa manager VER o formulário mas `readOnly=true` — só admin
 * salva (achado ao ler o RBAC real antes de escrever o teste).
 */
test.describe("followup flow selector no editor do agente (Task 7.2)", () => {
  test.beforeAll(() => {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-followup-agent.ts"], { stdio: "inherit" });
  });

  test("admin vincula um fluxo publicado ao agente, salva, e a persistência é provada via API", async ({
    page,
  }) => {
    expect(creds.admin_totp?.secret, "seed deve gravar admin_totp em .e2e-creds.json").toBeTruthy();
    expect(
      creds.followup_agent_fixtures,
      "seed-e2e-followup-agent.ts deve gravar followup_agent_fixtures",
    ).toBeTruthy();
    await loginWithTotp(page, creds.users.admin!.email, creds.admin_totp!.secret);

    // --- 1. publica um fluxo mínimo trigger→end via API ---
    const stamp = Date.now();
    const flowName = `E2E Seletor ${stamp}`;
    const createFlowRes = await page.request.post("/api/v1/ai/followup-flows", { data: { name: flowName } });
    expect(createFlowRes.status()).toBe(201);
    const { data: flow } = (await createFlowRes.json()) as { data: { id: string } };

    const graph = {
      nodes: [
        { id: "trigger-1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        { id: "end-1", type: "end", label: "Fim", position: { x: 0, y: 200 }, config: { outcome: "exhausted" } },
      ],
      edges: [{ id: "edge-1", source: "trigger-1", target: "end-1", priority: 0, condition: { type: "always" } }],
    };
    const patchRes = await page.request.patch(`/api/v1/ai/followup-flows/${flow.id}`, {
      data: { draft_graph: graph },
    });
    expect(patchRes.status()).toBe(200);
    const publishRes = await page.request.post(`/api/v1/ai/followup-flows/${flow.id}/publish`, { data: {} });
    expect(publishRes.status()).toBe(200);

    // --- 2. cria um mcp_agent + v1 draft via API, usando as fixtures seedadas ---
    const fixtures = creds.followup_agent_fixtures!;
    const agentName = `E2E Agente Follow-up ${stamp}`;
    const createAgentRes = await page.request.post("/api/v1/ai/agents", {
      data: {
        name: agentName,
        version: {
          system_prompt: "Você é um atendente de teste E2E. Responda de forma clara em pt-BR.",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          credential_id: fixtures.credential_id,
          channel_session_id: fixtures.channel_session_id,
        },
      },
    });
    expect(createAgentRes.status()).toBe(201);
    const { data: created } = (await createAgentRes.json()) as {
      data: { agent: { id: string }; version: { id: string; followup: { enabled: boolean; flow_pointer_ids: string[] } } };
    };
    const agentId = created.agent.id;
    const versionId = created.version.id;

    // Nasce com o default aditivo (enabled=false, []) — prova que o schema novo
    // não quebra a criação de um agent que nunca falou de follow-up.
    expect(created.version.followup).toEqual({ enabled: false, flow_pointer_ids: [] });

    // --- 3. abre o editor, habilita o toggle e seleciona o fluxo publicado ---
    await page.goto(`/app/ai/agents/${agentId}`);
    await expect(page.getByRole("heading", { name: agentName })).toBeVisible();

    const followupHeading = page.getByRole("heading", { name: "Follow-up", exact: true });
    await followupHeading.scrollIntoViewIfNeeded();
    await expect(followupHeading).toBeVisible();

    const followupToggle = page.getByLabel("Habilitar gatilhos automáticos de follow-up");
    await expect(followupToggle).not.toBeChecked();
    await followupToggle.click();
    await expect(followupToggle).toBeChecked();

    const flowCheckbox = page.getByLabel(flowName, { exact: true });
    await expect(flowCheckbox).toBeVisible();
    await flowCheckbox.check();
    await expect(flowCheckbox).toBeChecked();
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "followup-7.2-01-flow-selected.png"),
      fullPage: true,
    });

    // --- 4. salva o rascunho ---
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    await expect(page.getByText(/Rascunho v\d+ salvo\./)).toBeVisible();
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "followup-7.2-02-saved.png"),
      fullPage: true,
    });

    // --- 5. prova via API (não só UI): a version persistida tem enabled=true
    // e flow_pointer_ids contendo o id do fluxo publicado ---
    const versionRes = await page.request.get(`/api/v1/ai/agents/${agentId}/versions/${versionId}`);
    expect(versionRes.status()).toBe(200);
    const { data: persisted } = (await versionRes.json()) as {
      data: { followup: { enabled: boolean; flow_pointer_ids: string[] } };
    };
    expect(persisted.followup.enabled).toBe(true);
    expect(persisted.followup.flow_pointer_ids).toContain(flow.id);

    // Cleanup: arquiva o agent de teste + desativa o fluxo (reduz acúmulo).
    await page.request.delete(`/api/v1/ai/agents/${agentId}`);
    await page.request.post(`/api/v1/ai/followup-flows/${flow.id}/disable`, { data: {} });
  });
});

test.describe("followup flow builder — controle de gatilho na PublishBar (Task 8.5)", () => {
  test("operador arma o gatilho de Silêncio (threshold) pela UI; oferece só Manual/Silêncio; PATCH round-trips", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email);

    const createRes = await page.request.post("/api/v1/ai/followup-flows", {
      data: { name: `E2E Gatilho ${Date.now()}` },
    });
    expect(createRes.status()).toBe(201);
    const { data: flow } = (await createRes.json()) as { data: { id: string } };

    try {
      await page.goto(`/app/ai/followups/${flow.id}`);
      await expect(page.getByTestId("flow-builder-shell")).toBeVisible();

      // Draft novo nasce trigger_config={kind:'manual'} — o botão mostra isso sem precisar abrir o popover.
      const triggerButton = page.getByTestId("trigger-config-button");
      await expect(triggerButton).toHaveText("Gatilho: Manual");

      await triggerButton.click();
      const panel = page.getByTestId("trigger-config-panel");
      await expect(panel).toBeVisible();
      await page.screenshot({ path: "e2e-artifacts/followup-8.5-01-trigger-panel-manual.png", fullPage: true });

      // Só Manual e Silêncio são oferecidos — stage_change/conversation_end não têm motor de enrollment.
      const kindSelect = panel.getByRole("combobox");
      await kindSelect.click();
      await expect(page.getByRole("option")).toHaveCount(2);
      await expect(page.getByRole("option", { name: "Manual", exact: true })).toBeVisible();
      await expect(page.getByRole("option", { name: "Silêncio", exact: true })).toBeVisible();
      await expect(page.getByRole("option", { name: /stage_change|conversation_end/i })).toHaveCount(0);

      await page.getByRole("option", { name: "Silêncio", exact: true }).click();
      await expect(panel.getByLabel("Minutos de silêncio")).toBeVisible();

      const thresholdInput = panel.getByLabel("Minutos de silêncio");
      await thresholdInput.fill("45");

      const saveButton = panel.getByTestId("trigger-config-save");
      await expect(saveButton).toBeEnabled();
      await page.screenshot({ path: "e2e-artifacts/followup-8.5-02-trigger-silence-filled.png", fullPage: true });
      await saveButton.click();

      await expect(page.getByText("Gatilho atualizado.")).toBeVisible();
      await expect(triggerButton).toHaveText("Gatilho: Silêncio (45 min)");
      await page.screenshot({ path: "e2e-artifacts/followup-8.5-03-trigger-saved.png", fullPage: true });

      // Reload — o valor persistido (PATCH round-trip) sobrevive, não é só estado local.
      await page.reload();
      await expect(page.getByTestId("trigger-config-button")).toHaveText("Gatilho: Silêncio (45 min)");

      // Prova via API (não só UI): GET devolve o trigger_config exato que foi salvo.
      const getRes = await page.request.get(`/api/v1/ai/followup-flows/${flow.id}`);
      expect(getRes.status()).toBe(200);
      const { data: persisted } = (await getRes.json()) as {
        data: { trigger_config: { kind: string; params?: { threshold_minutes?: number } } };
      };
      expect(persisted.trigger_config.kind).toBe("silence");
      expect(persisted.trigger_config.params?.threshold_minutes).toBe(45);
    } finally {
      // O fluxo nunca foi publicado (fica em 'draft') — nenhum enrollment
      // possível daqui. Desativa mesmo assim (doutrina da task: qualquer
      // fluxo criado pelo spec sai desativado, sem depender de estar 'active').
      await page.request.post(`/api/v1/ai/followup-flows/${flow.id}/disable`, { data: {} });
    }
  });
});
