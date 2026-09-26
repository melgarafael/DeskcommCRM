/**
 * O DOSSIÊ DO FOLLOW-UP, DIRIGIDO PELA TELA (W1-FILA).
 *
 * O que esta spec prova, na ordem em que um operador faria:
 *
 *   1. a fila leva ao dossiê pelo CLIQUE no nome do contato;
 *   2. a história do motor aparece TRADUZIDA — "Seguiu em frente", "Começou a
 *      esperar" —, e não `node_advanced` / `wait-1` na cara de quem lê;
 *   3. pausar, adiar, retomar e pular acontecem pelo clique, e cada um deles
 *      volta para a linha do tempo com autor humano;
 *   4. a intervenção aparece na TIMELINE DO NEGÓCIO, no kanban — é o que faz o
 *      próximo atendente saber que uma pessoa segurou o fluxo.
 *
 * ⚠️ OS EVENTOS DO MOTOR SÃO REAIS. O setup não escreve `followup_enrollment_events`
 * na mão: ele publica um fluxo de verdade, cria o enrollment pela API e chama o
 * cron `followup-flow-worker`, que é o MESMO caminho que roda em produção. Um
 * INSERT à mão provaria que a tela sabe desenhar uma linha inventada, não que
 * ela sabe ler o que o motor escreve.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const ARTIFACTS_DIR = path.join(process.cwd(), "evidence", "followup-dossie");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
}

/**
 * O seam do plano de tempo, e por que ele NÃO é um INSERT à mão.
 *
 * O plano nasce de uma chamada de modelo, e este ambiente não tem chave de IA
 * (o `.env.e2e` é placeholder). Em vez de escrever `timing_plan` no banco — o
 * que provaria só que a tela sabe desenhar um jsonb inventado —, a spec chama
 * `completeTurnForEnrollment` com o resultado CONTROLADO: exatamente a função
 * que o worker 24/7 chamaria depois do modelo responder. O clamp, a gravação e
 * o `proposto_ms` são os de produção.
 *
 * Mesmo seam já usado por `followup-journey.spec.ts`, pelo mesmo motivo.
 */
function concluiTurno(orgId: string, enrollmentId: string, nodeId: string, resultado: unknown): void {
  execFileSync(
    "npx",
    [
      "tsx",
      "scripts/e2e-followup-journey-helpers.ts",
      "complete-turn",
      orgId,
      enrollmentId,
      nodeId,
      JSON.stringify(resultado),
    ],
    { encoding: "utf8" },
  );
}

function loadCreds(): Creds {
  const precisaSeed = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (precisaSeed()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const INTERNAL_SECRET = (carregarEnvLocal().INTERNAL_SECRET ?? "").trim();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

interface ApiOk<T> {
  data: T;
}

interface Cenario {
  flowId: string;
  flowName: string;
  contactId: string;
  contactName: string;
  enrollmentId: string;
  leadId: string;
  /** O quadro onde o card do negócio vive — `/app/kanban` é a LISTA de funis. */
  pipelineId: string;
}

/**
 * Fluxo real publicado + contato + negócio + enrollment, tudo pela API pública.
 *
 * O grafo tem uma ESPERA no meio de propósito: é o nó em que o enrollment fica
 * parado com relógio no futuro, que é a condição de "adiar" e de "pular" — e é
 * onde o `timing_plan`, quando existir, apareceria.
 */
async function montaCenario(page: Page, tag: string): Promise<Cenario> {
  const stamp = Date.now();
  const flowName = `E2E Dossiê ${tag} ${stamp}`;
  const contactName = `Cliente Dossiê ${tag} ${stamp}`;

  const flowRes = await page.request.post("/api/v1/ai/followup-flows", { data: { name: flowName } });
  expect(flowRes.status()).toBe(201);
  const { data: flow } = (await flowRes.json()) as ApiOk<{ id: string }>;

  const graph = {
    nodes: [
      { id: "trigger-1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
      {
        id: "wait-1",
        type: "wait",
        label: "Deixa esfriar",
        position: { x: 0, y: 120 },
        config: { mode: "fixed", duration_ms: 14_400_000 },
      },
      { id: "end-1", type: "end", label: "Fim", position: { x: 0, y: 240 }, config: { outcome: "exhausted" } },
    ],
    edges: [
      { id: "edge-1", source: "trigger-1", target: "wait-1", priority: 0, condition: { type: "always" } },
      { id: "edge-2", source: "wait-1", target: "end-1", priority: 0, condition: { type: "always" } },
    ],
  };
  expect((await page.request.patch(`/api/v1/ai/followup-flows/${flow.id}`, { data: { draft_graph: graph } })).status()).toBe(200);
  expect((await page.request.post(`/api/v1/ai/followup-flows/${flow.id}/publish`, { data: {} })).status()).toBe(200);

  const contactRes = await page.request.post("/api/v1/contacts", { data: { display_name: contactName } });
  expect(contactRes.status()).toBe(201);
  const { data: contactResult } = (await contactRes.json()) as ApiOk<{ contact: { id: string } }>;
  const contactId = contactResult.contact.id;

  // O NEGÓCIO é o que dá âncora para a timeline: sem ele a intervenção não teria
  // onde aparecer, e a prova do passo 7 mediria a ausência de uma peça de setup.
  // Funil PADRÃO, e não o primeiro da lista: é o que o kanban abre, e o card
  // precisa estar onde a spec vai procurá-lo.
  const funilRes = await page.request.get("/api/v1/pipelines/default");
  expect(funilRes.status()).toBe(200);
  const { data: funil } = (await funilRes.json()) as ApiOk<{
    pipeline: { id: string };
    stages: Array<{ id: string }>;
  }>;
  const pipelineId = funil.pipeline.id;
  const stageId = funil.stages[0]?.id;
  if (!stageId) throw new Error("funil padrão sem etapas — não há onde criar o negócio");

  const leadRes = await page.request.post("/api/v1/leads", {
    data: { pipeline_id: pipelineId, stage_id: stageId, title: contactName, contact_id: contactId },
  });
  expect(leadRes.status()).toBe(201);
  const { data: lead } = (await leadRes.json()) as ApiOk<{ id: string }>;

  const enrollRes = await page.request.post("/api/v1/ai/followups/enrollments", {
    data: { pointer_id: flow.id, contact_id: contactId },
  });
  expect(enrollRes.status()).toBe(201);
  const { data: enrollment } = (await enrollRes.json()) as ApiOk<{ id: string }>;

  return { flowId: flow.id, flowName, contactId, contactName, enrollmentId: enrollment.id, leadId: lead.id, pipelineId };
}

/** O tick do motor pelo caminho de produção — o cron, com o segredo interno. */
async function rodaTickDoMotor(page: Page): Promise<void> {
  const res = await page.request.post("/api/v1/cron/followup-flow-worker", {
    headers: { authorization: `Bearer ${INTERNAL_SECRET}` },
  });
  expect(res.status(), "o cron do follow-up precisa aceitar o segredo interno").toBe(200);
}

async function limpa(page: Page, c: Cenario): Promise<void> {
  await page.request.post(`/api/v1/ai/followups/enrollments/${c.enrollmentId}/cancel`, { data: {} });
  await page.request.post(`/api/v1/ai/followup-flows/${c.flowId}/disable`, { data: {} });
}

test.describe("dossiê do follow-up — ler a história e intervir", () => {
  test.skip(INTERNAL_SECRET === "", "INTERNAL_SECRET ausente no .env.local — o tick do motor não roda");

  test("manager abre o dossiê pela fila, lê a história traduzida e intervém", async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, creds.users.manager!.email);
    const cenario = await montaCenario(page, "mgr");

    // Dois ticks: o primeiro sai do trigger para a espera, o segundo começa o
    // relógio da espera. São os eventos que a timeline vai ter de traduzir.
    await rodaTickDoMotor(page);
    await rodaTickDoMotor(page);

    // --- 1. da fila para o dossiê, pelo clique ---
    await page.goto("/app/ai/followups");
    await page.getByRole("tab", { name: "Fila" }).click();
    await page.getByLabel("Buscar contato").fill(cenario.contactName);
    // Espera a RESPOSTA da fila, não um relógio: o debounce é de 250ms e o
    // servidor sob carga leva mais que o timeout padrão de 5s do expect —
    // asserção que expira antes da resposta chegar mede a máquina, não a tela.
    await page.waitForResponse(
      (r) => r.url().includes("/api/v1/ai/followups/queue") && r.url().includes("q=") && r.status() === 200,
      { timeout: 60_000 },
    );
    const linha = page.locator('[data-testid="queue-row"]', { hasText: cenario.contactName });
    await expect(linha).toBeVisible({ timeout: 30_000 });
    await linha.getByTestId("queue-abrir-dossie").click();
    await page.waitForURL(new RegExp(`/app/ai/followups/enrollments/${cenario.enrollmentId}`));

    await expect(page.getByRole("heading", { name: cenario.contactName })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("dossie-status")).toHaveText("Ativo", { timeout: 30_000 });
    await expect(page.getByTestId("dossie-onde-esta")).toContainText("Deixa esfriar");

    // --- 2. a história do motor, em português ---
    const timeline = page.getByTestId("dossie-timeline");
    await expect(timeline).toContainText("Seguiu em frente");
    await expect(timeline).toContainText("Começou a esperar");
    // O que a tradução existe para impedir: identificador de máquina na tela.
    await expect(timeline).not.toContainText("node_advanced");
    await expect(timeline).not.toContainText("wait_started");
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "01-dossie-timeline.png"), fullPage: true });

    // --- 3. pausar ---
    await page.getByTestId("dossie-pausar").click();
    await expect(page.getByText("Follow-up pausado.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("dossie-status")).toHaveText("Pausado por uma pessoa");
    await expect(page.getByTestId("dossie-proximo-passo")).toContainText("Parado até alguém retomar");
    await expect(timeline).toContainText("Pausado por uma pessoa da equipe");
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "02-pausado.png"), fullPage: true });

    // Pausado NÃO oferece adiar nem pular: mexer no relógio de quem está fora
    // dele seria um botão que só sabe recusar.
    await expect(page.getByTestId("dossie-adiar")).toHaveCount(0);
    await expect(page.getByTestId("dossie-pular")).toHaveCount(0);

    // --- 4. retomar ---
    await page.getByTestId("dossie-retomar").click();
    await expect(page.getByText("Follow-up retomado.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("dossie-status")).toHaveText("Ativo", { timeout: 30_000 });
    await expect(timeline).toContainText("Retomado por uma pessoa da equipe");

    // --- 5. adiar para uma data escolhida ---
    await page.getByTestId("dossie-adiar").click();
    const daquiUmMes = new Date(Date.now() + 30 * 24 * 3_600_000);
    const p = (n: number) => String(n).padStart(2, "0");
    await page
      .getByTestId("dossie-adiar-quando")
      .fill(
        `${daquiUmMes.getFullYear()}-${p(daquiUmMes.getMonth() + 1)}-${p(daquiUmMes.getDate())}T${p(daquiUmMes.getHours())}:${p(daquiUmMes.getMinutes())}`,
      );
    await page.getByTestId("dossie-adiar-confirmar").click();
    await expect(page.getByText("Follow-up adiado.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("dossie-proximo-passo")).toContainText(
      `${p(daquiUmMes.getDate())}/${p(daquiUmMes.getMonth() + 1)}/${daquiUmMes.getFullYear()}`,
    );
    await expect(timeline).toContainText("Adiado por uma pessoa da equipe");
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "03-adiado.png"), fullPage: true });

    // --- 6. pular o passo (a espera tem saída única: segue sem perguntar) ---
    await page.getByTestId("dossie-pular").click();
    await expect(page.getByText("Passo pulado.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("dossie-onde-esta")).toContainText("Fim");
    await expect(timeline).toContainText("Passo pulado por uma pessoa da equipe");
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "04-pulado.png"), fullPage: true });

    // --- 7. a intervenção existe FORA do follow-up: no negócio ---
    // É o que o próximo atendente vê no card, e o que impede o agente de
    // reagendar o que uma pessoa acabou de segurar.
    await page.goto(`/app/pipelines/${cenario.pipelineId}`);
    const card = page.getByRole("group", { name: `Lead: ${cenario.contactName}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: cenario.contactName }).click();
    // O dossiê do negócio é um Sheet — `role=dialog` no Radix.
    const dossieDoNegocio = page.getByRole("dialog");
    await expect(dossieDoNegocio).toContainText("Follow-up pausado");
    await expect(dossieDoNegocio).toContainText("Follow-up retomado");
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "05-timeline-do-negocio.png"), fullPage: true });

    await limpa(page, cenario);
  });

  test("viewer lê o dossiê inteiro e não tem botão de intervir — nem no servidor", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, creds.users.manager!.email);
    const cenario = await montaCenario(page, "viewer");
    await rodaTickDoMotor(page);

    await page.context().clearCookies();
    await login(page, creds.users.viewer!.email);

    // Prova SERVER-SIDE contra um enrollment que existe de verdade — 403 de
    // RBAC, não 404 mascarando o teste.
    for (const acao of ["pause", "resume", "snooze", "skip"]) {
      const res = await page.request.post(`/api/v1/ai/followups/enrollments/${cenario.enrollmentId}/${acao}`, {
        data: acao === "snooze" ? { next_eval_at: new Date(Date.now() + 3_600_000).toISOString() } : {},
      });
      expect(res.status(), `${acao} devia recusar viewer`).toBe(403);
      expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("forbidden_role");
    }

    await page.goto(`/app/ai/followups/enrollments/${cenario.enrollmentId}`);
    await expect(page.getByRole("heading", { name: cenario.contactName })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("dossie-timeline")).toBeVisible();
    await expect(page.getByTestId("dossie-acoes")).toHaveCount(0);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "06-viewer-so-leitura.png"), fullPage: true });

    await page.context().clearCookies();
    await login(page, creds.users.manager!.email);
    await limpa(page, cenario);
  });

  test("o dossiê mostra o tempo que a IA escolheu — e quanto ela pediu antes do corte", async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, creds.users.manager!.email);

    // Fluxo com espera ADAPTATIVA: é o único que tem plano a mostrar.
    const stamp = Date.now();
    const flowName = `E2E Dossiê plano ${stamp}`;
    const contactName = `Cliente Dossiê plano ${stamp}`;
    const { data: flow } = (await (
      await page.request.post("/api/v1/ai/followup-flows", { data: { name: flowName } })
    ).json()) as ApiOk<{ id: string }>;

    const graph = {
      nodes: [
        { id: "trigger-1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        {
          id: "wait-1",
          type: "wait",
          label: "Deixa esfriar",
          position: { x: 0, y: 120 },
          // 10 min a 12h: o teto que a IA vai estourar de propósito.
          config: { mode: "smart", min_ms: 600_000, max_ms: 43_200_000, guidance: "o cliente pediu calma" },
        },
        { id: "end-1", type: "end", label: "Fim", position: { x: 0, y: 240 }, config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "edge-1", source: "trigger-1", target: "wait-1", priority: 0, condition: { type: "always" } },
        { id: "edge-2", source: "wait-1", target: "end-1", priority: 0, condition: { type: "always" } },
      ],
    };
    expect((await page.request.patch(`/api/v1/ai/followup-flows/${flow.id}`, { data: { draft_graph: graph } })).status()).toBe(200);
    expect((await page.request.post(`/api/v1/ai/followup-flows/${flow.id}/publish`, { data: {} })).status()).toBe(200);

    const { data: contactResult } = (await (
      await page.request.post("/api/v1/contacts", { data: { display_name: contactName } })
    ).json()) as ApiOk<{ contact: { id: string } }>;
    const { data: enrollment } = (await (
      await page.request.post("/api/v1/ai/followups/enrollments", {
        data: { pointer_id: flow.id, contact_id: contactResult.contact.id },
      })
    ).json()) as ApiOk<{ id: string }>;

    // Tick 1: o acionamento pede o plano (o enrollment fica no trigger).
    await rodaTickDoMotor(page);
    // O modelo "responde" pedindo 3 DIAS — muito acima do teto de 12h do nó.
    concluiTurno(creds.org_id, enrollment.id, "trigger-1", {
      kind: "planned",
      modelo: "anthropic/claude-sonnet-4-6",
      propostas: [
        { node_id: "wait-1", aguardar_ms: 259_200_000, motivo: "o cliente pediu para retomar semana que vem" },
      ],
    });

    await page.goto(`/app/ai/followups/enrollments/${enrollment.id}`);
    const bloco = page.getByTestId("dossie-plano-de-tempo");
    await expect(bloco).toBeVisible({ timeout: 30_000 });
    // O que o nó permitiu, não o que a IA pediu.
    await expect(bloco).toContainText("esperar 12 horas");
    await expect(bloco.getByTestId("dossie-espera-clampada")).toBeVisible();
    // E o TAMANHO do corte, que é o que decide se o operador mexe no nó.
    await expect(bloco.getByTestId("dossie-espera-pedido")).toContainText("a IA pediu 3 dias");
    await expect(bloco).toContainText("o cliente pediu para retomar semana que vem");
    await expect(bloco).toContainText("seu limite: de 10 minutos a 12 horas");

    // A tela pegou dois defeitos de tradução que nenhum unitário pegaria: o
    // evento do plano caía no fallback ("código: timing_plan_decidido") e o
    // turno de PLANEJAMENTO se anunciava como "escrever a mensagem". Os dois
    // ficam vigiados aqui, onde apareceram.
    const historia = page.getByTestId("dossie-timeline");
    await expect(historia).toContainText("O agente decidiu quanto esperar em cada passo");
    await expect(historia).toContainText("Pediu ao agente para planejar os tempos de espera");
    await expect(historia).not.toContainText("timing_plan_decidido");
    await expect(historia).not.toContainText("escrever a mensagem");
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "07-plano-de-tempo.png"), fullPage: true });

    await page.request.post(`/api/v1/ai/followups/enrollments/${enrollment.id}/cancel`, { data: {} });
    await page.request.post(`/api/v1/ai/followup-flows/${flow.id}/disable`, { data: {} });
  });
});
