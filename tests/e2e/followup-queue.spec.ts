/**
 * Task 7.1 — fila unificada (enrollments + promessas) + cancelar + aba.
 *
 * Setup via API (não UI) como manager: publica um fluxo mínimo trigger→end,
 * cria um contato e um enrollment manual — aparece na fila imediatamente
 * (next_eval_at=now no trigger). A promessa (cron_jobs kind='at' +
 * job_kind='followup_turn') não tem rota pública de criação — só a tool do
 * agente de IA em runtime cria esse tipo de linha — então
 * scripts/seed-e2e-followup-promise.ts a semeia direto via service role
 * (mesmo padrão de scripts/seed-e2e-queue.ts), rodado 1x em beforeAll.
 *
 * Cada run usa nome de fluxo/contato com timestamp único — não colide entre
 * execuções; os registros de teste se acumulam no banco (mesma doutrina do
 * followup-builder.spec.ts), sweep manual fora do escopo desta task.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  followup_promise?: { contact_name: string; reason: string; promise: string };
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

interface ApiOk<T> {
  data: T;
}

test.describe("followup queue — fila unificada (Task 7.1)", () => {
  test.beforeAll(() => {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-followup-promise.ts"], { stdio: "inherit" });
  });

  test("manager vê enrollment na fila, filtra por status/fluxo, cancela, e a promessa seedada aparece", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email);

    const stamp = Date.now();
    const flowName = `E2E Fila ${stamp}`;
    const contactName = `Cliente Fila E2E ${stamp}`;

    // --- setup via API: fluxo mínimo trigger->end, publicado ---
    const createFlowRes = await page.request.post("/api/v1/ai/followup-flows", {
      data: { name: flowName },
    });
    expect(createFlowRes.status()).toBe(201);
    const { data: flow } = (await createFlowRes.json()) as ApiOk<{ id: string }>;

    const graph = {
      nodes: [
        { id: "trigger-1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        {
          id: "end-1",
          type: "end",
          label: "Fim",
          position: { x: 0, y: 200 },
          config: { outcome: "exhausted" },
        },
      ],
      edges: [
        { id: "edge-1", source: "trigger-1", target: "end-1", priority: 0, condition: { type: "always" } },
      ],
    };
    const patchRes = await page.request.patch(`/api/v1/ai/followup-flows/${flow.id}`, {
      data: { draft_graph: graph },
    });
    expect(patchRes.status()).toBe(200);

    const publishRes = await page.request.post(`/api/v1/ai/followup-flows/${flow.id}/publish`, { data: {} });
    expect(publishRes.status()).toBe(200);

    const createContactRes = await page.request.post("/api/v1/contacts", {
      data: { display_name: contactName },
    });
    expect(createContactRes.status()).toBe(201);
    const { data: contactResult } = (await createContactRes.json()) as ApiOk<{ contact: { id: string } }>;
    const contact = contactResult.contact;

    const createEnrollmentRes = await page.request.post("/api/v1/ai/followups/enrollments", {
      data: { pointer_id: flow.id, contact_id: contact.id },
    });
    expect(createEnrollmentRes.status()).toBe(201);
    const { data: enrollment } = (await createEnrollmentRes.json()) as ApiOk<{ id: string }>;

    // --- 1. a aba Fila lista o enrollment real ---
    await page.goto("/app/ai/followups");
    await expect(page.getByRole("heading", { name: "Follow-ups" })).toBeVisible();
    await page.getByRole("tab", { name: "Fila" }).click();

    const row = page.locator('[data-testid="queue-row"]', { hasText: contactName });
    await expect(row).toBeVisible();
    await expect(row).toContainText(flowName);
    await expect(row).toContainText("trigger-1");
    await expect(row.getByText("Ativo", { exact: true })).toBeVisible();
    // next-fire: relativo visível + absoluto (dd/mm/yyyy) como texto secundário.
    await expect(row.locator("td").nth(3)).toContainText(/\d{2}\/\d{2}\/\d{4}/);
    await page.screenshot({ path: "test-results/followup-7.1-01-queue-populated.png", fullPage: true });

    // --- 2. filtro por status e por fluxo estreitam a lista ---
    await page.getByLabel("Filtrar por status").click();
    await page.getByRole("option", { name: "Ativo", exact: true }).click();
    await expect(row).toBeVisible();

    await page.getByLabel("Filtrar por status").click();
    await page.getByRole("option", { name: "Concluído", exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.screenshot({ path: "test-results/followup-7.1-02-filtered-status-empty.png", fullPage: true });

    await page.getByLabel("Filtrar por status").click();
    await page.getByRole("option", { name: "Todos os status", exact: true }).click();
    await expect(row).toBeVisible();

    await page.getByLabel("Filtrar por fluxo").click();
    await page.getByRole("option", { name: flowName, exact: true }).click();
    await expect(row).toBeVisible();
    // filtro por ESTE fluxo recém-criado — só esta 1 linha pode bater (nenhum
    // outro teste usou este nome com timestamp único).
    await expect(page.locator('[data-testid="queue-row"]')).toHaveCount(1);
    await page.screenshot({ path: "test-results/followup-7.1-03-filtered-by-flow.png", fullPage: true });

    // --- 3. cancelar via AlertDialog ---
    await row.getByRole("button", { name: "Cancelar follow-up" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("O lead não receberá mais mensagens deste fluxo");
    await page.screenshot({ path: "test-results/followup-7.1-04-cancel-dialog.png", fullPage: true });

    await dialog.getByRole("button", { name: "Cancelar follow-up" }).click();
    await expect(page.getByText("Follow-up cancelado.")).toBeVisible();

    // sai do filtro "ativos" (aqui, o fluxo específico + status Ativo).
    await page.getByLabel("Filtrar por status").click();
    await page.getByRole("option", { name: "Ativo", exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.screenshot({ path: "test-results/followup-7.1-05-cancelled-left-active.png", fullPage: true });

    // Prova via API (não só UI): GET queue com status=cancelled mostra o
    // enrollment cancelado para este pointer.
    const cancelledQueueRes = await page.request.get(
      `/api/v1/ai/followups/queue?status=cancelled&pointer_id=${flow.id}`,
    );
    expect(cancelledQueueRes.status()).toBe(200);
    const { data: cancelledRows } = (await cancelledQueueRes.json()) as ApiOk<
      Array<{ id: string; status: string }>
    >;
    expect(cancelledRows.some((r) => r.id === enrollment.id && r.status === "cancelled")).toBe(true);

    // --- 4. a promessa seedada (cron_jobs) aparece como linha "Promessa" ---
    const promiseInfo = creds.followup_promise;
    if (!promiseInfo) throw new Error("followup_promise ausente em .e2e-creds.json — seed falhou");

    await page.getByLabel("Filtrar por status").click();
    await page.getByRole("option", { name: "Todos os status", exact: true }).click();
    await page.getByLabel("Filtrar por fluxo").click();
    await page.getByRole("option", { name: "Todos os fluxos", exact: true }).click();
    await page.getByLabel("Buscar contato").fill(promiseInfo.contact_name);

    // `q` de fato ESTREITA a busca no servidor (não é coincidência a linha
    // aparecer): o seed é upsert-like (1 contato, 1 cron_job por run), então
    // esta busca só pode bater em exatamente 1 linha na fila inteira da org.
    await expect(page.locator('[data-testid="queue-row"]')).toHaveCount(1);

    const promiseRow = page.locator('[data-testid="queue-row"]', { hasText: promiseInfo.contact_name });
    await expect(promiseRow).toBeVisible();
    await expect(promiseRow).toContainText("Promessa");
    await expect(promiseRow).toContainText(promiseInfo.reason);
    await expect(promiseRow.getByText("Agendada", { exact: true })).toBeVisible();
    await expect(promiseRow.locator("td").nth(3)).toContainText(/\d{2}\/\d{2}\/\d{4}/);
    // Promessa não tem botão Cancelar (fora de escopo desta task).
    await expect(promiseRow.getByRole("button", { name: "Cancelar follow-up" })).toHaveCount(0);
    await page.screenshot({ path: "test-results/followup-7.1-06-promise-row.png", fullPage: true });
  });

  test("viewer vê a fila (leitura) mas sem botão Cancelar (RBAC)", async ({ page }) => {
    await login(page, creds.users.viewer!.email);
    await page.goto("/app/ai/followups");
    await expect(page.getByRole("heading", { name: "Follow-ups" })).toBeVisible();
    await page.getByRole("tab", { name: "Fila" }).click();
    // any member consegue ver a fila (GET queue é viewer+) — só não há coluna de ação.
    await expect(page.getByRole("button", { name: "Cancelar follow-up" })).toHaveCount(0);
  });
});
