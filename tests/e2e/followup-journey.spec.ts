/**
 * Task 8.3 — JORNADA E2E completa: a prova única que amarra o sistema de
 * follow-up inteiro. Silêncio → enroll (gate do agente) → engine avança
 * nó a nó (trigger→wait→action→ai_classify) → resposta do lead → classify
 * roteia → fim → fila mostra o resultado.
 *
 * ============================================================================
 * O SEAM DE LLM (leia antes de mexer neste arquivo) — model ids do gateway de
 * dev são fictícios (HANDOFF/memória: chamada real de LLM não funciona em
 * dev). Esta spec NUNCA roda um agente de IA real. Em vez disso, ela chama
 * `completeTurnForEnrollment` (lib/followup/turn-bridge.ts) — a MESMA função
 * que o worker 24/7 chamaria depois de uma chamada real de modelo — com um
 * resultado CONTROLADO (`{kind:'sent'}` no nó action, `{kind:'classified',
 * class:'positivo'}` no ai_classify). Cada passo abaixo está marcado
 * [REAL] ou [INJETADO] explicitamente. TUDO o resto é real: build/publish/
 * link do fluxo na UI, engine avançando nó a nó via tick real do cron,
 * roteamento de aresta, fila.
 * ============================================================================
 *
 * Helpers de SQL cru (scripts/e2e-followup-journey-helpers.ts, service role /
 * pg direto) cobrem o que a API pública genuinamente não expõe: fast-forward
 * de `next_eval_at` (não dá pra dormir 5min/15min reais por chamada de
 * tick), simular uma resposta inbound sem WAHA real, e o seam de
 * completeTurnForEnrollment acima.
 *
 * Cada passo do engine é 1 nó por chamada de tick (confirmado lendo
 * engine.ts/HANDOFF Task 4.2) — `pollEnrollment`/`pollSweep` abaixo fazem
 * POST repetido no cron até o estado esperado aparecer (defende contra
 * outros enrollments due no MESMO banco de dev compartilhado disputando o
 * `limit` do claim; nunca contra a ausência de progresso real).
 *
 * Limpa o que cria (desativa o fluxo, arquiva o agent, apaga contato/
 * conversa/mensagens via helper) — nomes com timestamp único, não acumula
 * nem colide entre runs.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const ARTIFACTS_DIR = path.join(process.cwd(), "e2e-artifacts");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { email: string }>;
  admin_totp?: { factor_id: string; secret: string };
  followup_agent_fixtures?: { credential_id: string; channel_session_id: string };
}

function loadCreds(): Creds {
  const needsSeed = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.admin || !c.admin_totp;
  };
  if (needsSeed()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function loadInternalSecret(): string {
  const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  const match = envFile.match(/^INTERNAL_SECRET=(.*)$/m);
  const secret = match?.[1]?.trim();
  if (!secret) throw new Error("INTERNAL_SECRET não encontrado em .env.local");
  return secret;
}

const creds = loadCreds();
const secret = loadInternalSecret();

/** Roda 1 subcomando do helper de SQL cru e devolve o JSON impresso na última linha. */
function runHelper(args: string[]): unknown {
  const stdout = execFileSync("npx", ["tsx", "scripts/e2e-followup-journey-helpers.ts", ...args], {
    encoding: "utf8",
  });
  const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
  if (!lastLine) throw new Error(`e2e-followup-journey-helpers ${args[0]} não imprimiu JSON`);
  return JSON.parse(lastLine);
}

async function loginWithTotp(page: Page, email: string, secretTotp: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/login\/mfa/);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (msUntilNextTotpWindow() < 3_000) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
    const code = generateTotp(secretTotp);
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

// ---------------------------------------------------------------------------
// Helpers de canvas — mesmo padrão de tests/e2e/followup-builder.spec.ts
// (duplicados aqui de propósito: cada spec deste repo é self-contido).
// ---------------------------------------------------------------------------

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

async function nodeIdsByPrefix(page: Page, prefix: string): Promise<string[]> {
  const els = await page.locator(`.react-flow__node[data-id^="${prefix}-"]`).all();
  const ids: string[] = [];
  for (const el of els) {
    const id = await el.getAttribute("data-id");
    if (id) ids.push(id);
  }
  return ids;
}

async function moveNodeTo(page: Page, nodeId: string, targetX: number, targetY: number): Promise<void> {
  const card = page.locator(`[data-testid="node-card-${nodeId}"]`);
  const box = await card.boundingBox();
  if (!box) throw new Error(`nó ${nodeId} sem bounding box`);
  const startX = box.x + box.width / 2;
  const startY = box.y + 20;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move((startX + targetX) / 2, (startY + targetY) / 2, { steps: 5 });
  await page.mouse.move(targetX, targetY, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

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

// ---------------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------------

interface EnrollmentRow {
  id: string;
  organization_id: string;
  pointer_id: string;
  contact_id: string;
  current_node_id: string;
  status: string;
  outcome: string | null;
  steps_taken: number;
  next_eval_at: string | null;
  completed_at: string | null;
}

test.describe("followup — jornada completa (Task 8.3)", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test.beforeAll(() => {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-followup-agent.ts"], { stdio: "inherit" });
  });

  test("silêncio → enroll → trigger→wait→action→classify → resposta → outcome → fila", async ({ page }) => {
    // Jornada ponta a ponta com múltiplos round-trips reais de cron (tick +
    // sweep + drain) — o timeout default de 30s do playwright.config.ts é
    // curto demais (mesmo padrão de tests/e2e/webhooks.spec.ts, que também
    // dreno event_log real e usa 180s).
    test.setTimeout(300_000);
    expect(creds.admin_totp?.secret, "seed deve gravar admin_totp em .e2e-creds.json").toBeTruthy();
    expect(creds.followup_agent_fixtures, "seed-e2e-followup-agent.ts deve gravar followup_agent_fixtures").toBeTruthy();
    await loginWithTotp(page, creds.users.admin!.email, creds.admin_totp!.secret);

    const stamp = Date.now();

    // =========================================================================
    // 1. [REAL UI] Monta o fluxo no builder: trigger → wait(5min, floor do
    //    schema) → action(ai_message) → ai_classify(1 classe "positivo") →
    //    3 fins (positivo/no_reply/always-fallback — o validador de publish
    //    exige as 3 arestas de saída do classify: class_match(positivo),
    //    class_match(no_reply), always).
    // =========================================================================
    const flowName = `E2E Jornada ${stamp}`;
    await page.goto("/app/ai/followups");
    await page.getByRole("button", { name: "Novo fluxo" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nome").fill(flowName);
    await dialog.getByRole("button", { name: "Criar fluxo" }).click();
    await expect(dialog).not.toBeVisible();
    await page.locator("li", { hasText: flowName }).getByRole("link").click();
    await page.waitForURL(/\/app\/ai\/followups\/([0-9a-f-]+)$/);
    const flowId = page.url().match(/\/app\/ai\/followups\/([0-9a-f-]+)$/)![1]!;
    await expect(page.locator(".react-flow")).toBeVisible();

    await page.getByTestId("palette-add-trigger").click();
    await page.getByTestId("palette-add-wait").click();
    await page.getByTestId("palette-add-action").click();
    await page.getByTestId("palette-add-ai_classify").click();
    await page.getByTestId("palette-add-end").click();
    await page.getByTestId("palette-add-end").click();
    await page.getByTestId("palette-add-end").click();

    const triggerId = await page.locator('.react-flow__node[data-id^="trigger-"]').getAttribute("data-id");
    const waitId = await page.locator('.react-flow__node[data-id^="wait-"]').getAttribute("data-id");
    const actionId = await page.locator('.react-flow__node[data-id^="action-"]').getAttribute("data-id");
    const classifyId = await page.locator('.react-flow__node[data-id^="ai_classify-"]').getAttribute("data-id");
    const [endPositivoId, endNoReplyId, endFallbackId] = await nodeIdsByPrefix(page, "end");
    if (!triggerId || !waitId || !actionId || !classifyId || !endPositivoId || !endNoReplyId || !endFallbackId) {
      throw new Error("node ids ausentes após montar a paleta");
    }

    const zoomOut = page.locator(".react-flow__controls-zoomout");
    for (let i = 0; i < 6; i++) await zoomOut.click();
    await page.waitForTimeout(300);

    const canvasBox = await page.getByTestId("flow-canvas").boundingBox();
    if (!canvasBox) throw new Error("flow-canvas sem bounding box");
    const at = (dx: number, dy: number): [number, number] => [canvasBox.x + dx, canvasBox.y + dy];
    await moveNodeTo(page, triggerId, ...at(150, 50));
    await moveNodeTo(page, waitId, ...at(150, 190));
    await moveNodeTo(page, actionId, ...at(150, 330));
    await moveNodeTo(page, classifyId, ...at(150, 470));
    await moveNodeTo(page, endPositivoId, ...at(60, 650));
    await moveNodeTo(page, endNoReplyId, ...at(260, 650));
    await moveNodeTo(page, endFallbackId, ...at(460, 650));

    // Configura: classify → 1 classe "positivo" (troca o default hot/cold);
    // action → prompt_hint real; end-positivo → outcome "Convertido" (os
    // outros 2 fins ficam no default "Esgotado", coerente com no_reply/fallback).
    await page.locator(`[data-testid="node-card-${classifyId}"]`).click();
    const panel = page.getByTestId("node-config-panel");
    await panel.getByLabel("Classes (separadas por vírgula)").fill("positivo");
    await panel.getByLabel("Classes (separadas por vírgula)").blur();
    await expect(page.locator(`[data-testid="node-card-${classifyId}"]`)).toContainText("1 classes");

    await page.locator(`[data-testid="node-card-${actionId}"]`).click();
    const promptHint = "Pergunte com simpatia se ainda há interesse e ofereça ajuda para fechar.";
    await panel.getByLabel("Instrução para a IA").fill(promptHint);
    await panel.getByLabel("Instrução para a IA").blur();
    await expect(page.locator(`[data-testid="node-card-${actionId}"]`)).toContainText("Pergunte com simpatia");

    await page.locator(`[data-testid="node-card-${endPositivoId}"]`).click();
    await panel.locator("#end-outcome").click();
    await page.getByRole("option", { name: "Convertido", exact: true }).click();
    await expect(page.locator(`[data-testid="node-card-${endPositivoId}"]`)).toContainText("Convertido");

    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("node-config-sheet")).toHaveCount(0);

    // Conecta — ordem fixa os ids das arestas (edge-1..edge-6, contador monotônico).
    await connectHandles(page, triggerId, waitId); // edge-1
    await connectHandles(page, waitId, actionId); // edge-2
    await connectHandles(page, actionId, classifyId); // edge-3
    await connectHandles(page, classifyId, endPositivoId); // edge-4 → class_match positivo
    await connectHandles(page, classifyId, endNoReplyId); // edge-5 → class_match no_reply
    await connectHandles(page, classifyId, endFallbackId); // edge-6 → always (fica no default)
    await expect(page.locator(".react-flow__edge")).toHaveCount(6);

    await setEdgeCondition(page, "edge-4", "positivo");
    await setEdgeCondition(page, "edge-5", "Sem resposta");
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("edge-config-sheet")).toHaveCount(0);

    // trigger_config (kind='silence') não tem controle na UI do canvas ainda
    // (confirmado lendo NodeConfigPanel.tsx — o branch 'trigger' só mostra um
    // texto explicativo, "definido nas configurações do fluxo", sem form).
    // [REAL API — não bypass: é o MESMO PATCH que qualquer outro campo do
    // pointer usa (ex.: handoff_policy no PublishBar), só sem widget ainda.]
    const trigCfgRes = await page.request.patch(`/api/v1/ai/followup-flows/${flowId}`, {
      data: { trigger_config: { kind: "silence", params: { threshold_minutes: 5 } } },
    });
    expect(trigCfgRes.status()).toBe(200);

    await page.getByTestId("publish-button").click();
    await expect(page.getByText("Fluxo publicado.")).toBeVisible();
    await expect(page.locator('[aria-label="status: Ativo"]')).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "followup-8.3-01-flow-published.png"), fullPage: true });

    // =========================================================================
    // 2. [REAL UI + API] Vincula o fluxo a um agente publicado — só um agente
    //    PUBLICADO com followup.enabled=true habilita o gatilho automático
    //    (isPointerEnabledForAutomaticTrigger, Task 7.2/8.1).
    // =========================================================================
    runHelper(["prepare-agent-fixtures"]); // credential.validated_at + channel_session=WORKING
    const fixtures = creds.followup_agent_fixtures!;
    const agentName = `E2E Agente Jornada ${stamp}`;
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
      data: { agent: { id: string }; version: { id: string } };
    };
    const agentId = created.agent.id;
    const versionId = created.version.id;

    await page.goto(`/app/ai/agents/${agentId}`);
    await expect(page.getByRole("heading", { name: agentName })).toBeVisible();
    const followupHeading = page.getByRole("heading", { name: "Follow-up", exact: true });
    await followupHeading.scrollIntoViewIfNeeded();
    const followupToggle = page.getByLabel("Habilitar gatilhos automáticos de follow-up");
    await followupToggle.click();
    await expect(followupToggle).toBeChecked();
    const flowCheckbox = page.getByLabel(flowName, { exact: true });
    await flowCheckbox.check();
    await expect(flowCheckbox).toBeChecked();
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "followup-8.3-02-agent-followup-section.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    await expect(page.getByText(/Rascunho v\d+ salvo\./)).toBeVisible();

    // Publica a version — sem isso o gate (Task 7.2) nunca libera o gatilho
    // automático (só conta agente com version status='published').
    const publishAgentRes = await page.request.post(`/api/v1/ai/agents/${agentId}/publish`, {
      data: { version_id: versionId },
    });
    expect(publishAgentRes.status()).toBe(200);

    // Prova via API (não só UI): a version publicada carrega o pointer.
    const versionRes = await page.request.get(`/api/v1/ai/agents/${agentId}/versions/${versionId}`);
    expect(versionRes.status()).toBe(200);
    const { data: persisted } = (await versionRes.json()) as {
      data: { status: string; followup: { enabled: boolean; flow_pointer_ids: string[] } };
    };
    expect(persisted.status).toBe("published");
    expect(persisted.followup.enabled).toBe(true);
    expect(persisted.followup.flow_pointer_ids).toContain(flowId);

    // =========================================================================
    // 3. [REAL — service role] Semeia um contato silencioso: última conversa
    //    com last_inbound_at bem mais velho que o threshold_minutes=5 do
    //    trigger.
    // =========================================================================
    const seed = runHelper(["seed-silent-contact", "5", "jornada"]) as {
      contactId: string;
      contactName: string;
      conversationId: string;
      channelSessionId: string;
    };

    // =========================================================================
    // 4. [REAL] POST no cron real (runFollowupTick + runSilenceSweep) até a
    //    varredura enrollar o contato — prova que o GATE deixou passar
    //    (agente publicado+enabled) e que o gatilho automático de silêncio
    //    funciona ponta a ponta.
    // =========================================================================
    async function tickCron(): Promise<void> {
      const res = await page.request.post("/api/v1/cron/followup-flow-worker", {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(res.ok()).toBeTruthy();
    }

    async function pollEnrollment(
      enrollmentId: string,
      predicate: (e: EnrollmentRow) => boolean,
      label: string,
      maxTicks = 15,
    ): Promise<EnrollmentRow> {
      let e = runHelper(["get-enrollment", enrollmentId]) as EnrollmentRow;
      for (let i = 0; i < maxTicks && !predicate(e); i++) {
        await tickCron();
        e = runHelper(["get-enrollment", enrollmentId]) as EnrollmentRow;
      }
      if (!predicate(e)) {
        throw new Error(`pollEnrollment timeout esperando "${label}"; estado atual: ${JSON.stringify(e)}`);
      }
      return e;
    }

    let enrollment: EnrollmentRow | null = null;
    for (let i = 0; i < 10 && !enrollment; i++) {
      await tickCron();
      enrollment = runHelper(["find-enrollment", creds.org_id, flowId, seed.contactId]) as EnrollmentRow | null;
    }
    if (!enrollment) throw new Error("varredura de silêncio não enrollou o contato a tempo");
    expect(enrollment.pointer_id).toBe(flowId);
    expect(enrollment.contact_id).toBe(seed.contactId);
    expect(enrollment.current_node_id).toBe(triggerId);
    expect(enrollment.status).toBe("active");
    const enrollmentId = enrollment.id;

    // Desativa o pointer JÁ AQUI (não só no cleanup final): o gatilho de
    // silêncio é cross-CONTATO de propósito (varre a org inteira, não só
    // quem esta run semeou) — cada tick subsequente do cron nos passos 5-7
    // abaixo rodaria a varredura de novo enquanto o pointer segue 'active',
    // arriscando enrollar QUALQUER outro contato silencioso real do banco de
    // dev compartilhado. Desativar não afeta o enrollment já criado: o
    // engine avança enrollments existentes só por status/next_eval_at, nunca
    // filtra por status do pointer (confirmado lendo fn_claim_due_followup_
    // enrollments/engine.ts).
    await page.request.post(`/api/v1/ai/followup-flows/${flowId}/disable`, { data: {} });

    try {
      // Fila reflete o enrollment recém-criado — [REAL UI]. Escopa por
      // contato E fluxo (não só contato) — o gatilho de silêncio é
      // cross-contato, então mais de um pointer de teste pode ter enrollado
      // o mesmo contato em runs anteriores (ver nota de cleanup abaixo).
      await page.goto("/app/ai/followups");
      await page.getByRole("tab", { name: "Fila" }).click();
      await page.getByLabel("Buscar contato").fill(seed.contactName);
      const queueRow = page
        .locator('[data-testid="queue-row"]', { hasText: seed.contactName })
        .filter({ hasText: flowName });
      await expect(queueRow).toBeVisible();
      await expect(queueRow).toContainText(flowName);
      await expect(queueRow.getByText("Ativo", { exact: true })).toBeVisible();
      await page.screenshot({
        path: path.join(ARTIFACTS_DIR, "followup-8.3-03-queue-active.png"),
        fullPage: true,
      });

    // =========================================================================
    // 5. [REAL engine] trigger → wait → (fast-forward) → action → o engine
    //    ENFILEIRA um followup_turn de verdade (job_queue). Depois [INJETADO]
    //    completeTurnForEnrollment({kind:'sent'}) no lugar do worker real de
    //    IA — assinatura idêntica à que o worker 24/7 chamaria.
    // =========================================================================
    await pollEnrollment(enrollmentId, (e) => e.current_node_id === waitId, "trigger→wait");
    await pollEnrollment(
      enrollmentId,
      (e) => e.current_node_id === waitId && e.steps_taken === 2,
      "wait iniciado (next_eval_at em ~5min)",
    );

    runHelper(["fast-forward-enrollment", enrollmentId]); // pula os 5min reais do wait

    await pollEnrollment(enrollmentId, (e) => e.current_node_id === actionId, "wait elapsed → action");
    const atAction = await pollEnrollment(
      enrollmentId,
      (e) => e.current_node_id === actionId && e.steps_taken === 4,
      "action enfileirou o turno (job_queue real)",
    );
    expect(atAction.status).toBe("active");

    const sendJob = runHelper(["find-job", seed.contactId, "send_message"]) as {
      payload: { node_id: string; prompt_hint: string };
    } | null;
    expect(sendJob, "engine deveria ter enfileirado um job_queue real pro nó action").toBeTruthy();
    expect(sendJob!.payload.node_id).toBe(actionId);
    expect(sendJob!.payload.prompt_hint).toBe(promptHint);

    // [INJETADO] — aqui é onde um LLM real geraria a mensagem e o worker
    // chamaria completeTurnForEnrollment('sent') depois de enviar via WAHA.
    runHelper(["complete-turn", creds.org_id, enrollmentId, actionId, JSON.stringify({ kind: "sent" })]);

    const afterSent = runHelper(["get-enrollment", enrollmentId]) as EnrollmentRow;
    expect(afterSent.current_node_id).toBe(classifyId);
    expect(afterSent.status).toBe("active");
    const eventsAfterSent = runHelper(["list-events", enrollmentId]) as string[];
    expect(eventsAfterSent).toContain("action_sent");

    // =========================================================================
    // 6. [REAL] engine entra no ai_classify e ENFILEIRA o turno de
    //    classificação de verdade (job_queue, waiting_reply). [REAL] simula a
    //    resposta do lead (insert de message + emit_event message.received —
    //    a MESMA função que o webhook real da WAHA chama) e drena o
    //    event_log real — lib/followup/reactivity.ts acorda o enrollment.
    //    [INJETADO] completeTurnForEnrollment('classified', 'positivo') no
    //    lugar do classificador de IA real.
    // =========================================================================
    const atClassify = await pollEnrollment(
      enrollmentId,
      (e) => e.status === "waiting_reply" && e.current_node_id === classifyId,
      "ai_classify enfileirou o turno de classificação (job_queue real)",
    );
    expect(atClassify.steps_taken).toBe(6);

    const classifyJob = runHelper(["find-job", seed.contactId, "classify"]) as {
      payload: { node_id: string; classes: string[] };
    } | null;
    expect(classifyJob, "engine deveria ter enfileirado um job_queue real pro nó ai_classify").toBeTruthy();
    expect(classifyJob!.payload.node_id).toBe(classifyId);
    expect(classifyJob!.payload.classes).toEqual(["positivo"]);

    runHelper([
      "simulate-inbound",
      creds.org_id,
      seed.conversationId,
      seed.contactId,
      seed.channelSessionId,
      "Sim, ainda tenho interesse! Pode me mandar mais detalhes?",
    ]);

    // Drena o event_log real (mesmo cron que produção usa) até a reatividade
    // acordar o enrollment (marker `inbound_woke`, next_eval_at=now).
    let woke = false;
    for (let i = 0; i < 5 && !woke; i++) {
      const drainRes = await page.request.post("/api/v1/cron/event-log-drain", {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(drainRes.ok()).toBeTruthy();
      const events = runHelper(["list-events", enrollmentId]) as string[];
      woke = events.includes("inbound_woke");
    }
    expect(woke, "reactivity deveria ter gravado o evento inbound_woke").toBe(true);

    // [INJETADO]
    runHelper([
      "complete-turn",
      creds.org_id,
      enrollmentId,
      classifyId,
      JSON.stringify({ kind: "classified", class: "positivo" }),
    ]);

    const afterClassified = runHelper(["get-enrollment", enrollmentId]) as EnrollmentRow;
    expect(afterClassified.current_node_id).toBe(endPositivoId);
    expect(afterClassified.status).toBe("active");
    const eventsAfterClassified = runHelper(["list-events", enrollmentId]) as string[];
    expect(eventsAfterClassified).toContain("ai_classified");

    // =========================================================================
    // 7. [REAL] o engine processa o nó de fim (outcome='converted'). Fila
    //    (UI real) reflete o resultado final.
    // =========================================================================
    const completed = await pollEnrollment(
      enrollmentId,
      (e) => e.status === "completed",
      "end node → outcome converted",
    );
    expect(completed.current_node_id).toBe(endPositivoId);
    expect(completed.outcome).toBe("converted");
    expect(completed.completed_at).toBeTruthy();

      await page.reload();
      await page.getByRole("tab", { name: "Fila" }).click();
      await page.getByLabel("Buscar contato").fill(seed.contactName);
      const finalRow = page
        .locator('[data-testid="queue-row"]', { hasText: seed.contactName })
        .filter({ hasText: flowName });
      await expect(finalRow).toBeVisible();
      await expect(finalRow.getByText("Concluído", { exact: true })).toBeVisible();
      await page.screenshot({
        path: path.join(ARTIFACTS_DIR, "followup-8.3-04-queue-completed.png"),
        fullPage: true,
      });
    } finally {
      // --- Cleanup: reduz acúmulo no dev DB compartilhado. O gatilho de
      // silêncio é cross-contato (ver nota acima) — cleanup-flow-enrollments
      // apaga TODO enrollment que este pointer criou (não só o do contato
      // desta run), não apenas o que a asserção rastreou. Roda em `finally`
      // pra nunca deixar o pointer 'active'/contato órfão se uma asserção
      // no meio do caminho falhar.
      await page.request.post(`/api/v1/ai/followup-flows/${flowId}/disable`, { data: {} }).catch(() => undefined);
      await page.request.delete(`/api/v1/ai/agents/${agentId}`).catch(() => undefined);
      runHelper(["cleanup-flow-enrollments", flowId]);
      runHelper(["cleanup-contact", seed.contactId]);
    }
  });
});
