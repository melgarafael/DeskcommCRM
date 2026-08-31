/**
 * Agenda nativa — fluxo completo, dirigido pela tela.
 *
 * Prova, na ordem em que um manager faria: cadastrar um tipo de agendamento
 * (Task 14), definir o próprio horário de atendimento (Task 15), abrir um
 * lead no kanban e marcar um horário pelo diálogo (Tasks 16-17), e ver o
 * agendamento aparecer na Agenda (Task 17).
 *
 * O lead nasce pela API — mesmo seam de `followup-dossie.spec.ts`: a UI do
 * kanban só precisa achar o card, não criá-lo, e um INSERT à mão provaria
 * menos do que a rota pública que qualquer cliente usa.
 *
 * ⚠️ NÃO RODADO nesta sessão — sem Docker/Supabase local/dev server
 * disponíveis aqui. Ver doutrina de QA Visual do CLAUDE.md: precisa rodar
 * `pnpm test:e2e -- agenda-nativa.spec.ts` com o ambiente completo antes do
 * merge.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { id: string; email: string }>;
}

function loadCreds(): Creds {
  const needsBase = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (needsBase()) {
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

test.describe("Agenda nativa — fluxo completo", () => {
  test("cadastra tipo, horário do atendente, marca agendamento e conclui", async ({ page }) => {
    test.setTimeout(90_000);

    // manager: /app/settings/appointment-types exige manager+, e o seed do
    // manager não tem MFA (mesmo motivo de kanban-owner-filter.spec.ts).
    const manager = creds.users.manager!;
    await login(page, manager.email);

    const stamp = Date.now();
    const tipoNome = `Consulta E2E ${stamp}`;

    // --- 1. tipo de agendamento (Task 14) ---
    await page.goto("/app/settings/appointment-types");
    await page.getByLabel("Nome").fill(tipoNome);
    await page.getByLabel("Duração (min)").fill("30");
    // O próprio manager é o responsável — é cujo horário a Task 15 configura
    // logo abaixo, o que garante slot disponível no diálogo de marcação.
    await page.getByLabel("ID do responsável (usuário)").fill(manager.id);
    await page.getByRole("button", { name: "Criar tipo" }).click();
    await expect(page.getByText("Tipo criado.")).toBeVisible();
    await expect(page.getByText(tipoNome)).toBeVisible();

    // --- 2. horário do atendente (Task 15) ---
    // Todos os 7 dias, de 07:00 às 21:00: cobre qualquer dia da semana e fuso
    // em que este teste rode, sem depender de `new Date().getDay()` bater com
    // o dia da semana calculado no fuso da organização.
    await page.goto("/app/settings/meu-horario");
    const horarios = page.locator('input[type="time"]');
    const total = await horarios.count();
    for (let i = 0; i < total; i += 2) {
      await horarios.nth(i).fill("07:00");
      await horarios.nth(i + 1).fill("21:00");
    }
    await page.getByRole("button", { name: "Salvar horário" }).click();
    await expect(page.getByText("Horário salvo.")).toBeVisible();

    // --- 3. lead pela API pública, no funil padrão ---
    const contactName = `Cliente Agenda E2E ${stamp}`;
    const contactRes = await page.request.post("/api/v1/contacts", {
      data: { display_name: contactName },
    });
    expect(contactRes.status()).toBe(201);
    const { data: contactResult } = (await contactRes.json()) as ApiOk<{ contact: { id: string } }>;

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
      data: {
        pipeline_id: pipelineId,
        stage_id: stageId,
        title: contactName,
        contact_id: contactResult.contact.id,
      },
    });
    expect(leadRes.status()).toBe(201);
    const { data: leadCreated } = (await leadRes.json()) as ApiOk<{ id: string }>;

    // --- 4. abre o lead no kanban (Task 16) e marca o horário (Task 17) ---
    await page.goto(`/app/pipelines/${pipelineId}`);
    const card = page.getByRole("group", { name: `Lead: ${contactName}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: contactName }).click();

    // O dossiê é um Sheet — role=dialog no Radix, nomeado pelo título do lead
    // (mesmo padrão de followup-dossie.spec.ts).
    const dossie = page.getByRole("dialog", { name: contactName });
    await expect(dossie).toBeVisible();
    await expect(dossie.getByText("Sem horário marcado")).toBeVisible();

    await dossie.getByRole("button", { name: "Marcar horário" }).click();

    // O diálogo de marcação é OUTRO role=dialog, aberto por cima do Sheet —
    // escopar pelo próprio título evita ambiguidade entre os dois.
    const dialogoAgendamento = page.getByRole("dialog", { name: "Marcar horário" });
    await expect(dialogoAgendamento).toBeVisible();

    await dialogoAgendamento.getByRole("combobox").click();
    await page.getByRole("option", { name: `${tipoNome} (30 min)`, exact: true }).click();

    await expect(dialogoAgendamento.getByText("Nenhum horário livre neste dia.")).toHaveCount(0);
    // Primeiro slot livre do dia — os botões mostram "HH:MM" (toLocaleTimeString).
    await dialogoAgendamento.locator("button", { hasText: /^\d{2}:\d{2}$/ }).first().click();
    await dialogoAgendamento.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByText("Horário marcado.")).toBeVisible();

    // O dossiê reflete o próprio agendamento sem reabrir nada.
    await expect(dossie.getByText(/Próximo horário:/)).toBeVisible({ timeout: 15_000 });

    // --- 5. aparece na Agenda ---
    // Escopado pelo link "Ver lead" deste lead específico, não por "Marcado"
    // solto — outros agendamentos já marcados hoje (de execuções anteriores
    // desta mesma spec, banco compartilhado entre specs) tornariam esse texto
    // ambíguo e o `toBeVisible` quebraria em modo estrito.
    await page.goto("/app/agenda");
    const linkDoLead = page.locator(`a[href="/app/kanban?lead=${leadCreated.id}"]`);
    const cardDaAgenda = linkDoLead.locator("..").locator("..");
    await expect(cardDaAgenda).toBeVisible({ timeout: 30_000 });
    await expect(cardDaAgenda.getByText("Marcado")).toBeVisible();
  });
});
