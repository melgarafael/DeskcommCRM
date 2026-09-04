/**
 * J20.12 — O FOLLOW-UP AUTOMÁTICO RESPEITA O GATE.
 *
 * Num canal com o gate LIGADO (`channel_sessions.metadata.ai_gate='allowlist'`),
 * a varredura de silêncio (`lib/followup/silence-sweep.ts`, dentro do cron
 * `followup-flow-worker`) só inscreve um contato silencioso se ele estiver
 * AUTORIZADO — `loadSilentContactIds` pula `gateAllowlist && !autorizado`. Um
 * cliente atual que nunca passou por origem elegível NÃO é enrolado: a IA não
 * "enrola" quem ela não deveria atender.
 *
 * O que este spec prova, e por qual observável:
 *   - contato silencioso AUTORIZADO      → nasce linha em `followup_enrollments`
 *   - contato silencioso NÃO autorizado  → NENHUM enrollment (mesmo silêncio, mesmo canal)
 *
 * Tudo pela API REAL depois do login (mesmo caminho de produção que
 * followup-journey.spec.ts): cria o fluxo, publica, vincula a um agente
 * publicado com follow-up habilitado, e roda o cron de verdade.
 *
 * Pré-requisitos (banco local estilo VPS, app buildada):
 *   npx tsx scripts/seed-e2e-credentials.ts
 *   npx tsx scripts/seed-e2e-elegibilidade.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3001 pnpm exec playwright test tests/e2e/j20-elegibilidade-followup.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

const THRESHOLD_MIN = 5;

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
  elegibilidade?: { channel_session_id: string; credential_id: string };
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

function internalSecret(): string {
  const s = carregarEnvLocal().INTERNAL_SECRET?.trim();
  if (!s) throw new Error("INTERNAL_SECRET ausente no ambiente (.env.e2e / .env.local)");
  return s;
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

/** Grafo mínimo publicável: trigger → wait(5min) → ação(ai_message) → fim.
 *  Espelha a fixture verde de `lib/followup/validate-publish.test.ts`. */
function grafoMinimo(): unknown {
  const pos = (y: number) => ({ x: 0, y });
  return {
    nodes: [
      { id: "t1", type: "trigger", label: "Início", position: pos(0), config: {} },
      { id: "w1", type: "wait", label: "Espera", position: pos(120), config: { mode: "fixed", duration_ms: 300_000 } },
      {
        id: "a1",
        type: "action",
        label: "Mensagem",
        position: pos(240),
        config: { mode: "ai_message", prompt_hint: "Pergunte com simpatia se ainda há interesse." },
      },
      { id: "end1", type: "end", label: "Fim", position: pos(360), config: { outcome: "exhausted" } },
    ],
    edges: [
      { id: "edge1", source: "t1", target: "w1", priority: 0, condition: { type: "always" } },
      { id: "edge2", source: "w1", target: "a1", priority: 0, condition: { type: "always" } },
      { id: "edge3", source: "a1", target: "end1", priority: 0, condition: { type: "always" } },
    ],
  };
}

async function publicarFluxoDeSilencio(page: Page): Promise<string> {
  const criar = await page.request.post(`${APP_URL}/api/v1/ai/followup-flows`, {
    data: { name: `E2E Silêncio Elegibilidade ${Date.now()}` },
  });
  expect(criar.status(), await criar.text()).toBe(201);
  const pointerId = ((await criar.json()) as { data: { id: string } }).data.id;

  const patch = await page.request.patch(`${APP_URL}/api/v1/ai/followup-flows/${pointerId}`, {
    data: {
      draft_graph: grafoMinimo(),
      trigger_config: { kind: "silence", params: { threshold_minutes: THRESHOLD_MIN } },
    },
  });
  expect(patch.status(), await patch.text()).toBe(200);

  const publicar = await page.request.post(`${APP_URL}/api/v1/ai/followup-flows/${pointerId}/publish`);
  expect(publicar.status(), await publicar.text()).toBe(200);
  return pointerId;
}

async function rodarCronDeFollowup(): Promise<void> {
  const res = await fetch(`${APP_URL}/api/v1/cron/followup-flow-worker`, {
    method: "POST",
    headers: { Authorization: `Bearer ${internalSecret()}` },
  });
  expect(res.ok, `cron followup-flow-worker: ${res.status}`).toBeTruthy();
}

test.describe("J20.12 — o follow-up automático respeita o gate", () => {
  test.describe.configure({ timeout: 240_000 });
  test.use({ actionTimeout: 15_000 });

  test.beforeAll(() => {
    seedBase();
  });

  test("silencioso autorizado → enrola; silencioso NÃO autorizado → não enrola", async ({ page }) => {
    let pointerId = "";
    let agentId = "";
    let autorizadoId = "";
    let semAutorizacaoId = "";

    try {
      await login(page, creds.users.manager!.email);

      // (1) Fluxo de silêncio publicado (API real) + agente publicado que o ARMA.
      // O agente é SETUP via helper (o `POST /api/v1/ai/agents` exige role
      // `admin`/MFA; o que está sob teste é a varredura, não a criação do agente).
      pointerId = await publicarFluxoDeSilencio(page);
      agentId = helper<{ agentId: string }>("publish-agent", pointerId).agentId;

      // (2) Dois contatos silenciosos no MESMO canal com gate — um de cada lado.
      const a = helper<{ contactId: string }>("seed-silent-contact", "1", String(THRESHOLD_MIN));
      const b = helper<{ contactId: string }>("seed-silent-contact", "0", String(THRESHOLD_MIN));
      autorizadoId = a.contactId;
      semAutorizacaoId = b.contactId;

      // (3) Roda o cron de verdade — a varredura de silêncio decide quem entra.
      for (let i = 0; i < 3; i++) {
        await rodarCronDeFollowup();
        await page.waitForTimeout(800);
      }

      // (4) O autorizado ENTROU; o não autorizado NÃO — mesmo silêncio, mesmo canal.
      await expect
        .poll(() => helper<{ id: string } | null>("enrollment-for-contact", autorizadoId), {
          timeout: 20_000,
          message: "contato silencioso AUTORIZADO tem de ser enrolado pela varredura",
        })
        .not.toBeNull();

      expect(
        helper<{ id: string } | null>("enrollment-for-contact", semAutorizacaoId),
        "contato silencioso NÃO autorizado, no canal com gate: a varredura NÃO enrola",
      ).toBeNull();
    } finally {
      for (const id of [autorizadoId, semAutorizacaoId]) {
        if (id) {
          try {
            helper("cleanup-contact", id);
          } catch (e) {
            console.error("[cleanup] contato falhou:", e);
          }
        }
      }
      if (pointerId) {
        try {
          helper("cleanup-flow", pointerId);
        } catch (e) {
          console.error("[cleanup] cleanup-flow falhou:", e);
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
