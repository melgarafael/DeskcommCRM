/**
 * J20.6 — UMA NOVA SUBMISSÃO DO RESPONDI AUTORIZA A IA (e o retorno do lead
 * pelo WhatsApp é atendido).
 *
 * Num canal com o gate LIGADO (`channel_sessions.metadata.ai_gate='allowlist'`),
 * a IA só assume um contato que uma ORIGEM ELEGÍVEL autorizou. Uma submissão do
 * Respondi é uma dessas origens: o webhook `POST /api/v1/webhooks/in/:token`
 * carimba `contacts.ai_authorized_at` + `ai_authorized_reason='respondi:<form>:<sub>'`.
 * Depois disso, quando o lead responder pelo WhatsApp, o drain do agent-engine
 * ENFILEIRA o turno em vez de pular.
 *
 * O que este spec prova, e por qual observável:
 *   - a submissão do Respondi autoriza o contato   → `contacts.ai_authorized_at` / `_reason`
 *   - o retorno do lead autorizado gera turno       → linha em `job_queue` (kind `inbound_turn`)
 *   - CONTROLE — um número que NÃO passou pelo       → `event_log` vira `done`, SEM job
 *     Respondi, no mesmo canal, não gera turno
 *
 * O drain do agent-engine roda no `workers/agent-worker` (processo 24/7) em
 * produção; a suíte E2E não sobe worker, então o tick é chamado pela MESMA
 * função (`drainTick`) via `scripts/e2e-elegibilidade-helpers.ts drain-once`.
 *
 * Pré-requisitos (banco local estilo VPS, app buildada):
 *   npx tsx scripts/seed-e2e-credentials.ts
 *   npx tsx scripts/seed-e2e-elegibilidade.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3001 pnpm exec playwright test tests/e2e/j20-elegibilidade-respondi.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const RESPONDI_FIXTURE = path.join(process.cwd(), "tests/fixtures/webhooks/respondi-imobiliario.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/j20-elegibilidade");

const RESPONDI_PHONE_ALIAS = "Qual é o melhor WhatsApp para falarmos sobre essa análise?";

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
  elegibilidade?: {
    channel_session_id: string;
    waha_path_token: string;
    credential_id: string;
    webhook_source_token: string;
  };
}

let creds: Creds;

function seedBase(): void {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  const atual = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!atual.elegibilidade) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-elegibilidade.ts"], { stdio: "inherit" });
  }
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!creds.elegibilidade) {
    throw new Error("bloco `elegibilidade` ausente após seed — veja a saída de seed-e2e-elegibilidade.ts");
  }
}

function helper<T = unknown>(...args: string[]): T {
  const stdout = execFileSync("npx", ["tsx", "scripts/e2e-elegibilidade-helpers.ts", ...args], {
    encoding: "utf8",
  });
  const last = stdout.trim().split("\n").filter(Boolean).pop();
  if (!last) throw new Error(`helper ${args[0]} não imprimiu JSON`);
  return JSON.parse(last) as T;
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

/** Payload do Respondi com telefone + respondent_id únicos por execução. */
function respondiPayload(phone: string, respondentId: string): unknown {
  const base = JSON.parse(fs.readFileSync(RESPONDI_FIXTURE, "utf8")) as {
    respondent: { respondent_id?: string; answers: Record<string, string> };
  };
  base.respondent.respondent_id = respondentId;
  base.respondent.answers[RESPONDI_PHONE_ALIAS] = phone;
  return base;
}

async function esperarContatoPorTelefone(digits: string): Promise<{ id: string; ai_authorized_at: string | null; ai_authorized_reason: string | null }> {
  for (let i = 0; i < 20; i++) {
    const c = helper<{ id: string; ai_authorized_at: string | null; ai_authorized_reason: string | null } | null>(
      "find-contact-by-phone",
      digits,
    );
    if (c?.id) return c;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`contato do telefone ${digits} não apareceu em 10s`);
}

async function esperarDispatch(contactId: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    const ev = helper<{ id: string } | null>("dispatch-event", contactId);
    if (ev?.id) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`ai_agent.dispatch_requested do contato ${contactId} não apareceu em 12s`);
}

test.describe("J20.6 — a submissão do Respondi autoriza a IA", () => {
  test.describe.configure({ timeout: 240_000 });
  test.use({ actionTimeout: 15_000 });

  test.beforeAll(() => {
    seedBase();
  });

  test("Respondi autoriza o contato; o retorno do lead gera turno; número não-autorizado NÃO gera", async ({
    page,
  }) => {
    const session = "e2e-elegibilidade-session";
    const tail = String(Date.now()).slice(-8);

    // AUTORIZADO — passa pelo Respondi.
    const respPhone = `55 11 9${tail}`;
    const respDigits = `9${tail}`;
    const respChatId = `55119${tail}@c.us`;
    const respondentId = `e2e-${Date.now()}`;

    // CONTROLE — mesmo canal, sem Respondi.
    const ctrlTail = String(Date.now() + 1).slice(-8);
    const ctrlChatId = `55119${ctrlTail}@c.us`;
    const ctrlDigits = `9${ctrlTail}`;

    let agentId = "";
    let respContactId = "";
    let ctrlContactId = "";

    try {
      await login(page, creds.users.manager!.email);
      // Agente publicado no canal do gate — SETUP (o `POST /api/v1/ai/agents`
      // exige role `admin`/MFA e o agente não é o que está sob teste; sem ele o
      // drain pularia por "nenhum agente publicado para a sessão").
      agentId = helper<{ agentId: string }>("publish-agent").agentId;

      // ---------------------------------------------------------------------
      // (1) A submissão do Respondi entra pela URL da fonte de captação.
      // ---------------------------------------------------------------------
      const token = creds.elegibilidade!.webhook_source_token;
      const sub = await page.request.post(`${APP_URL}/api/v1/webhooks/in/${token}`, {
        data: respondiPayload(respPhone, respondentId),
      });
      expect(sub.status(), await sub.text()).toBe(200);

      // ---------------------------------------------------------------------
      // (2) O contato ficou ELEGÍVEL — carimbo com a origem.
      // ---------------------------------------------------------------------
      const contato = await esperarContatoPorTelefone(respDigits);
      respContactId = contato.id;
      await expect
        .poll(
          () => helper<{ ai_authorized_at: string | null }>("contact-authorization", respContactId).ai_authorized_at,
          { timeout: 15_000, message: "a submissão do Respondi tem de carimbar ai_authorized_at" },
        )
        .not.toBeNull();
      expect(
        helper<{ ai_authorized_reason: string | null }>("contact-authorization", respContactId).ai_authorized_reason,
      ).toMatch(/^respondi:/);

      // ---------------------------------------------------------------------
      // (3) O lead volta pelo WhatsApp → dispatch → drain ENFILEIRA o turno.
      // ---------------------------------------------------------------------
      const inboundRespondi = await fetch(`${APP_URL}/api/v1/webhooks/waha/${creds.elegibilidade!.waha_path_token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "message",
          session,
          payload: {
            id: `false_${respChatId}_J206A${Date.now()}`,
            from: respChatId,
            fromMe: false,
            body: "Oi, recebi o contato de vocês. Podem me explicar como funciona?",
            type: "chat",
            timestamp: Math.floor(Date.now() / 1000),
          },
        }),
      });
      expect(inboundRespondi.status).toBe(200);
      await esperarDispatch(respContactId);

      helper("drain-once");

      await expect
        .poll(() => helper<{ id: string } | null>("job-inbound-turn", respContactId), {
          timeout: 20_000,
          message: "contato autorizado pelo Respondi: o drain tem de enfileirar o turno",
        })
        .not.toBeNull();

      // ---------------------------------------------------------------------
      // (4) CONTROLE — número que não passou pelo Respondi, no mesmo canal.
      // ---------------------------------------------------------------------
      const inboundCtrl = await fetch(`${APP_URL}/api/v1/webhooks/waha/${creds.elegibilidade!.waha_path_token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "message",
          session,
          payload: {
            id: `false_${ctrlChatId}_J206B${Date.now()}`,
            from: ctrlChatId,
            fromMe: false,
            body: "Bom dia, tudo bem?",
            type: "chat",
            timestamp: Math.floor(Date.now() / 1000),
          },
        }),
      });
      expect(inboundCtrl.status).toBe(200);
      ctrlContactId = (await esperarContatoPorTelefone(ctrlDigits)).id;
      await esperarDispatch(ctrlContactId);

      helper("drain-once");

      // O evento foi CONSUMIDO (done) mas SEM job — a IA não assume.
      await expect
        .poll(() => helper<{ status: string } | null>("dispatch-event", ctrlContactId)?.status ?? null, {
          timeout: 20_000,
        })
        .toBe("done");
      expect(
        helper<{ id: string } | null>("job-inbound-turn", ctrlContactId),
        "contato NÃO autorizado no canal com gate: nenhum turno enfileirado",
      ).toBeNull();

      // ---------------------------------------------------------------------
      // (5) Evidência: as duas conversas na inbox.
      // ---------------------------------------------------------------------
      await page.goto(`${APP_URL}/app/inbox`);
      await page.waitForLoadState("networkidle");
      fs.mkdirSync(EVIDENCIA, { recursive: true });
      await page.screenshot({ path: path.join(EVIDENCIA, "06-inbox-respondi-vs-controle.png"), fullPage: true });
    } finally {
      for (const id of [respContactId, ctrlContactId]) {
        if (id) {
          try {
            helper("cleanup-contact", id);
          } catch (e) {
            console.error("[cleanup] contato falhou:", e);
          }
        }
      }
      if (agentId) {
        try {
          helper("archive-agent", agentId);
        } catch (e) {
          console.error("[cleanup] archive-agent falhou:", e);
        }
      }
    }
  });
});
