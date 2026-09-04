/**
 * J20.18 — EU RESPONDO O CLIENTE À MÃO PELO WHATSAPP, E A IA PARA.
 *
 * Numa conversa que o gate autorizou (o lead veio de uma origem elegível), o
 * dono pega o celular e responde o cliente direto no WhatsApp. Essa mensagem
 * entra pelo webhook do provider (`fromMe=true`, sem passar pelo composer do
 * CRM). A IA tem de PARAR nessa conversa — silêncio COM PRAZO
 * (`bot_silenced_until = agora + PRAZO_DO_SILENCIO_MS` + rastro de handoff) —
 * SEM apagar `contacts.ai_authorized_at`: a origem do lead é estado separado da
 * pausa. O prazo vence sozinho, e a volta antecipada é pela tela ("devolver ao
 * automático").
 *
 * O que este spec prova, e por qual observável:
 *   - o webhook `fromMe=true` genuíno pausa a IA        → `conversations.bot_silenced_until`
 *   - o silêncio tem PRAZO, não é 'infinity'            → o instante gravado é finito e futuro
 *   - cada nova fala humana RENOVA o prazo              → `bot_silenced_until` e `last_handoff_at` avançam
 *   - a tela DIZ que uma pessoa assumiu                  → badge de atendimento humano
 *   - a autorização do lead SOBREVIVE à pausa            → `contacts.ai_authorized_at`
 *   - "devolver ao automático" solta a trava            → `bot_silenced_until` volta a null
 *     …e a autorização CONTINUA lá                        → `contacts.ai_authorized_at`
 *
 * Pré-requisitos (banco local estilo VPS, app buildada):
 *   npx tsx scripts/seed-e2e-credentials.ts
 *   npx tsx scripts/seed-e2e-elegibilidade.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3001 pnpm exec playwright test tests/e2e/j20-elegibilidade-atendimento-manual.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { PRAZO_DO_SILENCIO_MS } from "@/lib/escalacao/atendimento-manual";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/j20-elegibilidade");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
  elegibilidade?: { channel_session_id: string; waha_path_token: string };
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

/** Roda 1 subcomando do helper de SQL cru e devolve o JSON da última linha. */
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

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/** POST no webhook per-tenant do WAHA (mesma rota que o WAHA real chama; sem
 *  assinatura — `.env.e2e` não liga `WAHA_WEBHOOK_REQUIRE_SIGNATURE`). */
async function postWaha(payload: unknown): Promise<number> {
  const token = creds.elegibilidade!.waha_path_token;
  const res = await fetch(`${APP_URL}/api/v1/webhooks/waha/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.status;
}

async function esperarContatoPorTelefone(digits: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const c = helper<{ id: string } | null>("find-contact-by-phone", digits);
    if (c?.id) return c.id;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`contato do telefone ${digits} não apareceu em 10s`);
}

test.describe("J20.18 — resposta manual pelo celular pausa a IA (sem apagar a autorização)", () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ actionTimeout: 15_000 });

  test.beforeAll(() => {
    seedBase();
  });

  test("conversa autorizada → mensagem fromMe genuína pausa a IA; autorização sobrevive; a volta é pela tela", async ({
    page,
  }) => {
    const session = `e2e-elegibilidade-session`;
    // Telefone do cliente — E.164 sem o `+` vira o chatId `@c.us`.
    const digits = `55119${String(Date.now()).slice(-8)}`;
    const chatId = `${digits}@c.us`;
    let contactId = "";

    try {
      // ---------------------------------------------------------------------
      // (1) O cliente manda uma mensagem — a ingestão real cria contato+conversa.
      // ---------------------------------------------------------------------
      expect(
        await postWaha({
          event: "message",
          session,
          payload: {
            id: `false_${digits}@c.us_J20MANUAL${Date.now()}`,
            from: chatId,
            fromMe: false,
            body: "Oi, vi o formulário de vocês. Podem me passar os valores?",
            type: "chat",
            timestamp: Math.floor(Date.now() / 1000),
            _data: { notifyName: "Cliente J20.18" },
          },
        }),
      ).toBe(200);

      contactId = await esperarContatoPorTelefone(digits);

      // A origem elegível carimba a autorização (aqui, direto — o caso sob teste
      // não é o webhook do Respondi, é a resposta manual).
      expect(helper<{ ok: boolean }>("set-authorized", contactId).ok).toBe(true);

      const conv = helper<{ id: string; bot_silenced_until: string | null }>(
        "conversation-for-contact",
        contactId,
      );
      const conversationId = conv.id;
      expect(conv.bot_silenced_until, "estado de partida: sem silêncio").toBeNull();

      // ---------------------------------------------------------------------
      // (2) O dono responde pelo celular — webhook fromMe=true, sem composer.
      // ---------------------------------------------------------------------
      expect(
        await postWaha({
          event: "message.any",
          session,
          payload: {
            id: `true_${digits}@c.us_J20REPLY${Date.now()}`,
            to: chatId,
            fromMe: true,
            body: "Oi! Já te passo os valores por aqui.",
            type: "text",
            timestamp: Math.floor(Date.now() / 1000),
          },
        }),
      ).toBe(200);

      // ---------------------------------------------------------------------
      // (3) A PROVA QUE IMPORTA: a IA parou de verdade nesta conversa.
      // ---------------------------------------------------------------------
      await expect
        .poll(
          () =>
            helper<{ bot_silenced_until: string | null }>("conversation-silence", conversationId)
              .bot_silenced_until,
          { timeout: 20_000, message: "a resposta manual tem de silenciar a IA nesta conversa" },
        )
        .not.toBeNull();

      const depoisDaPausa = helper<{
        bot_silenced_until: string | null;
        last_handoff_at: string | null;
        last_handoff_reason: string | null;
      }>("conversation-silence", conversationId);
      expect(String(depoisDaPausa.last_handoff_reason)).toMatch(/manual/i);
      expect(depoisDaPausa.last_handoff_at).not.toBeNull();

      // O SILÊNCIO TEM PRAZO — não é 'infinity'. Decisão do dono do produto:
      // ninguém clicou em "assumir", então nada aqui pode calar a IA para
      // sempre. O instante gravado é finito, está no futuro, e não passa do
      // prazo (com folga para o tempo de trânsito do webhook).
      expect(String(depoisDaPausa.bot_silenced_until)).not.toMatch(/infinity/i);
      const venceEm = new Date(String(depoisDaPausa.bot_silenced_until)).getTime();
      expect(Number.isFinite(venceEm), "bot_silenced_until tem de ser um instante real").toBe(true);
      expect(venceEm).toBeGreaterThan(Date.now());
      expect(venceEm).toBeLessThanOrEqual(Date.now() + PRAZO_DO_SILENCIO_MS + 60_000);

      // A AUTORIZAÇÃO DO LEAD SOBREVIVE — pausar a conversa ≠ apagar a origem.
      const autorizacao = helper<{ ai_authorized_at: string | null; ai_authorized_reason: string | null }>(
        "contact-authorization",
        contactId,
      );
      expect(
        autorizacao.ai_authorized_at,
        "a resposta manual NÃO pode apagar ai_authorized_at — é estado separado",
      ).not.toBeNull();

      // ---------------------------------------------------------------------
      // (4) RENOVAÇÃO: a 2ª mensagem do celular empurra o prazo para frente.
      //
      // É o que "com prazo" significa na prática. Sem renovar, o relógio
      // contaria da PRIMEIRA fala e a IA voltaria a falar no meio de um
      // atendimento humano em curso — exatamente quando há uma pessoa na
      // conversa, que é o pior instante possível.
      // ---------------------------------------------------------------------
      const handoffAntes = depoisDaPausa.last_handoff_at;
      const venciaAntes = venceEm;
      expect(
        await postWaha({
          event: "message.any",
          session,
          payload: {
            id: `true_${digits}@c.us_J20REPLY2${Date.now()}`,
            to: chatId,
            fromMe: true,
            body: "Segue a tabela.",
            type: "text",
            timestamp: Math.floor(Date.now() / 1000),
          },
        }),
      ).toBe(200);
      await expect
        .poll(
          () =>
            helper<{ last_handoff_at: string | null }>("conversation-silence", conversationId)
              .last_handoff_at,
          {
            timeout: 20_000,
            message: "cada fala humana renova o prazo — o rastro tem de avançar",
          },
        )
        .not.toBe(handoffAntes);

      const depoisDaRenovacao = helper<{
        bot_silenced_until: string | null;
        last_handoff_at: string | null;
      }>("conversation-silence", conversationId);
      expect(
        new Date(String(depoisDaRenovacao.bot_silenced_until)).getTime(),
        "o vencimento conta a partir da ÚLTIMA fala humana, não da primeira",
      ).toBeGreaterThan(venciaAntes);

      // ---------------------------------------------------------------------
      // (5) A tela DIZ que uma pessoa assumiu, e oferece a volta.
      // ---------------------------------------------------------------------
      await login(page, creds.users.agent!.email);
      await page.goto(`${APP_URL}/app/inbox/${conversationId}`);
      await expect(
        page.getByTestId("badge-atendimento-humano"),
        "conversa com a IA pausada não pode ter a mesma cara de uma normal",
      ).toBeVisible({ timeout: 30_000 });
      const devolver = page.getByTestId("devolver-ao-automatico");
      await expect(devolver).toBeVisible();
      await captura(page, "18-ia-pausada-por-resposta-manual");

      // ---------------------------------------------------------------------
      // (6) A volta: solta a trava — e a autorização CONTINUA lá.
      // ---------------------------------------------------------------------
      await devolver.click();
      await expect
        .poll(
          () =>
            helper<{ bot_silenced_until: string | null }>("conversation-silence", conversationId)
              .bot_silenced_until,
          { timeout: 20_000 },
        )
        .toBeNull();
      await expect(page.getByTestId("badge-atendimento-humano")).toHaveCount(0, { timeout: 20_000 });
      await captura(page, "18-devolvido-ao-automatico");

      expect(
        helper<{ ai_authorized_at: string | null }>("contact-authorization", contactId).ai_authorized_at,
        "devolver ao automático não pode apagar a origem do lead",
      ).not.toBeNull();
    } finally {
      if (contactId) {
        try {
          helper("cleanup-contact", contactId);
        } catch (e) {
          console.error("[cleanup] falhou (não mascara o teste):", e);
        }
      }
    }
  });
});
