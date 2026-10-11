/**
 * O DESIGNER DE AUTOMAÇÕES grava a MESMA regra que o editor em lista.
 *
 * Fase 1 do designer (`app/app/webhooks/automacoes/[id]`): o canvas é outra
 * forma de montar a automação, não outra automação. A prova é pela tela, do
 * jeito que um gerente usaria, e mede três coisas:
 *
 *   1. montar no canvas → o corpo que sai para `POST /api/v1/automation-rules`
 *      tem as ações NA ORDEM DAS LIGAÇÕES (é o que substitui as setas de
 *      subir/descer do editor em lista);
 *   2. o editor em lista abre a mesma regra, com as mesmas ações na mesma ordem;
 *   3. abrir no designer e salvar sem mexer manda o MESMO corpo de volta — o
 *      desenho não muda uma automação que roda sozinha.
 *
 * E um caso de recusa: ação sem configuração não sai do canvas, e o motivo
 * aparece NA CAIXA, sem nenhuma chamada à API.
 *
 * Sem dependência externa: o gatilho é "lead ganhou tag" e as ações (tag e
 * tarefa interna) não falam com o cliente, então não há número, WAHA nem
 * janela de envio no caminho.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { test, expect, type Page, type Request } from "./helpers/test";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const RULE_NAME = `E2E Designer ${Date.now()}`;
const TAG = "designer-e2e";
const TITULO = "Ligar para {{contact.name}}";

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

/** Escolhe uma opção de um Select do Radix pelo rótulo acessível do gatilho. */
async function escolher(page: Page, rotulo: string, opcao: string | RegExp): Promise<void> {
  await page.getByRole("combobox", { name: rotulo }).click();
  await page.getByRole("option", { name: opcao }).click();
}

const ehRegra = (metodo: string) => (r: Request) =>
  r.url().includes("/api/v1/automation-rules") && r.method() === metodo;

test.describe("designer de automações", () => {
  test.setTimeout(120_000);
  test.use({ actionTimeout: 15_000 });

  test("monta no canvas, grava a mesma regra do editor em lista e salvar sem mexer não muda nada", async ({ page }) => {
    let ruleId: string | undefined;
    try {
      await login(page, creds.users.manager!.email);

      // ── A porta: aba Automações → "Montar no designer" ───────────────────
      await page.goto(`${APP_URL}/app/webhooks?aba=automacoes`);
      await page.getByRole("link", { name: "Montar no designer" }).first().click();
      await page.waitForURL(/\/app\/webhooks\/automacoes\/nova$/);
      await expect(page.getByTestId("caixa-gatilho")).toBeVisible();

      await page.getByRole("textbox", { name: "Nome da automação" }).fill(RULE_NAME);

      // ── QUANDO: a trava de laço vale aqui como vale no editor em lista ───
      await page.getByTestId("caixa-gatilho").click();
      await escolher(page, "O que dispara a automação", "Quando um negócio for ganho");
      await expect(page.getByTestId("paleta-create_or_move_lead")).toBeDisabled();
      await expect(page.getByTestId("paleta-assign_owner")).toBeDisabled();
      await escolher(page, "O que dispara a automação", "Quando um lead ganhar uma tag");
      await expect(page.getByTestId("paleta-assign_owner")).toBeEnabled();

      // ── ENTÃO: duas ações pela paleta — cada clique entra no fim da fila ─
      await page.getByTestId("paleta-add_tag").click();
      await expect(page.getByTestId("caixa-acao-1")).toBeVisible();
      await page.getByPlaceholder("boas-vindas, novo-lead").fill(TAG);

      await page.getByTestId("paleta-create_task").click();
      await expect(page.getByTestId("caixa-acao-2")).toBeVisible();
      await page.getByPlaceholder("Ligar para {{contact.name}} sobre {{lead.title}}").fill(TITULO);

      // ── Salvar: o corpo é o do editor em lista, na ordem da fila ─────────
      const [criacao] = await Promise.all([
        page.waitForRequest(ehRegra("POST")),
        page.getByTestId("designer-salvar").click(),
      ]);
      const corpo = criacao.postDataJSON() as Record<string, unknown>;
      expect(corpo).toEqual({
        name: RULE_NAME,
        trigger_event: "lead.tag_added",
        conditions: [],
        actions: [
          { type: "add_tag", config: { tags: [TAG] } },
          { type: "create_task", config: { titulo: TITULO, vence_em_dias: 1, atribuir_a: "dono_do_lead", prioridade: "medium" } },
        ],
        trigger_config: {},
      });
      const resposta = await criacao.response();
      expect(resposta?.ok()).toBeTruthy();
      ruleId = ((await resposta!.json()) as { data: { id: string } }).data.id;
      await page.waitForURL(new RegExp(`/app/webhooks/automacoes/${ruleId}$`));
      await expect(page.getByText("Pausada").first()).toBeVisible();

      // ── O editor em lista abre a MESMA regra, na mesma ordem ─────────────
      await page.goto(`${APP_URL}/app/webhooks?aba=automacoes`);
      // Sobe do título até o CARD (o container com `border-border`), como em webhooks.spec.ts.
      const cartao = page
        .getByText(RULE_NAME, { exact: true })
        .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' border-border ')][1]");
      await cartao.getByRole("button", { name: "Editar automação" }).click();
      const gaveta = page.getByRole("dialog");
      await expect(gaveta.locator("#rule-name")).toHaveValue(RULE_NAME);
      const acoes = gaveta.locator("p.font-medium.text-text");
      await expect(acoes.nth(0)).toHaveText("Adicionar tag");
      await expect(acoes.nth(1)).toHaveText("Criar tarefa interna (sem mensagem ao cliente)");
      await page.keyboard.press("Escape");

      // ── Abrir no designer e salvar sem mexer: o mesmo corpo volta ────────
      await cartao.getByRole("link", { name: "Abrir no designer" }).click();
      await page.waitForURL(new RegExp(`/app/webhooks/automacoes/${ruleId}$`));
      await expect(page.getByTestId("caixa-acao-2")).toBeVisible();
      await expect(page.getByTestId("designer-alteracoes")).toHaveCount(0);
      const [semMexer] = await Promise.all([
        page.waitForRequest(ehRegra("PATCH")),
        page.getByTestId("designer-salvar").click(),
      ]);
      const { id: _id, ...devolvido } = semMexer.postDataJSON() as Record<string, unknown>;
      expect(devolvido).toEqual(corpo);

      // ── Recusa: ação sem configuração não sai do canvas ──────────────────
      await page.getByTestId("caixa-acao-2").click();
      await page.getByTestId("paleta-send_whatsapp_message").click();
      await expect(page.getByTestId("caixa-acao-3")).toBeVisible();
      let patchDepois = false;
      page.on("request", (r) => {
        if (ehRegra("PATCH")(r)) patchDepois = true;
      });
      await page.getByTestId("designer-salvar").click();
      await expect(page.getByTestId("caixa-acao-3-problema")).toContainText("Escolha o número de WhatsApp.");
      expect(patchDepois, "uma regra recusada pelo desenho não pode chegar à API").toBe(false);
    } finally {
      // Mesma sessão da tela: a rota exige gerente, e o `request` solto não tem cookie.
      if (ruleId) await page.request.delete(`${APP_URL}/api/v1/automation-rules/${ruleId}`);
    }
  });
});
