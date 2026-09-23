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
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

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
  const envDeTeste = carregarEnvLocal();
  const match = [null, envDeTeste.INTERNAL_SECRET];
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
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
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

  // ⚠️ ESTA SPEC NÃO ENVIA NADA, E MESMO ASSIM DEPENDE DA JANELA DE ENVIO.
  //
  // A ação dela é "adicionar tag", que nunca é adiada. Mas a pré-checagem de
  // adiamento do motor é ALL-OR-NOTHING sobre o evento: basta uma regra irmã
  // com ação de WhatsApp no mesmo gatilho estar fora da janela para o evento
  // INTEIRO ser abortado — e aí a tag nunca executa, nenhum run é gravado, e a
  // asserção de "Sucesso" mais abaixo estoura as 12 tentativas.
  //
  // Foi exatamente o que aconteceu a partir das 22h BRT, em toda branch, por um
  // dia inteiro. O seed declara a janela do rig (0h-24h, `garantirJanelaSempreAberta`),
  // e é ele que tira a hora do CI de dentro da conta deste teste.
  test.beforeAll(() => {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-numero-conectado.ts"], { stdio: "inherit" });
  });

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

      // --- Step 6: drena o event_log ATÉ ESVAZIAR, não um número fixo de ticks ---
      //
      // Contar ticks era um PROXY para "drenou o suficiente", e o proxy dependia
      // de quantas specs rodaram antes: a fila é global, FIFO por `created_at`, e
      // esta spec é a 21ª de 42 na parte 2 do CI. Com a fila acima da capacidade
      // do laço, o evento DESTA automação — o mais novo — nunca era alcançado, e
      // o sintoma era "run da automação não apareceu com status Sucesso".
      //
      // MEDIDO (2026-08-30, local, mesmo build): o tick devolve
      // `{"scanned":50,"done":50,...}`; com 200 na fila a spec passava, com 300
      // falhava com a mensagem EXATA do CI, na mesma linha. O conserto não é
      // aumentar o número de ticks — isso só adia, e a dívida cresce sozinha a
      // cada spec nova. É trocar o proxy pela condição: drena enquanto houver
      // trabalho.
      const internalSecret = loadInternalSecret();
      const TETO_DE_TICKS = 40; // trava de segurança: 40 × 50 = 2000 eventos
      let ticks = 0;
      let ultimoResumo: { scanned?: number; retried?: number; failed?: number } = {};
      for (; ticks < TETO_DE_TICKS; ticks++) {
        // Batch de até 50 eventos pendentes, cada um com handlers que fazem
        // vários round-trips de DB (e potencialmente WAHA/IA) — bem mais lento
        // que uma ação de UI; timeout maior que o actionTimeout padrão do teste.
        const drainRes = await request.post(`${APP_URL}/api/v1/cron/event-log-drain`, {
          headers: { Authorization: `Bearer ${internalSecret}` },
          timeout: 60_000,
        });
        expect(drainRes.ok()).toBeTruthy();
        const resumo = (await drainRes.json()) as {
          data?: { scanned?: number; retried?: number; failed?: number };
        };
        ultimoResumo = resumo.data ?? {};
        await page.waitForTimeout(700);
        // A condição de parada é "não há mais NADA pendente" (`scanned === 0`),
        // NUNCA "o meu evento apareceu": parar no próprio evento esconderia
        // acúmulo deixado por outras specs, que é o defeito que este conserto
        // existe para expor. Sai DEPOIS do tick vazio, não no primeiro lote
        // parcial: o trigger legado duplica evento, e parar antes deixaria o par
        // para trás — a razão original de o laço ser 3 e não 1.
        if ((resumo.data?.scanned ?? 0) === 0) break;
      }
      // Estourar o teto FALHA, e falha dizendo o que sobrou. Seguir em silêncio
      // devolveria o defeito disfarçado de timeout: "não drenou o suficiente" é
      // exatamente o que estamos consertando, e ele não pode voltar sem nome.
      expect(
        ticks,
        `a fila não esvaziou em ${TETO_DE_TICKS} ticks (${TETO_DE_TICKS * 50} eventos). ` +
          `Último tick: scanned=${ultimoResumo.scanned ?? "?"}, ` +
          `retried=${ultimoResumo.retried ?? "?"}, failed=${ultimoResumo.failed ?? "?"}. ` +
          "Acúmulo grande demais para ser ruído desta spec — ou há evento que falha e reenfileira em laço.",
      ).toBeLessThan(TETO_DE_TICKS);

      // O CAMINHO VERDE TAMBÉM CARREGA O DADO.
      //
      // Sem esta linha, `ticks` só é revelado quando a asserção acima FALHA — o
      // run que passa joga fora exatamente a medida que responde à pergunta em
      // aberto: a fila estava mesmo acumulando, ou 3 ticks bastavam e o vermelho
      // da `main` vinha da janela de envio (#450)?
      //
      // Enquanto o dado morre no verde, a única forma de responder é um
      // experimento caro: rodar esta branch sem o #450, num horário dentro da
      // faixa 01:00-10:00 UTC. Registrando, todo run futuro responde de graça —
      // se vier sempre 1 ou 2, a tese do acúmulo cai por medição própria; se
      // vier alto, ela se confirma. Os dois desfechos informam.
      //
      // `console.info` e não `console.log`: é o método que o eslint deste repo
      // permite (`no-console` com `allow: ["warn","error","info"]`) e o padrão
      // que 7 specs já usam — as linhas `[QA] …` que aparecem no log do CI saem
      // daí (`qa-agente-usa-as-maos.spec.ts:517`). Não é precedente novo.
      //
      // Instrumento, não catraca: baixar o TETO compraria a mesma resposta
      // pagando com risco de flake, e flake foi o defeito que este arquivo
      // acabou de custar um dia para consertar.
      console.info(
        `[QA] fila do event_log drenou em ${ticks} tick(s) de ${TETO_DE_TICKS} ` +
          `(último: scanned=${ultimoResumo.scanned ?? "?"}, ` +
          `retried=${ultimoResumo.retried ?? "?"}, failed=${ultimoResumo.failed ?? "?"})`,
      );

      // --- Step 7: aba Atividade mostra a run com sucesso ---
      // A regra não tem condição — dispara tanto pro "Lead de Teste" (passo 3)
      // quanto pro lead real (passo 5), logo pode haver 2 cards com esse nome;
      // .first() basta pra confirmar que a automação rodou com sucesso.
      await page.getByRole("tab", { name: "Atividade" }).click();
      const runTitle = page.getByText(RULE_NAME, { exact: true }).first();
      const runCard = cardOf(runTitle);
      let found = false;
      // Fotografado a cada tentativa para a mensagem de falha poder DISTINGUIR as
      // causas. A asserção antiga dizia só "não apareceu com status Sucesso", e
      // esse texto cobre TRÊS mundos diferentes:
      //
      //   card nem existe        -> a automação não rodou (evento não chegou ao motor)
      //   card existe, sem status-> rodou e ficou pendente (run travado)
      //   card existe com outro  -> rodou e FALHOU (o motor tem o porquê gravado)
      //
      // As três pedem investigações diferentes, e o teste as entregava como uma
      // frase só. Isso custou uma noite: o vermelho do CI foi lido como acúmulo
      // de fila, corrigido, e voltou — porque a mensagem não dizia o que a tela
      // realmente mostrava.
      let diagnostico = "nenhuma tentativa registrada";
      for (let attempt = 0; attempt < 12; attempt++) {
        const cards = await runCard.count();
        if (cards > 0 && (await runCard.getByText("Sucesso").count()) > 0) {
          found = true;
          break;
        }
        diagnostico =
          cards === 0
            ? `tentativa ${attempt + 1}: NENHUM card com o nome da regra na aba Atividade`
            : `tentativa ${attempt + 1}: card existe, e o texto dele é ${JSON.stringify(
                (await runCard.first().innerText()).replace(/\s+/g, " ").trim().slice(0, 240),
              )}`;
        await page.getByRole("button", { name: "Atualizar" }).click();
        await page.waitForTimeout(1000);
      }
      expect(
        found,
        `run da automação não apareceu com status Sucesso na aba Atividade. ${diagnostico}`,
      ).toBe(true);
      await expect(runCard.getByText("Sucesso")).toBeVisible();

      // --- Step 8: /app/pipelines/{pipelineId} mostra o card com a tag ---
      await page.goto(`${APP_URL}/app/pipelines/${pipelineId}`);
      const leadHeading = page.getByRole("heading", { name: LEAD_NAME });
      await expect(leadHeading).toBeVisible({ timeout: 15_000 });
      // A TAG VIVE NO `title` DO CARD, não como texto visível.
      //
      // `KanbanCard.tsx` publica `title={`Tags: ...`}` com um comentário que
      // declara a intenção: "Tags saem do card (Lei A): ficam a um hover, sem
      // ocupar altura". Esta spec afirmava texto visível — ela é que envelheceu
      // junto com o desenho, e ninguém soube porque ela nunca rodou em gate
      // (issue #63). Afirmar o `title` mantém a garantia que importa: a tag que
      // a automação aplicou CHEGOU ao card.
      const leadCard = leadHeading.locator(
        "xpath=ancestor::div[@role='group'][1]",
      );
      await expect(leadCard).toHaveAttribute("title", new RegExp(`Tags:.*${TAG}`));

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
