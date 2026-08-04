/**
 * J6.8 — Anti-SSRF do outbound `call_webhook`, provado de ponta a ponta pela UI.
 *
 * Um tenant não pode usar a automação "Avisar outro sistema (webhook)" para
 * fazer o servidor bater em endereços internos (metadata da cloud, serviços
 * privados na mesma VPS). Este teste monta a regra pela tela apontando para um
 * receiver HTTP REAL em 127.0.0.1, dispara um lead real, drena o event_log e
 * prova que:
 *   - a run da automação NÃO entregou (aba Atividade mostra falha), e
 *   - o receiver recebeu ZERO requisições (o guard barrou antes do fetch).
 *
 * Contraparte do happy-path: o egress positivo (POST realmente entregue) exige
 * um endpoint HTTPS público — em produção `assertSafeOutboundUrl` exige https e
 * bloqueia hosts privados —, então essa metade fica para a sessão de deploy
 * real (mesma categoria do WhatsApp com número real).
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import { test, expect, type Page, type Locator } from "@playwright/test";

import { rodaSeed } from "./helpers/seed";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    rodaSeed("scripts/seed-e2e-credentials.ts");
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function loadInternalSecret(): string {
  const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  const secret = envFile.match(/^INTERNAL_SECRET=(.*)$/m)?.[1]?.trim();
  if (!secret) throw new Error("INTERNAL_SECRET não encontrado em .env.local");
  return secret;
}

const creds = loadCreds();
const ts = Date.now();
const SOURCE_NAME = `SSRF Source ${ts}`;
const RULE_NAME = `SSRF Outbound ${ts}`;

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

test.describe("J6.8 — anti-SSRF do outbound call_webhook (real, ponta a ponta)", () => {
  test.setTimeout(180_000);

  let receiver: http.Server;
  let receiverHits = 0;
  let receiverUrl = "";

  test.beforeAll(async () => {
    // Receiver HTTP real: conta toda requisição que chegar. O guard deve impedir
    // qualquer hit — se este contador subir, o anti-SSRF vazou.
    receiver = http.createServer((req, res) => {
      receiverHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const port = (receiver.address() as AddressInfo).port;
    receiverUrl = `http://127.0.0.1:${port}/inbound-privado`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });

  test("regra call_webhook para host interno → run falha e receiver recebe ZERO hits", async ({
    page,
    request,
  }) => {
    let sourceId: string | undefined;
    let ruleCreated = false;

    try {
      // --- fonte inbound (para gerar o lead que dispara a regra) ---
      await login(page, creds.users.manager!.email);
      await page.getByRole("link", { name: "Webhooks" }).click();
      await page.waitForURL(/\/app\/webhooks/);
      await page.getByRole("button", { name: /Nova fonte|Criar primeira fonte/ }).click();
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
      const created = (await createRes.json()) as { data: { id: string; path_token: string } };
      sourceId = created.data.id;
      const sourceUrl = `${APP_URL}/api/v1/webhooks/in/${created.data.path_token}`;
      await page.keyboard.press("Escape");

      // --- automação: gatilho lead novo → ação "Avisar outro sistema (webhook)" ---
      await page.getByRole("tab", { name: "Automações" }).click();
      await page.getByRole("button", { name: /Nova automação|Criar primeira automação/ }).click();
      const ruleSheet = page.getByRole("dialog");
      await ruleSheet.locator("#rule-name").fill(RULE_NAME);
      await ruleSheet.getByRole("combobox").first().click();
      await page.getByRole("option", { name: "Quando entrar um contato novo (webhook)" }).click();
      await ruleSheet.getByRole("combobox").filter({ hasText: "Adicionar ação" }).click();
      await page.getByRole("option", { name: "Avisar outro sistema (webhook)" }).click();
      await ruleSheet.getByPlaceholder("https://meusistema.com/webhook").fill(receiverUrl);
      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/v1/automation-rules") && r.request().method() === "POST",
        ),
        page.getByRole("button", { name: "Criar automação" }).click(),
      ]);
      ruleCreated = true;

      // liga a automação — e espera o SERVIDOR confirmar, não o pixel.
      //
      // `RulesTab.toggleActive` faz `qc.setQueryData` ANTES do `mutate`: a tela
      // escreve "Ativa" no mesmo frame do clique, com o PATCH ainda voando. Assertar
      // o texto e seguir dispara o lead enquanto o banco ainda tem `is_active=false`
      // — o handler de automações não casa a regra, marca o evento como `done` sem
      // criar run, sem erro nenhum, e o teste falha lá na frente com "a run não
      // apareceu". Foi essa a intermitência do spec (verde/vermelho alternando no CI
      // da main): não era vazão nem lentidão, era ler estado otimista como se fosse
      // confirmação.
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/automation-rules") &&
            r.request().method() === "PATCH" &&
            r.status() === 200,
          { timeout: 20_000 },
        ),
        page.getByRole("switch", { name: `Ligar ${RULE_NAME}` }).click(),
      ]);
      await expect(cardOf(page.getByText(RULE_NAME, { exact: true })).getByText("Ativa")).toBeVisible(
        { timeout: 15_000 },
      );

      // --- dispara lead real → drena ---
      const leadRes = await request.post(sourceUrl, {
        data: { nome: `SSRF Lead ${ts}`, telefone: "11987650000" },
      });
      expect(leadRes.status()).toBe(200);

      const internalSecret = loadInternalSecret();
      const drenar = async (): Promise<void> => {
        const drain = await request.post(`${APP_URL}/api/v1/cron/event-log-drain`, {
          headers: { Authorization: `Bearer ${internalSecret}` },
          timeout: 60_000,
        });
        expect(drain.ok()).toBeTruthy();
      };
      await drenar();

      // --- aba Atividade: a run aparece e NÃO é Sucesso (ação outbound barrada) ---
      await page.getByRole("tab", { name: "Atividade" }).click();
      const runTitle = page.getByText(RULE_NAME, { exact: true }).first();
      const runCard = cardOf(runTitle);
      let appeared = false;
      // Drena DENTRO do laço, não três vezes antes dele.
      //
      // O drain processa 50 eventos por chamada (`lib/event-log/drain.ts`), em ordem
      // de chegada. Três chamadas fixas alcançam 150 — e a fila deste banco tinha
      // 165 pendentes quando o spec falhou, acumulados pelos specs anteriores. O
      // evento DESTE teste estava atrás do lote, então a run nunca aparecia e o
      // veredito virava "a automação não rodou" para um problema de vazão.
      //
      // Backlog não é anomalia de teste: qualquer instalação com movimento tem fila.
      // Esperar por uma quantidade fixa de drenagens é presumir uma fila vazia.
      for (let attempt = 0; attempt < 12; attempt++) {
        if ((await runCard.count()) > 0) {
          appeared = true;
          break;
        }
        await drenar();
        await page.getByRole("button", { name: "Atualizar" }).click();
        await page.waitForTimeout(1000);
      }
      expect(appeared, "a run da automação não apareceu na aba Atividade").toBe(true);
      // a run não pode ter dado Sucesso — a ação outbound tem que ter falhado
      await expect(runCard.getByText(/Falhou|Parcial/)).toBeVisible({ timeout: 10_000 });

      // --- a PROVA de segurança: o receiver interno nunca foi tocado ---
      expect(
        receiverHits,
        `anti-SSRF vazou: o receiver interno recebeu ${receiverHits} requisição(ões)`,
      ).toBe(0);
    } finally {
      const svc = await import("@supabase/supabase-js").then((m) =>
        m.createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } },
        ),
      );
      if (ruleCreated) await svc.from("automation_rules").delete().eq("name", RULE_NAME);
      if (sourceId) await svc.from("webhook_sources").delete().eq("id", sourceId);
    }
  });
});
