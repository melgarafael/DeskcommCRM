/**
 * G5-03 — Fila visível com posição + atribuição (acceptance 4, e2e smoke).
 *
 * Fluxo: conversa entra (sem dono) → aparece na Fila com posição + "aguardando
 * há X" → o worker atribui (aqui simulado via fn_conversation_assign(reason=
 * 'routing') com service role — o cron do worker não roda no e2e local) → a
 * conversa some da Fila e aparece em "Minhas" do dono.
 *
 * Pré-requisito: scripts/seed-e2e-credentials.ts + scripts/seed-e2e-queue.ts
 * (o beforeAll re-roda o queue seed para restaurar o estado de fila).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCE = path.join(process.cwd(), "loop/checkpoints/evidence/G5");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  queue?: {
    conversation_id: string;
    contact_name: string;
    agent_user_id: string;
  };
  supabase_url: string;
}

function loadEnv(): Record<string, string> {
  const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  const env: Record<string, string> = {};
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return env;
}

const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

test.describe("G5-03 — fila com posição + atribuição", () => {
  // Dev server compila /app/* a frio na 1ª visita (pode passar de 30s).
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    // Restaura o estado de fila (idempotente) antes do fluxo.
    execFileSync("npx", ["tsx", "scripts/seed-e2e-queue.ts"], { stdio: "inherit" });
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    if (!creds.queue) throw new Error("queue seed block ausente em .e2e-creds.json");
  });

  test("conversa aparece na Fila com posição → worker atribui → move para Minhas", async ({
    page,
  }) => {
    const q = creds.queue!;
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto("/app/inbox?filter=unassigned");

    // (1) Na Fila: a conversa aparece com posição (Nº) + "Aguardando há X".
    const queueItem = page.getByRole("button").filter({ hasText: q.contact_name });
    await expect(queueItem).toBeVisible({ timeout: 15_000 });
    await expect(queueItem.getByText(/^\d+º$/)).toBeVisible();
    await expect(queueItem.getByText(/Aguardando/)).toBeVisible();
    await page.screenshot({
      path: path.join(EVIDENCE, "G5-03-queue.png"),
      fullPage: true,
    });

    // (2) Worker atribui (fn_conversation_assign reason='routing') ao próprio agent.
    const { error } = await admin.rpc("fn_conversation_assign", {
      p_organization_id: creds.org_id,
      p_conversation_id: q.conversation_id,
      p_to_user_id: q.agent_user_id,
      p_reason: "routing",
      p_expected_assignee: null,
      p_enforce_expected: false,
    });
    if (error) throw new Error(`fn_conversation_assign: ${error.message}`);

    // (3) Some da Fila.
    await page.reload();
    await page.goto("/app/inbox?filter=unassigned");
    await expect(
      page.getByRole("button").filter({ hasText: q.contact_name }),
    ).toHaveCount(0, { timeout: 15_000 });

    // (4) Aparece em "Minhas" do dono.
    await page.getByRole("tab", { name: /Minhas/ }).click();
    await expect(
      page.getByRole("button").filter({ hasText: q.contact_name }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
