/**
 * E2E — o histórico de leads captados, pela TELA.
 *
 * Prova as três perguntas que a aba "Leads recebidos" existe para responder, e
 * prova a QUARTA, que é a que ninguém conseguia responder antes:
 *
 *   1. Chegou alguém?          → a linha aparece na tabela
 *   2. Com que dados?          → o painel mostra os campos do formulário
 *   3. De onde?                → IP, página e UTM no painel
 *   4. E QUANDO NÃO ENTRA?     → a captação RECUSADA aparece, com o motivo em
 *                                português. Antes, um formulário com nomes de
 *                                campo não reconhecidos recebia 400 e não
 *                                deixava rastro NENHUM na tela: a pessoa só
 *                                sabia que "não chegou nada".
 *
 * O POST é feito com `X-Forwarded-For` porque é assim que a captação chega numa
 * instalação de verdade: o kit expõe o Caddy, que faz `reverse_proxy app:3000`
 * e seta o header. Sem ele o campo IP fica nulo — que também é um desfecho
 * honesto, e é o que o painel diz.
 *
 * Self-contido: sufixo de timestamp em todo nome (o banco é compartilhado com
 * a outra parte do job e com sessões manuais) e limpeza no `finally`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { test, expect, type Page } from "@playwright/test";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager || !c.users?.viewer;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const ts = Date.now();
const SOURCE_NAME = `E2E Captação ${ts}`;
const LEAD_NAME = `Beatriz Captada ${ts}`;
const IP_DE_TESTE = "203.0.113.42";

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

test.describe("histórico de leads captados", () => {
  test.setTimeout(180_000);
  test.use({ actionTimeout: 15_000 });

  test("captação entra, aparece na tela com dados/hora/origem/IP, e a recusada também", async ({
    page,
    request,
  }) => {
    let sourceId: string | undefined;

    try {
      await login(page, creds.users.manager!.email);
      await page.goto(`${APP_URL}/app/webhooks`);

      // ── Uma fonte de captação, criada pela tela ──────────────────────────
      await page.getByRole("button", { name: /Nova fonte|Criar primeira fonte/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.locator("#src-name").fill(SOURCE_NAME);
      const dialog = page.getByRole("dialog");
      for (const i of [0, 1]) {
        await dialog.getByRole("combobox").nth(i).click();
        await page.getByRole("option").first().click();
      }
      const [criacao] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/v1/webhook-sources") && r.request().method() === "POST",
        ),
        page.getByRole("button", { name: "Criar fonte" }).click(),
      ]);
      expect(criacao.ok()).toBeTruthy();
      const corpo = (await criacao.json()) as { data: { id: string; path_token: string } };
      sourceId = corpo.data.id;
      const urlDaFonte = `${APP_URL}/api/v1/webhooks/in/${corpo.data.path_token}`;

      // Fecha o painel que abre sozinho depois de criar.
      await page.keyboard.press("Escape");

      // ── Um formulário preenchido de verdade ─────────────────────────────
      const envio = await request.post(urlDaFonte, {
        headers: {
          "X-Forwarded-For": `${IP_DE_TESTE}, 10.0.0.1`,
          Origin: "https://minha-landing.example",
          "User-Agent": "Mozilla/5.0 (E2E)",
        },
        data: {
          nome: LEAD_NAME,
          telefone: "11955554444",
          email: `beatriz${ts}@exemplo.test`,
          segmento: "Clínica odontológica",
          utm_source: "instagram",
        },
      });
      expect(envio.status()).toBe(200);

      // ── E um formulário que NÃO dá para aproveitar ───────────────────────
      // Campos que o mapeamento não reconhece: até esta entrega isto sumia.
      const recusado = await request.post(urlDaFonte, {
        headers: { "X-Forwarded-For": IP_DE_TESTE },
        data: { campo_estranho: "valor qualquer", outro: "coisa" },
      });
      expect(recusado.status()).toBe(400);

      // ── A TELA ───────────────────────────────────────────────────────────
      await page.goto(`${APP_URL}/app/webhooks`);
      await page.getByRole("tab", { name: "Leads recebidos" }).click();

      const linhaDoLead = page.getByRole("row", { name: new RegExp(LEAD_NAME) });
      await expect(linhaDoLead).toBeVisible({ timeout: 20_000 });

      // A linha traz o essencial sem precisar abrir nada. E ela É uma `row`:
      // um `role="button"` na <tr> a tiraria da tabela para quem usa leitor de
      // tela — o botão é a célula, não a linha.
      await expect(linhaDoLead).toContainText(SOURCE_NAME);
      await expect(linhaDoLead).toContainText("Virou lead");

      // ── O painel: dados, hora, origem, IP ───────────────────────────────
      await linhaDoLead.getByRole("button", { name: new RegExp(LEAD_NAME) }).click();
      const painel = page.getByRole("dialog");
      await expect(painel).toBeVisible();

      // 2. Com que dados — inclusive o campo do formulário que não é canônico.
      await expect(painel.getByText("Clínica odontológica")).toBeVisible();
      await expect(painel.getByText("11955554444")).toBeVisible();

      // 3. De onde — IP, página e UTM.
      await expect(painel.getByText(IP_DE_TESTE)).toBeVisible();
      await expect(painel.getByText("https://minha-landing.example")).toBeVisible();
      await expect(painel.getByText("instagram")).toBeVisible();

      // O laço de retorno: daqui se chega ao lead.
      await expect(painel.getByRole("link", { name: /Ver o lead no funil/ })).toBeVisible();

      await page.keyboard.press("Escape");

      // ── A RECUSADA aparece, e diz por quê ───────────────────────────────
      await page.getByRole("row", { name: /Não entrou/ }).first().click();
      const painelRecusa = page.getByRole("dialog");
      await expect(painelRecusa).toBeVisible();
      await expect(
        painelRecusa.getByText(/não trazia nome, telefone nem e-mail/i),
      ).toBeVisible();
      // Os campos crus estão lá — é o que quem depura precisa ver.
      await expect(painelRecusa.getByText("campo_estranho")).toBeVisible();
      await page.keyboard.press("Escape");

      // ── O filtro funciona (e é o que torna a tela usável com volume) ─────
      await page.getByRole("combobox", { name: "Filtrar por resultado" }).click();
      await page.getByRole("option", { name: "Não entrou" }).click();
      await expect(page.getByRole("row", { name: new RegExp(LEAD_NAME) })).toHaveCount(0);
      await expect(page.getByRole("row", { name: /Não entrou/ }).first()).toBeVisible();
    } finally {
      if (sourceId) {
        await request
          .delete(`${APP_URL}/api/v1/webhook-sources/${sourceId}`)
          .catch(() => undefined);
      }
    }
  });

  test("o VIEWER não alcança o histórico — o formulário tem PII", async ({ page }) => {
    // A rota exige manager, e a RLS também. É o par que o arquivo forense
    // (`webhook_events_log`) não tem: lá a policy é org-flat.
    await login(page, creds.users.viewer!.email);
    await page.goto(`${APP_URL}/app/webhooks`);
    await page.waitForURL(/\/app\/(inbox|403)/);
    expect(page.url()).not.toMatch(/\/app\/webhooks/);
  });
});
