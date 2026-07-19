/**
 * E2E do fluxo completo de Webhooks & Automações (Task 6 — verificação final).
 *
 * Cenário (manager do seed E2E): cria uma fonte de captação, dispara o lead de
 * teste embutido na UI, cria uma automação (gatilho "contato novo (webhook)" →
 * ação "Adicionar tag"), liga a automação, dispara um lead real via POST direto
 * na URL da fonte, drena o event_log, confere a execução na aba Atividade e o
 * lead + tag no Kanban. Fecha conferindo que o AGENT não vê a seção nem
 * consegue acessar a rota.
 *
 * Self-contido: nomes com sufixo de timestamp (não depende de nem quebra dados
 * de outras sessões manuais no mesmo banco de dev); limpa a fonte e a
 * automação criadas ao final (try/finally) para reruns ficarem verdes.
 *
 * Nota de porta: playwright.config.ts aponta baseURL para :3001, mas esse
 * worktree sobe seu próprio dev server em :3011 (outro worktree já ocupa a
 * :3001 — reuseExistingServer teria reusado o servidor ERRADO). Por isso este
 * spec usa APP_URL absoluto em vez do baseURL do config.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page, type Locator } from "@playwright/test";

// Segue o dev server do harness (playwright.config webServer) — nunca hardcodar
// porta: o config usa E2E_PORT (default 3001).
const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const needsBase = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager || !c.users?.agent;
  };
  if (needsBase()) {
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
const ts = Date.now();
const SOURCE_NAME = `E2E Landing ${ts}`;
const RULE_NAME = `E2E Automação ${ts}`;
const LEAD_NAME = `Ana E2E ${ts}`;
const TAG = "e2e-tag";

// Card do design system (Card/CardHeader) — mesmas classes em toda a app.
// Sobe do texto (título) até o container do card pra escopar asserções vizinhas.
function cardOf(locator: Locator): Locator {
  return locator.locator(
    "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' border-border ')][1]",
  );
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function selectFirstOption(page: Page, combobox: Locator): Promise<void> {
  await combobox.click();
  await page.getByRole("option").first().click();
}

// Toasts seguem uma mutação de rede real (Supabase remoto + compilação a
// frio de rota no Next dev) — o default de 5s do expect já se mostrou curto
// demais num run real; 15s dá folga sem mascarar uma falha genuína.
async function expectToast(page: Page, text: string): Promise<void> {
  await expect(page.getByText(text)).toBeVisible({ timeout: 15_000 });
}

test.describe("webhooks & automações — fluxo completo", () => {
  // Fluxo longo e sequencial (2 logins, múltiplos diálogos, POST direto,
  // drain com esperas deliberadas, polling da timeline, limpeza no final) —
  // 120s não sobrou margem no primeiro run real (chegou até o último passo
  // do cleanup e estourou o deadline global).
  test.setTimeout(180_000);
  // Timeout curto por ação: sem isso, uma ação travada consome o budget do
  // teste inteiro em silêncio (foi o que aconteceu) em vez de falhar rápido
  // com diagnóstico.
  test.use({ actionTimeout: 10_000 });

  test("cria fonte, cria automação, dispara lead real, confere atividade e kanban; agent sem acesso", async ({
    page,
    request,
    browser,
  }) => {
    let sourceId: string | undefined;
    let ruleCreated = false;
    let pipelineId: string | undefined;

    try {
      // --- Step 1: login como manager; sidebar mostra "Webhooks" ---
      await login(page, creds.users.manager!.email);
      await expect(page.getByRole("link", { name: "Webhooks" })).toBeVisible();
      await page.getByRole("link", { name: "Webhooks" }).click();
      await page.waitForURL(/\/app\/webhooks/);

      // --- Step 2: aba "Receber dados" — criar fonte ---
      await expect(page.getByRole("tab", { name: "Receber dados" })).toHaveAttribute(
        "data-state",
        "active",
      );
      await page.getByRole("button", { name: /Nova fonte|Criar primeira fonte/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.locator("#src-name").fill(SOURCE_NAME);

      const dialog = page.getByRole("dialog");
      await selectFirstOption(page, dialog.getByRole("combobox").nth(0));
      await selectFirstOption(page, dialog.getByRole("combobox").nth(1));

      const [createRes] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/v1/webhook-sources") && r.request().method() === "POST",
        ),
        page.getByRole("button", { name: "Criar fonte" }).click(),
      ]);
      expect(createRes.ok()).toBeTruthy();
      const createBody = (await createRes.json()) as {
        data: { id: string; path_token: string; default_pipeline_id: string };
      };
      sourceId = createBody.data.id;
      pipelineId = createBody.data.default_pipeline_id;
      const pathToken = createBody.data.path_token;
      const sourceUrl = `${APP_URL}/api/v1/webhooks/in/${pathToken}`;

      await expectToast(page, "Fonte criada. Agora é só conectar seu site.");

      // --- Step 3: sheet da fonte abre sozinho; URL visível + lead de teste ---
      const sheet = page.getByRole("dialog").filter({ hasText: SOURCE_NAME });
      await expect(sheet.locator("code", { hasText: "/api/v1/webhooks/in/" }).first()).toBeVisible();
      await sheet.getByRole("button", { name: "Enviar lead de teste" }).click();
      await expectToast(page, "Funcionou! Um lead de teste entrou no seu funil.");
      await page.keyboard.press("Escape");

      // --- Step 4: aba Automações — criar regra + ligar ---
      await page.getByRole("tab", { name: "Automações" }).click();
      await page.getByRole("button", { name: /Nova automação|Criar primeira automação/ }).click();
      const ruleSheet = page.getByRole("dialog");
      await expect(ruleSheet).toBeVisible();
      await ruleSheet.locator("#rule-name").fill(RULE_NAME);

      await ruleSheet.getByRole("combobox").first().click();
      await page
        .getByRole("option", { name: "Quando entrar um contato novo (webhook)" })
        .click();

      await ruleSheet.getByRole("combobox").filter({ hasText: "Adicionar ação" }).click();
      await page.getByRole("option", { name: "Adicionar tag" }).click();
      await page.getByPlaceholder("boas-vindas, novo-lead").fill(TAG);

      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/v1/automation-rules") && r.request().method() === "POST",
        ),
        page.getByRole("button", { name: "Criar automação" }).click(),
      ]);
      ruleCreated = true;
      await expectToast(page, "Automação criada — ligue quando estiver pronta.");

      const ruleTitle = page.getByText(RULE_NAME, { exact: true });
      const ruleCard = cardOf(ruleTitle);
      await expect(ruleCard.getByText("Pausada")).toBeVisible();

      await page.getByRole("switch", { name: `Ligar ${RULE_NAME}` }).click();
      await expectToast(page, "Automação ligada.");
      await expect(ruleCard.getByText("Ativa")).toBeVisible();

      // --- Step 5: dispara lead real direto na URL da fonte ---
      const directRes = await request.post(sourceUrl, {
        data: { nome: LEAD_NAME, telefone: "11987654321" },
      });
      expect(directRes.status()).toBe(200);
      const directBody = (await directRes.json()) as { data: { lead_id: string } };
      expect(directBody.data.lead_id).toBeTruthy();

      // --- Step 6: drena o event_log (até 3 ticks — trigger legado duplica evento) ---
      const internalSecret = loadInternalSecret();
      for (let i = 0; i < 3; i++) {
        // Batch de até 50 eventos pendentes, cada um com handlers que fazem
        // vários round-trips de DB (e potencialmente WAHA/IA) — bem mais lento
        // que uma ação de UI; timeout maior que o actionTimeout padrão do teste.
        const drainRes = await request.post(`${APP_URL}/api/v1/cron/event-log-drain`, {
          headers: { Authorization: `Bearer ${internalSecret}` },
          timeout: 60_000,
        });
        expect(drainRes.ok()).toBeTruthy();
        await page.waitForTimeout(700);
      }

      // --- Step 7: aba Atividade mostra a run com sucesso ---
      // A regra não tem condição — dispara tanto pro "Lead de Teste" (passo 3)
      // quanto pro lead real (passo 5), logo pode haver 2 cards com esse nome;
      // .first() basta pra confirmar que a automação rodou com sucesso.
      await page.getByRole("tab", { name: "Atividade" }).click();
      const runTitle = page.getByText(RULE_NAME, { exact: true }).first();
      const runCard = cardOf(runTitle);
      let found = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        if ((await runCard.count()) > 0 && (await runCard.getByText("Sucesso").count()) > 0) {
          found = true;
          break;
        }
        await page.getByRole("button", { name: "Atualizar" }).click();
        await page.waitForTimeout(1000);
      }
      expect(found, "run da automação não apareceu com status Sucesso na aba Atividade").toBe(
        true,
      );
      await expect(runCard.getByText("Sucesso")).toBeVisible();

      // --- Step 8: /app/pipelines/{pipelineId} mostra o card com a tag ---
      await page.goto(`${APP_URL}/app/pipelines/${pipelineId}`);
      const leadHeading = page.getByRole("heading", { name: LEAD_NAME });
      await expect(leadHeading).toBeVisible({ timeout: 15_000 });
      const leadCard = leadHeading.locator(
        "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' border-border ')][1]",
      );
      await expect(leadCard.getByText(TAG)).toBeVisible();

      // --- Step 9: AGENT não vê "Webhooks" e é redirecionado ---
      const agentContext = await browser.newContext();
      const agentPage = await agentContext.newPage();
      try {
        await login(agentPage, creds.users.agent!.email);
        await expect(agentPage.getByRole("link", { name: "Webhooks" })).toHaveCount(0);
        await agentPage.goto(`${APP_URL}/app/webhooks`);
        await agentPage.waitForURL(/\/app\/inbox/);
        expect(agentPage.url()).toMatch(/\/app\/inbox/);
      } finally {
        await agentContext.close();
      }
    } finally {
      // --- Cleanup: exclui a automação e a fonte criadas (reruns ficam verdes) ---
      // Nunca deixa uma falha AQUI mascarar o erro real do bloco try (um throw
      // no finally substitui a exceção pendente) — só loga e segue.
      try {
        if (ruleCreated) {
          await page.goto(`${APP_URL}/app/webhooks`);
          await page.getByRole("tab", { name: "Automações" }).click();
          const ruleTitle = page.getByText(RULE_NAME, { exact: true });
          // waitFor (não .count() imediato): a lista busca via rede após a
          // troca de aba — um count() síncrono aqui pegava 0 e pulava o
          // cleanup inteiro em silêncio.
          const ruleVisible = await ruleTitle
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
          if (ruleVisible) {
            await cardOf(ruleTitle).getByRole("button", { name: "Excluir automação" }).click();
            await page.getByRole("button", { name: "Excluir", exact: true }).click();
            await expectToast(page, "Automação excluída.");
          }
        }
        if (sourceId) {
          await page.getByRole("tab", { name: "Receber dados" }).click();
          const sourceTitle = page.getByText(SOURCE_NAME, { exact: true });
          const sourceVisible = await sourceTitle
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
          if (sourceVisible) {
            await cardOf(sourceTitle).click();
            await page.getByRole("button", { name: "Excluir fonte" }).click();
            await page.getByRole("button", { name: "Excluir", exact: true }).click();
            await expectToast(page, "Fonte excluída.");
          }
        }
      } catch (cleanupErr) {
        console.error("[cleanup] falhou (não mascara o erro do teste):", cleanupErr);
      }
    }
  });
});
