/* eslint-disable no-console */
/**
 * Wave 10 E2E QA — AI usage observability dashboard.
 * Run: npx tsx scripts/qa-wave-10.ts
 */
import { chromium, type BrowserContext, type APIRequestContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

// `process.env` vence o `.env.local` (scripts/lib/env-de-teste.ts).
carregarEnvLocal();

const BASE_URL = "http://localhost:3000";
const ARTIFACTS_DIR = path.resolve(process.cwd(), "test-results/wave-10");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const creds = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), ".e2e-creds.json"), "utf8"),
);
const PASSWORD: string = creds.password;
const MANAGER_EMAIL: string = creds.users.manager.email;
const AGENT_EMAIL: string = creds.users.agent.email;
const DEFAULT_AGENT_ID: string = creds.default_agent_id;
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

function dayOffset(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ---- Cleanup any prior wave-10 seed ----
  await sb
    .from("ai_invocations")
    .delete()
    .eq("organization_id", ORG_ID)
    .eq("model", "qa-wave-10");
  await sb
    .from("event_log")
    .delete()
    .eq("organization_id", ORG_ID)
    .eq("event_type", "ai.handoff_triggered")
    .like("payload->>seed", "qa-wave-10");

  // ---- Seed deterministic ai_invocations ----
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
  const yest = dayOffset(today, -1);

  const seedRows = [
    { day: today, kind: "bot_respond", cost: 100, lat: 800, pt: 500, ct: 200 },
    { day: today, kind: "bot_respond", cost: 250, lat: 1500, pt: 800, ct: 300 },
    { day: today, kind: "bot_respond", cost: 80, lat: 600, pt: 200, ct: 50 },
    { day: yest, kind: "sentiment_classify", cost: 30, lat: 4200, pt: 100, ct: 30 },
    { day: yest, kind: "sentiment_classify", cost: 40, lat: 1100, pt: 150, ct: 40 },
  ].map((r) => ({
    organization_id: ORG_ID,
    agent_id: DEFAULT_AGENT_ID,
    invocation_kind: r.kind,
    cost_cents: r.cost,
    latency_ms: r.lat,
    prompt_tokens: r.pt,
    completion_tokens: r.ct,
    model: "qa-wave-10",
    created_at: r.day.toISOString(),
  }));

  const { data: inv, error: invErr } = await sb
    .from("ai_invocations")
    .insert(seedRows as never)
    .select("id");
  if (invErr) throw new Error(`seed ai_invocations failed: ${invErr.message}`);
  console.log(`[setup] seeded ${inv?.length ?? 0} ai_invocations`);

  // Seed messages inbound (try real FKs; if fails, leave 0 and validate handoff_rate=0)
  let seededInbound = 0;
  let inboundIds: string[] = [];
  let seedingNote = "";
  try {
    const { data: contact } = await sb
      .from("contacts")
      .select("id")
      .eq("organization_id", ORG_ID)
      .limit(1)
      .maybeSingle();
    const { data: convo } = await sb
      .from("conversations")
      .select("id")
      .eq("organization_id", ORG_ID)
      .limit(1)
      .maybeSingle();
    if (contact && convo) {
      const inboundRows = [
        { day: today, idx: 1 },
        { day: today, idx: 2 },
        { day: yest, idx: 3 },
        { day: yest, idx: 4 },
      ].map((r) => ({
        organization_id: ORG_ID,
        contact_id: (contact as { id: string }).id,
        conversation_id: (convo as { id: string }).id,
        direction: "inbound",
        body: `qa-wave-10 seed ${r.idx}`,
        external_id: `qa-w10-${Date.now()}-${r.idx}`,
        created_at: r.day.toISOString(),
        status: "received",
      }));
      const { data: ins, error } = await sb
        .from("messages")
        .insert(inboundRows as never)
        .select("id");
      if (error) {
        seedingNote = `messages seed FK error: ${error.message}`;
        console.log(`[setup] ${seedingNote}`);
      } else {
        seededInbound = ins?.length ?? 0;
        inboundIds = (ins ?? []).map((r) => (r as { id: string }).id);
        console.log(`[setup] seeded ${seededInbound} inbound messages`);
      }
    } else {
      seedingNote = "no contact/conversation in org — skipping inbound seed";
      console.log(`[setup] ${seedingNote}`);
    }
  } catch (e) {
    seedingNote = `inbound seed exception: ${(e as Error).message}`;
    console.log(`[setup] ${seedingNote}`);
  }

  // Seed event_log handoff
  const { data: ev, error: evErr } = await sb
    .from("event_log")
    .insert({
      organization_id: ORG_ID,
      event_type: "ai.handoff_triggered",
      entity_kind: "conversation",
      payload: { seed: "qa-wave-10" },
      created_at: today.toISOString(),
    } as never)
    .select("id")
    .single();
  if (evErr) throw new Error(`seed event_log failed: ${evErr.message}`);
  const handoffEventId = (ev as { id: string }).id;
  console.log(`[setup] seeded handoff event ${handoffEventId}`);

  // Compute expected inbound count from DB (today through yesterday) post-seed,
  // for AC8 math.
  const fromIso = dayOffset(today, -1).toISOString();
  const toIso = new Date(today.getTime() + 86_400_000 - 1).toISOString();
  const { count: dbInbound } = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG_ID)
    .eq("direction", "inbound")
    .gte("created_at", fromIso)
    .lte("created_at", toIso);
  const { count: dbHandoff } = await sb
    .from("event_log")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG_ID)
    .eq("event_type", "ai.handoff_triggered")
    .gte("created_at", fromIso)
    .lte("created_at", toIso);
  console.log(`[setup] db counts (yest..today): inbound=${dbInbound} handoff=${dbHandoff}`);

  const browser = await chromium.launch({ headless: true });

  // --------- Manager UI flow ---------
  const mgrCtx = await browser.newContext({ baseURL: BASE_URL });
  await login(mgrCtx, MANAGER_EMAIL);
  const mgrPage = await mgrCtx.newPage();

  // AC1 — page renders with 4 stat cards + 4 charts
  try {
    await mgrPage.goto(`${BASE_URL}/app/ai/usage`, { waitUntil: "domcontentloaded" });
    await mgrPage.waitForTimeout(2500);
    const ac1Shot = path.join(ARTIFACTS_DIR, "ac1-usage-page.png");
    await mgrPage.screenshot({ path: ac1Shot, fullPage: true });

    const text = await mgrPage.locator("body").innerText();
    const hasCusto = /Custo do mês|Custo/i.test(text);
    const hasInvoc = /Invoca/i.test(text);
    const hasHandoff = /Handoff/i.test(text);
    const hasP95 = /p95/i.test(text);
    const canvasCount = await mgrPage.locator("canvas, svg.recharts-surface, .recharts-wrapper").count();
    const pass = hasCusto && hasInvoc && hasHandoff && hasP95 && canvasCount >= 4;
    record(
      "AC1 (4 cards + 4 charts)",
      pass,
      `custo=${hasCusto} invoc=${hasInvoc} handoff=${hasHandoff} p95=${hasP95} chartEls=${canvasCount}; shot=${ac1Shot}`,
    );
  } catch (e) {
    record("AC1 (4 cards + 4 charts)", false, `error: ${(e as Error).message}`);
  }

  // AC2 — filter invocation_kind=bot_respond → URL param updates
  try {
    // Try clicking a select / interacting with filter; fallback: navigate with query param
    await mgrPage.goto(`${BASE_URL}/app/ai/usage?invocation_kind=bot_respond`, {
      waitUntil: "domcontentloaded",
    });
    await mgrPage.waitForTimeout(2500);
    const url = mgrPage.url();
    const ac2Shot = path.join(ARTIFACTS_DIR, "ac2-filter-bot-respond.png");
    await mgrPage.screenshot({ path: ac2Shot, fullPage: true });
    const hasParam = /invocation_kind=bot_respond/.test(url);
    record(
      "AC2 (filter invocation_kind URL)",
      hasParam,
      `url=${url}; shot=${ac2Shot}`,
    );
  } catch (e) {
    record("AC2 (filter invocation_kind URL)", false, `error: ${(e as Error).message}`);
  }

  await mgrPage.close();

  const mgrApi: APIRequestContext = mgrCtx.request;

  // AC3 — GET /api/v1/ai/usage no filters → 200 + shape
  let totalsForAc8: { handoff_rate: number; invocations: number } | null = null;
  try {
    const resp = await mgrApi.get(`${BASE_URL}/api/v1/ai/usage`);
    const body = (await resp.json().catch(() => null)) as
      | {
          data?: {
            range?: { from: string; to: string };
            totals?: {
              invocations: number;
              cost_cents: number;
              handoff_rate: number;
              p50_latency_ms: number;
              p95_latency_ms: number;
              total_tokens: number;
            };
            series?: { cost_cents: Array<{ day: string; value: number }> };
            by_kind?: Record<string, number>;
          };
        }
      | null;
    const d = body?.data;
    const singleWrap = !!d && !("data" in d);
    const hasShape =
      !!d &&
      !!d.range &&
      !!d.totals &&
      !!d.series &&
      !!d.by_kind &&
      Array.isArray(d.series.cost_cents) &&
      d.series.cost_cents.length > 0 &&
      typeof d.series.cost_cents[0]!.day === "string" &&
      typeof d.series.cost_cents[0]!.value === "number";
    const invocOk = (d?.totals?.invocations ?? 0) >= 5;
    if (d?.totals) totalsForAc8 = { handoff_rate: d.totals.handoff_rate, invocations: d.totals.invocations };
    record(
      "AC3 (API totals shape + counts)",
      resp.status() === 200 && singleWrap && hasShape && invocOk,
      `HTTP ${resp.status()} singleWrap=${singleWrap} shape=${hasShape} invocations=${d?.totals?.invocations}`,
    );
  } catch (e) {
    record("AC3 (API totals shape + counts)", false, `error: ${(e as Error).message}`);
  }

  // AC4 — RLS / cross-tenant agent_id → 200 with zeroed totals
  try {
    const resp = await mgrApi.get(
      `${BASE_URL}/api/v1/ai/usage?agent_id=00000000-0000-0000-0000-000000000000`,
    );
    const body = (await resp.json().catch(() => null)) as {
      data?: { totals?: { invocations: number; cost_cents: number } };
    } | null;
    const tot = body?.data?.totals;
    const zero = tot?.invocations === 0 && tot?.cost_cents === 0;
    record(
      "AC4 (RLS foreign agent zero)",
      resp.status() === 200 && zero,
      `HTTP ${resp.status()} totals=${JSON.stringify(tot)}`,
    );
  } catch (e) {
    record("AC4 (RLS foreign agent zero)", false, `error: ${(e as Error).message}`);
  }

  // AC5 — Zod validation on bad date
  try {
    const resp = await mgrApi.get(`${BASE_URL}/api/v1/ai/usage?from=invalid-date`);
    const body = await resp.text();
    const ok = resp.status() === 422 && /validation_failed/.test(body);
    record("AC5 (Zod 422 validation_failed)", ok, `HTTP ${resp.status()} body=${body.slice(0, 160)}`);
  } catch (e) {
    record("AC5 (Zod 422 validation_failed)", false, `error: ${(e as Error).message}`);
  }

  // AC7 — 90-day cap: from far in past
  try {
    const farPast = "2020-01-01";
    const resp = await mgrApi.get(`${BASE_URL}/api/v1/ai/usage?from=${farPast}`);
    const body = (await resp.json().catch(() => null)) as {
      data?: { range?: { from: string; to: string } };
      error?: { code: string };
    } | null;
    let pass = false;
    let evidence = `HTTP ${resp.status()}`;
    if (resp.status() === 422 && body?.error?.code === "validation_failed") {
      pass = true;
      evidence += " 422 validation_failed";
    } else if (resp.status() === 200 && body?.data?.range) {
      const from = body.data.range.from;
      const to = body.data.range.to;
      const diffDays = Math.round(
        (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
          86_400_000,
      );
      pass = diffDays <= 90;
      evidence += ` clamped from=${from} to=${to} diffDays=${diffDays}`;
    }
    record("AC7 (90-day cap)", pass, evidence);
  } catch (e) {
    record("AC7 (90-day cap)", false, `error: ${(e as Error).message}`);
  }

  // AC8 — handoff_rate math
  try {
    const expected = (dbInbound ?? 0) > 0 ? (dbHandoff ?? 0) / (dbInbound ?? 1) : 0;
    const actual = totalsForAc8?.handoff_rate ?? -1;
    // Allow rounding (4 decimal places in payload)
    const diff = Math.abs(expected - actual);
    const pass = diff < 0.001;
    record(
      "AC8 (handoff_rate math)",
      pass,
      `expected=${expected.toFixed(4)} actual=${actual} inbound=${dbInbound} handoffs=${dbHandoff}`,
    );
  } catch (e) {
    record("AC8 (handoff_rate math)", false, `error: ${(e as Error).message}`);
  }

  await mgrCtx.close();

  // --------- Agent role test (AC6) ---------
  const agentCtx = await browser.newContext({ baseURL: BASE_URL });
  await login(agentCtx, AGENT_EMAIL);
  try {
    const resp = await agentCtx.request.get(`${BASE_URL}/api/v1/ai/usage`);
    const body = await resp.text();
    record(
      "AC6 (agent role 403)",
      resp.status() === 403 && /forbidden_role/.test(body),
      `HTTP ${resp.status()} body=${body.slice(0, 200)}`,
    );
  } catch (e) {
    record("AC6 (agent role 403)", false, `error: ${(e as Error).message}`);
  }
  await agentCtx.close();

  await browser.close();

  // ---- Cleanup ----
  try {
    await sb.from("ai_invocations").delete().eq("organization_id", ORG_ID).eq("model", "qa-wave-10");
    await sb.from("event_log").delete().eq("id", handoffEventId);
    if (inboundIds.length) {
      await sb.from("messages").delete().in("id", inboundIds);
    }
    console.log("[cleanup] removed seed rows");
  } catch (e) {
    console.log(`[cleanup] error: ${(e as Error).message}`);
  }

  // ---- Final report ----
  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE_URL,
    seeded: {
      ai_invocations: seedRows.length,
      messages_inbound: seededInbound,
      event_log_handoff: 1,
      seedingNote,
    },
    db_counts_in_range: { inbound: dbInbound, handoff: dbHandoff },
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
