/**
 * Task 7.1 — fila unificada (enrollments + promessas) + cancelar + aba.
 *
 * Setup via API (não UI) como manager: publica um fluxo mínimo trigger→end,
 * cria um contato e um enrollment manual — aparece na fila imediatamente
 * (next_eval_at=now no trigger). A promessa (cron_jobs kind='at' +
 * job_kind='followup_turn') não tem rota pública de criação — só a tool do
 * agente de IA em runtime cria esse tipo de linha — então
 * scripts/seed-e2e-followup-promise.ts a semeia direto via service role
 * (mesmo padrão de scripts/seed-e2e-queue.ts), rodado 1x em beforeAll. Esse
 * seed é upsert-like (1 contato fixo, deleta+recria 1 cron_job) — não acumula.
 *
 * Cada run usa nome de fluxo/contato com timestamp único — não colide entre
 * execuções. Diferente do followup-builder.spec.ts (que aceita acumular
 * rascunhos), AMBOS os testes aqui fecham o que criam (cancela o enrollment +
 * desativa o fluxo) — a fila real cresce com uso genuíno de qualquer forma
 * (promessas reais de outras sessões de IA), então uma tabela mais enxuta por
 * run reduz o tempo de layout/paint que amplificava o flake do fix abaixo.
 *
 * Fix de review (2026-07-22): o 1º clique em "Cancelar" após trocar o filtro
 * de fluxo travou 30s num re-run do controller (elemento resolvido, nunca
 * "actionable" — indício de overlay/portal do Radix Select ainda vivo
 * cobrindo a tabela). `selectFilterOption()` abaixo força esperar o
 * `role=listbox` do popover realmente desmontar (Radix Presence/animação de
 * saída) antes de qualquer interação seguinte — serializa cada troca de
 * filtro em vez de confiar que o clique do item já fechou tudo a tempo.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
// test-results/ é limpo pelo outputDir do Playwright a cada run — preserva as
// screenshots de prova aqui (gitignored, mas sobrevive entre runs locais).
const ARTIFACTS_DIR = path.join(process.cwd(), "e2e-artifacts");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

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

/** Troca de sessão dentro do MESMO teste: limpa cookies antes de logar como outro user. */
async function switchUser(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await login(page, email);
}

/**
 * Abre um filtro (Select) da Fila e escolhe uma opção, esperando o popover
 * REALMENTE desmontar antes de devolver o controle. Root-cause fix do timeout
 * de 30s no clique de Cancelar reproduzido pelo controller — sem essa espera,
 * uma 2ª troca de filtro em sequência rápida (status→fluxo) podia deixar o
 * portal anterior ainda cobrindo a tabela por baixo do próximo clique.
 */
async function selectFilterOption(page: Page, triggerLabel: string, optionName: string): Promise<void> {
  await page.getByLabel(triggerLabel).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

interface ApiOk<T> {
  data: T;
}

interface LiveEnrollment {
  flowId: string;
  flowName: string;
  contactName: string;
  enrollmentId: string;
}

/** Publica um fluxo mínimo trigger→end e cria 1 enrollment manual vivo — via API, como manager. */
async function createLiveEnrollment(page: Page, tag: string): Promise<LiveEnrollment> {
  const stamp = Date.now();
  const flowName = `E2E Fila ${tag} ${stamp}`;
  const contactName = `Cliente Fila E2E ${tag} ${stamp}`;

  const createFlowRes = await page.request.post("/api/v1/ai/followup-flows", { data: { name: flowName } });
  expect(createFlowRes.status()).toBe(201);
  const { data: flow } = (await createFlowRes.json()) as ApiOk<{ id: string }>;

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

  const createContactRes = await page.request.post("/api/v1/contacts", { data: { display_name: contactName } });
  expect(createContactRes.status()).toBe(201);
  const { data: contactResult } = (await createContactRes.json()) as ApiOk<{ contact: { id: string } }>;

  const createEnrollmentRes = await page.request.post("/api/v1/ai/followups/enrollments", {
    data: { pointer_id: flow.id, contact_id: contactResult.contact.id },
  });
  expect(createEnrollmentRes.status()).toBe(201);
  const { data: enrollment } = (await createEnrollmentRes.json()) as ApiOk<{ id: string }>;

  return { flowId: flow.id, flowName, contactName, enrollmentId: enrollment.id };
}

/** Cancela o enrollment (se ainda vivo) e desativa o fluxo — best-effort, reduz acúmulo na fila real. */
async function cleanupLiveEnrollment(page: Page, live: LiveEnrollment): Promise<void> {
  await page.request.post(`/api/v1/ai/followups/enrollments/${live.enrollmentId}/cancel`, { data: {} });
  await page.request.post(`/api/v1/ai/followup-flows/${live.flowId}/disable`, { data: {} });
}

test.describe("followup queue — fila unificada (Task 7.1)", () => {
  test.beforeAll(() => {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-followup-promise.ts"], { stdio: "inherit" });
  });

  test("manager vê enrollment na fila, filtra por status/fluxo, cancela, e a promessa seedada aparece", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email);
    const live = await createLiveEnrollment(page, "mgr");

    // --- 1. a aba Fila lista o enrollment real ---
    await page.goto("/app/ai/followups");
    await expect(page.getByRole("heading", { name: "Follow-ups" })).toBeVisible();
    await page.getByRole("tab", { name: "Fila" }).click();

    const row = page.locator('[data-testid="queue-row"]', { hasText: live.contactName });
    await expect(row).toBeVisible();
    await expect(row).toContainText(live.flowName);
    await expect(row).toContainText("trigger-1");
    await expect(row.getByText("Ativo", { exact: true })).toBeVisible();
    // next-fire: relativo visível + absoluto (dd/mm/yyyy) como texto secundário.
    await expect(row.locator("td").nth(3)).toContainText(/\d{2}\/\d{2}\/\d{4}/);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "followup-7.1-01-queue-populated.png"), fullPage: true });

    // --- 2. filtro por status e por fluxo estreitam a lista ---
    await selectFilterOption(page, "Filtrar por status", "Ativo");
    await expect(row).toBeVisible();

    await selectFilterOption(page, "Filtrar por status", "Concluído");
    await expect(row).toHaveCount(0);
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "followup-7.1-02-filtered-status-empty.png"),
      fullPage: true,
    });

    await selectFilterOption(page, "Filtrar por status", "Todos os status");
    await expect(row).toBeVisible();

    await selectFilterOption(page, "Filtrar por fluxo", live.flowName);
    await expect(row).toBeVisible();
    // filtro por ESTE fluxo recém-criado — só esta 1 linha pode bater (nenhum
    // outro teste usou este nome com timestamp único).
    await expect(page.locator('[data-testid="queue-row"]')).toHaveCount(1);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "followup-7.1-03-filtered-by-flow.png"), fullPage: true });

    // --- 3. cancelar via AlertDialog ---
    // Re-resolve o botão NO MOMENTO do clique (não reusa um handle antigo) e
    // garante que a linha está fora de qualquer overlay antes de clicar —
    // mitigação do timeout de 30s reproduzido pelo controller.
    await row.scrollIntoViewIfNeeded();
    const cancelTrigger = row.getByRole("button", { name: "Cancelar follow-up" });
    await expect(cancelTrigger).toBeVisible();
    await cancelTrigger.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("O lead não receberá mais mensagens deste fluxo");
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "followup-7.1-04-cancel-dialog.png"), fullPage: true });

    await dialog.getByRole("button", { name: "Cancelar follow-up" }).click();
    await expect(page.getByText("Follow-up cancelado.")).toBeVisible();

    // sai do filtro "ativos" (aqui, o fluxo específico + status Ativo).
    await selectFilterOption(page, "Filtrar por status", "Ativo");
    await expect(row).toHaveCount(0);
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "followup-7.1-05-cancelled-left-active.png"),
      fullPage: true,
    });

    // Prova via API (não só UI): GET queue com status=cancelled mostra o
    // enrollment cancelado para este pointer.
    const cancelledQueueRes = await page.request.get(
      `/api/v1/ai/followups/queue?status=cancelled&pointer_id=${live.flowId}`,
    );
    expect(cancelledQueueRes.status()).toBe(200);
    const { data: cancelledRows } = (await cancelledQueueRes.json()) as ApiOk<
      Array<{ id: string; status: string }>
    >;
    expect(cancelledRows.some((r) => r.id === live.enrollmentId && r.status === "cancelled")).toBe(true);

    // --- 4. a promessa seedada (cron_jobs) aparece como linha "Promessa" ---
    const promiseInfo = creds.followup_promise;
    if (!promiseInfo) throw new Error("followup_promise ausente em .e2e-creds.json — seed falhou");

    await selectFilterOption(page, "Filtrar por status", "Todos os status");
    await selectFilterOption(page, "Filtrar por fluxo", "Todos os fluxos");
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
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "followup-7.1-06-promise-row.png"), fullPage: true });

    // Cleanup: cancela + desativa o que este teste criou (a promessa já é
    // idempotente/upsert-like no seed — não precisa de teardown aqui).
    await cleanupLiveEnrollment(page, live);
  });

  test("viewer vê a fila (leitura) mas não consegue cancelar — 403 client E server-side", async ({ page }) => {
    // Setup como manager: precisa de 1 enrollment VIVO real pra tentar cancelar como viewer.
    await login(page, creds.users.manager!.email);
    const live = await createLiveEnrollment(page, "viewer-rbac");

    await switchUser(page, creds.users.viewer!.email);

    // Prova SERVER-SIDE (não só botão escondido no client): POST direto no
    // endpoint de cancelar, sessão de viewer, contra um enrollment que
    // GENUINAMENTE existe e está vivo (não um id inventado — prova que o
    // 403 é RBAC, não um 404 mascarando o teste).
    const cancelRes = await page.request.post(`/api/v1/ai/followups/enrollments/${live.enrollmentId}/cancel`, {
      data: {},
    });
    expect(cancelRes.status()).toBe(403);
    const cancelBody = (await cancelRes.json()) as { error?: { code?: string } };
    expect(cancelBody.error?.code).toBe("forbidden_role");

    await page.goto("/app/ai/followups");
    await expect(page.getByRole("heading", { name: "Follow-ups" })).toBeVisible();
    await page.getByRole("tab", { name: "Fila" }).click();
    // any member consegue ver a fila (GET queue é viewer+) — só não há coluna de ação.
    await expect(page.getByRole("button", { name: "Cancelar follow-up" })).toHaveCount(0);

    // Cleanup como manager (viewer não pode, confirmado acima) — fecha o que este teste criou.
    await switchUser(page, creds.users.manager!.email);
    await cleanupLiveEnrollment(page, live);
  });
});
