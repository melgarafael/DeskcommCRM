/* eslint-disable no-console */
/**
 * Wave 11 E2E QA — AI budget enforcement.
 * Run: npx tsx scripts/qa-wave-11.ts
 */
import { chromium, type BrowserContext } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any, any, any>;
import * as fs from "fs";
import * as path from "path";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

// `process.env` vence o `.env.local` (scripts/lib/env-de-teste.ts).
carregarEnvLocal();

const BASE_URL = "http://localhost:3000";
const ARTIFACTS_DIR = path.resolve(process.cwd(), "test-results/wave-11");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const creds = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), ".e2e-creds.json"), "utf8"),
);
const PASSWORD: string = creds.password;
const ADMIN_EMAIL: string = creds.users.admin.email;
const MANAGER_EMAIL: string = creds.users.manager.email;
const AGENT_EMAIL: string = creds.users.agent.email;
const ORG_ID: string = creds.org_id;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type Result = { ac: string; pass: boolean; evidence: string };
const results: Result[] = [];
const record = (ac: string, pass: boolean, evidence: string) => {
  results.push({ ac, pass, evidence });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${ac} — ${evidence}`);
};

async function login(context: BrowserContext, email: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#email").focus();
  await page.waitForTimeout(300);
  await page.locator("#email").pressSequentially(email, { delay: 25 });
  await page.locator("#password").focus();
  await page.waitForTimeout(200);
  await page.locator("#password").pressSequentially(PASSWORD, { delay: 25 });
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  try {
    await page.waitForURL(
      (url) => /\/app\b|\/login\/mfa/.test(url.toString()),
      { timeout: 20_000 },
    );
  } catch {
    /* tolerate */
  }
  await page.waitForTimeout(1200);
  console.log(`[login ${email}] final URL: ${page.url()}`);
  await page.close();
}

function todayUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

async function seedBudget(sb: SB, overrides: Record<string, unknown> = {}) {
  const base = {
    organization_id: ORG_ID,
    monthly_limit_cents: 5000,
    current_month_consumed_cents: 0,
    alarm_threshold_pct: 80,
    action_at_100pct: "throttle",
    is_throttled: false,
    is_disabled: false,
    current_period_start: todayUtcDay(),
    last_alarm_sent_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  const { error } = await sb.from("ai_budgets").upsert(base as never, {
    onConflict: "organization_id",
  });
  if (error) throw new Error(`seedBudget failed: ${error.message}`);
}

async function readBudget(sb: SB) {
  const { data, error } = await sb
    .from("ai_budgets")
    .select("*")
    .eq("organization_id", ORG_ID)
    .maybeSingle();
  if (error) throw new Error(`readBudget failed: ${error.message}`);
  return data as Record<string, unknown> | null;
}

async function main() {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ---- Setup: ensure budget row exists ----
  await seedBudget(sb);
  const initial = await readBudget(sb);
  console.log(`[setup] initial ai_budgets row: ${JSON.stringify(initial)}`);

  // Sanity: verify upsert with same org_id is idempotent (PK/UQ on org_id).
  let pkOk = "unknown";
  try {
    const { error: dupErr } = await sb
      .from("ai_budgets")
      .insert({ organization_id: ORG_ID, monthly_limit_cents: 1 } as never);
    if (dupErr && (dupErr.code === "23505" || /duplicate|unique/i.test(dupErr.message))) {
      pkOk = "yes (duplicate insert rejected)";
    } else if (dupErr) {
      pkOk = `rejected: ${dupErr.message}`;
    } else {
      pkOk = "no — duplicate insert succeeded (NO PK/UQ on org_id)";
    }
  } catch (e) {
    pkOk = `error: ${(e as Error).message}`;
  }
  console.log(`[setup] PK/UQ on organization_id: ${pkOk}`);

  // Reset after the dup test
  await seedBudget(sb);

  // ---- Cleanup any prior wave-11 events ----
  await sb
    .from("event_log")
    .delete()
    .eq("organization_id", ORG_ID)
    // `ai.budget_throttled` e `ai.budget_reset` perderam o único emissor com os
    // dois crons apagados — limpar por eles é limpar o que ninguém escreve.
    .in("event_type", ["ai.budget_warning"]);

  const browser = await chromium.launch({ headless: true });

  // ============== ADMIN session ==============
  const adminCtx = await browser.newContext({ baseURL: BASE_URL });
  await login(adminCtx, ADMIN_EMAIL);
  const adminApi = adminCtx.request;

  // AC-API-1 needs manager — skip here, do later. Use admin for AC-API-3, AC-API-4 (negative w/ manager later), AC-API-5, AC-API-6.

  // AC-API-3 (PATCH admin)
  try {
    const resp = await adminApi.patch(`${BASE_URL}/api/v1/ai/budget`, {
      data: { monthly_limit_cents: 10000 },
      headers: { "content-type": "application/json" },
    });
    const body = (await resp.json().catch(() => null)) as
      | { data?: { monthly_limit_cents: number } }
      | null;
    const dbRow = await readBudget(sb);
    const dbVal = Number(dbRow?.monthly_limit_cents);
    const pass =
      resp.status() === 200 &&
      body?.data?.monthly_limit_cents === 10000 &&
      dbVal === 10000;
    record(
      "AC-API-3 (PATCH admin updates limit)",
      pass,
      `HTTP ${resp.status()} body.limit=${body?.data?.monthly_limit_cents} db.limit=${dbVal}`,
    );
  } catch (e) {
    record("AC-API-3 (PATCH admin updates limit)", false, `error: ${(e as Error).message}`);
  }

  // AC-API-5 (PATCH Zod 422 — alarm_threshold_pct=150)
  try {
    const resp = await adminApi.patch(`${BASE_URL}/api/v1/ai/budget`, {
      data: { alarm_threshold_pct: 150 },
      headers: { "content-type": "application/json" },
    });
    const text = await resp.text();
    // route uses 'validation_error' code (lib/api/errors uses 'validation_failed' as constant, but route literal is 'validation_error')
    const ok = resp.status() === 422 && /validation_(error|failed)/.test(text);
    record(
      "AC-API-5 (PATCH Zod 422)",
      ok,
      `HTTP ${resp.status()} body=${text.slice(0, 180)}`,
    );
  } catch (e) {
    record("AC-API-5 (PATCH Zod 422)", false, `error: ${(e as Error).message}`);
  }

  // AC-API-6 (RLS — admin can only mutate own org). The session JWT already
  // scopes activeOrg to ORG_ID; verify by patching limit and ensuring no
  // other org row was touched. We look at the count of rows with limit==12345.
  try {
    await adminApi.patch(`${BASE_URL}/api/v1/ai/budget`, {
      data: { monthly_limit_cents: 12345 },
      headers: { "content-type": "application/json" },
    });
    const { data: matches } = await sb
      .from("ai_budgets")
      .select("organization_id")
      .eq("monthly_limit_cents", 12345);
    const allMine = (matches ?? []).every(
      (r) => (r as { organization_id: string }).organization_id === ORG_ID,
    );
    const onlyOne = (matches ?? []).length === 1;
    record(
      "AC-API-6 (PATCH only touches own org)",
      allMine && onlyOne,
      `rows_with_limit=12345 matches=${matches?.length} all_in_e2e_org=${allMine}`,
    );
  } catch (e) {
    record("AC-API-6 (PATCH only touches own org)", false, `error: ${(e as Error).message}`);
  }

  // ============== MANAGER session ==============
  const mgrCtx = await browser.newContext({ baseURL: BASE_URL });
  await login(mgrCtx, MANAGER_EMAIL);
  const mgrApi = mgrCtx.request;

  // AC-API-1 (GET manager+) — need a known state; reset row first.
  await seedBudget(sb, { monthly_limit_cents: 5000, current_month_consumed_cents: 0 });
  try {
    const resp = await mgrApi.get(`${BASE_URL}/api/v1/ai/budget`);
    const body = (await resp.json().catch(() => null)) as
      | { data?: Record<string, unknown> }
      | null;
    const d = body?.data;
    const singleWrap = !!d && !("data" in (d as object));
    // O contrato do GET mudou com a 0159: `is_throttled`/`is_disabled` perderam o
    // escritor (o cron morto) e saíram do tipo, e `action_at_100pct` saiu porque
    // o produto nunca distinguiu "pausar" de "desabilitar". Exigi-los aqui fazia
    // o caso reprovar por defeito DO INSTRUMENTO. No lugar entram os quatro
    // campos que a tela passou a consumir de verdade.
    const requiredFields = [
      "organization_id",
      "monthly_limit_cents",
      "current_month_consumed_cents",
      "pct",
      "alarm_threshold_pct",
      "enforcement_mode",
      "enforcement_effective_at",
      "enforcement_env",
      "blocked_now",
      "gasto_incompleto",
      "current_period_start",
      "last_alarm_sent_at",
      "updated_at",
    ];
    const missing = requiredFields.filter((k) => !(d && k in (d as object)));
    const limitOk = d?.monthly_limit_cents === 5000;
    // ⚠️ O GASTO NÃO VEM MAIS DA COLUNA SEMEADA. Ele vem de
    // `fn_gasto_de_ia_do_mes`, que soma `llm_calls` do mês corrente — semear
    // `current_month_consumed_cents: 0` deixou de ter efeito sobre a resposta.
    // Por isso a asserção passou a ser sobre a FORMA (número não-negativo e um
    // `pct` coerente com o teto), não sobre o valor que este script escreveu.
    const consumido = Number(d?.current_month_consumed_cents ?? Number.NaN);
    const consumedOk = Number.isFinite(consumido) && consumido >= 0;
    const pctOk = d?.pct === Math.round((consumido * 10000) / 5000) / 100;
    const pass =
      resp.status() === 200 &&
      singleWrap &&
      missing.length === 0 &&
      limitOk &&
      consumedOk &&
      pctOk;
    record(
      "AC-API-1 (GET manager+)",
      pass,
      `HTTP ${resp.status()} singleWrap=${singleWrap} missing=[${missing.join(",")}] limit=${d?.monthly_limit_cents} consumed=${d?.current_month_consumed_cents} pct=${d?.pct}`,
    );
  } catch (e) {
    record("AC-API-1 (GET manager+)", false, `error: ${(e as Error).message}`);
  }

  // AC-API-4 (PATCH role gate — manager forbidden)
  try {
    const resp = await mgrApi.patch(`${BASE_URL}/api/v1/ai/budget`, {
      data: { monthly_limit_cents: 999 },
      headers: { "content-type": "application/json" },
    });
    const text = await resp.text();
    const ok = resp.status() === 403 && /forbidden_role/.test(text);
    record(
      "AC-API-4 (PATCH manager 403)",
      ok,
      `HTTP ${resp.status()} body=${text.slice(0, 160)}`,
    );
  } catch (e) {
    record("AC-API-4 (PATCH manager 403)", false, `error: ${(e as Error).message}`);
  }

  // AC-UI-1 (BudgetCard renders for manager)
  // Set known state for evidence: limit=10000 (R$100), consumed=5000 (R$50)
  await seedBudget(sb, {
    monthly_limit_cents: 10000,
    current_month_consumed_cents: 5000,
  });
  try {
    const page = await mgrCtx.newPage();
    await page.goto(`${BASE_URL}/app/ai/usage`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const shot = path.join(ARTIFACTS_DIR, "ac-ui-1-manager-budget.png");
    await page.screenshot({ path: shot, fullPage: true });
    const text = await page.locator("body").innerText();
    const hasOrcamento = /Or[çc]amento mensal de IA/i.test(text);
    // Format: R$ 50,00 de R$ 100,00
    const hasAmounts = /R\$\s*50,00/.test(text) && /R\$\s*100,00/.test(text);
    const pass = hasOrcamento && hasAmounts;
    record(
      "AC-UI-1 (BudgetCard renders)",
      pass,
      `orcamento=${hasOrcamento} amounts=${hasAmounts} shot=${shot}`,
    );

    // AC-UI-3 (manager hides Edit button)
    const editBtnCount = await page.getByRole("button", { name: /Editar limite/i }).count();
    record(
      "AC-UI-3 (manager hides Editar limite)",
      editBtnCount === 0,
      `editar_limite_buttons=${editBtnCount}`,
    );
    await page.close();
  } catch (e) {
    record("AC-UI-1 (BudgetCard renders)", false, `error: ${(e as Error).message}`);
    record("AC-UI-3 (manager hides Editar limite)", false, `error: ${(e as Error).message}`);
  }

  await mgrCtx.close();

  // ============== AGENT session — AC-API-2 ==============
  const agentCtx = await browser.newContext({ baseURL: BASE_URL });
  await login(agentCtx, AGENT_EMAIL);
  try {
    const resp = await agentCtx.request.get(`${BASE_URL}/api/v1/ai/budget`);
    const text = await resp.text();
    const ok = resp.status() === 403 && /forbidden_role/.test(text);
    record(
      "AC-API-2 (GET agent 403)",
      ok,
      `HTTP ${resp.status()} body=${text.slice(0, 160)}`,
    );
  } catch (e) {
    record("AC-API-2 (GET agent 403)", false, `error: ${(e as Error).message}`);
  }
  await agentCtx.close();

  // ============== ADMIN UI: AC-UI-2, AC-UI-4 ==============
  try {
    const page = await adminCtx.newPage();
    await page.goto(`${BASE_URL}/app/ai/usage`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const shot = path.join(ARTIFACTS_DIR, "ac-ui-2-admin-budget.png");
    await page.screenshot({ path: shot, fullPage: true });

    const editBtn = page.getByRole("button", { name: /Editar limite/i });
    const editCount = await editBtn.count();
    record(
      "AC-UI-2 (admin sees Editar limite)",
      editCount >= 1,
      `editar_limite_buttons=${editCount} shot=${shot}`,
    );

    if (editCount >= 1) {
      await editBtn.first().click();
      await page.waitForTimeout(900);
      const dialogVisible = await page
        .getByRole("dialog")
        .getByText(/Editar orçamento de IA/i)
        .isVisible()
        .catch(() => false);
      const hasLimitField = (await page.locator("#limit-brl").count()) > 0;
      const hasThresholdField = (await page.locator("#threshold-pct").count()) > 0;
      // Action select: shadcn Select trigger has role combobox
      const hasActionSelect = (await page.getByRole("combobox").count()) > 0;
      const dialogShot = path.join(ARTIFACTS_DIR, "ac-ui-4-edit-dialog.png");
      await page.screenshot({ path: dialogShot, fullPage: true });
      const pass = dialogVisible && hasLimitField && hasThresholdField && hasActionSelect;
      record(
        "AC-UI-4 (Edit dialog opens with fields)",
        pass,
        `dialog=${dialogVisible} limit_field=${hasLimitField} threshold_field=${hasThresholdField} action_select=${hasActionSelect} shot=${dialogShot}`,
      );
    } else {
      record("AC-UI-4 (Edit dialog opens with fields)", false, "edit button not found");
    }
    await page.close();
  } catch (e) {
    record("AC-UI-2 (admin sees Editar limite)", false, `error: ${(e as Error).message}`);
    record("AC-UI-4 (Edit dialog opens with fields)", false, `error: ${(e as Error).message}`);
  }

  await adminCtx.close();
  await browser.close();

  // ============== WORKER tests ==============
  // AC-WORKER-1/2/3 SAÍRAM junto com os workers que exercitavam:
  // `workers/ai-budget-checker.cron.ts` e `workers/ai-budget-reset.cron.ts`
  // foram apagados — nenhum dos dois teve agendador algum dia (nada em
  // `docker/scheduler/entrypoint.sh`, nenhuma rota em `app/api/v1/cron/`), e o
  // que eles escreviam (`is_throttled`/`is_disabled`) deixou de ter leitor.
  // Quem aplica o teto hoje é `aplicarOrcamento` (seam do engine) e
  // `vetoPorTetoDeGasto` (caminho legado do ai-response-worker); a prova deles
  // são `tests/unit/orcamento-*.test.ts` e o passo 6 de `scripts/smoke-llm.ts`.

  // AC-IA-10 (handoff guard inspection — source review)
  try {
    const workerSrc = fs.readFileSync(
      path.resolve(process.cwd(), "workers/ai-response-worker.ts"),
      "utf8",
    );
    const lines = workerSrc.split("\n");
    let guardLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/skip\("budget_exceeded"\)/.test(lines[i]!)) {
        guardLine = i + 1;
        break;
      }
    }
    // Verify handoff orchestrator does NOT reference ai_budgets / is_throttled.
    const handoffSrc = fs.readFileSync(
      path.resolve(process.cwd(), "lib/ai/handoff/orchestrator.ts"),
      "utf8",
    );
    const triggersSrc = fs.readFileSync(
      path.resolve(process.cwd(), "lib/ai/handoff/triggers.ts"),
      "utf8",
    );
    const sentimentHandlerSrc = fs.readFileSync(
      path.resolve(process.cwd(), "workers/ai-handoff-from-sentiment.handler.ts"),
      "utf8",
    );
    const handoffMentionsBudget =
      /ai_budgets|is_throttled|is_disabled|isBudgetExhausted/.test(
        handoffSrc + triggersSrc + sentimentHandlerSrc,
      );

    const pass = guardLine > 0 && !handoffMentionsBudget;
    record(
      "AC-IA-10 (bot guard short-circuits, handoff independent)",
      pass,
      `guard_line=workers/ai-response-worker.ts:${guardLine} handoff_independent=${!handoffMentionsBudget}`,
    );
  } catch (e) {
    record("AC-IA-10 (bot guard short-circuits, handoff independent)", false, `error: ${(e as Error).message}`);
  }

  // ============== Cleanup ==============
  try {
    await seedBudget(sb, {
      monthly_limit_cents: 5000,
      current_month_consumed_cents: 0,
      alarm_threshold_pct: 80,
      action_at_100pct: "throttle",
      is_throttled: false,
      is_disabled: false,
      last_alarm_sent_at: null,
      current_period_start: todayUtcDay(),
    });
    await sb
      .from("event_log")
      .delete()
      .eq("organization_id", ORG_ID)
      .in("event_type", ["ai.budget_warning"]);
    console.log("[cleanup] reset budget + removed seeded events");
  } catch (e) {
    console.log(`[cleanup] error: ${(e as Error).message}`);
  }

  // ---- Final report ----
  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE_URL,
    setup: {
      pk_or_uq_on_organization_id: pkOk,
      initial_budget: initial,
    },
    results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
    },
  };
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(report.summary, null, 2));
  process.exit(report.summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
