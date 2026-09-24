/* eslint-disable no-console */
/**
 * Wave 9 E2E QA — knowledge sources UI/API
 * Run: npx tsx scripts/qa-wave-09.ts
 */
import { chromium, type BrowserContext, type APIRequestContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

// `process.env` vence o `.env.local` (scripts/lib/env-de-teste.ts).
carregarEnvLocal();

const BASE_URL = "http://localhost:3000";
const ARTIFACTS_DIR = path.resolve(process.cwd(), "test-results/wave-09");
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

async function main() {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // --------- Setup: seed FAQ + Policy if absent ---------
  let faqSourceId: string | null = null;
  let policySourceId: string | null = null;

  const { data: existingFaq } = await sb
    .from("ai_knowledge_sources")
    .select("id")
    .eq("organization_id", ORG_ID)
    .eq("agent_id", DEFAULT_AGENT_ID)
    .eq("source_type", "faq")
    .limit(1)
    .maybeSingle();
  // NOTE: last_index_status check constraint allows only NULL/'failed'/'partial'.
  // status (separate column added in 0013) is what the spec used "ready" for.
  // Seed with both to satisfy the route + give the badge logic something to render.
  if (existingFaq) {
    faqSourceId = existingFaq.id;
    await sb
      .from("ai_knowledge_sources")
      .update({
        last_index_status: null,
        last_index_error: null,
        status: "ready",
        name: "FAQ E2E",
        chunks_count: 5,
        last_indexed_at: new Date().toISOString(),
      } as never)
      .eq("id", faqSourceId);
    console.log(`[setup] reused FAQ source ${faqSourceId}`);
  } else {
    const { data: ins, error } = await sb
      .from("ai_knowledge_sources")
      .insert({
        organization_id: ORG_ID,
        agent_id: DEFAULT_AGENT_ID,
        source_type: "faq",
        is_active: true,
        chunks_count: 5,
        last_indexed_at: new Date().toISOString(),
        last_index_status: null,
        status: "ready",
        name: "FAQ E2E",
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(`seed FAQ failed: ${error.message}`);
    faqSourceId = ins!.id;
    console.log(`[setup] seeded FAQ source ${faqSourceId}`);
  }

  const { data: existingPolicy } = await sb
    .from("ai_knowledge_sources")
    .select("id")
    .eq("organization_id", ORG_ID)
    .eq("agent_id", DEFAULT_AGENT_ID)
    .eq("source_type", "policy")
    .limit(1)
    .maybeSingle();
  if (existingPolicy) {
    policySourceId = existingPolicy.id;
    await sb
      .from("ai_knowledge_sources")
      .update({
        last_index_status: null,
        last_index_error: null,
        status: "ready",
        name: "Policy E2E",
        chunks_count: 3,
        last_indexed_at: new Date().toISOString(),
      } as never)
      .eq("id", policySourceId);
    console.log(`[setup] reused Policy source ${policySourceId}`);
  } else {
    const { data: ins, error } = await sb
      .from("ai_knowledge_sources")
      .insert({
        organization_id: ORG_ID,
        agent_id: DEFAULT_AGENT_ID,
        source_type: "policy",
        is_active: true,
        chunks_count: 3,
        last_indexed_at: new Date().toISOString(),
        last_index_status: null,
        status: "ready",
        name: "Policy E2E",
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(`seed Policy failed: ${error.message}`);
    policySourceId = ins!.id;
    console.log(`[setup] seeded Policy source ${policySourceId}`);
  }

  // Ensure Conversations + Catalog don't exist for this agent (so AC4 has empty CTA)
  // Just check; if they exist, AC4 will still try one of them.
  const { data: nonEmpty } = await sb
    .from("ai_knowledge_sources")
    .select("source_type")
    .eq("organization_id", ORG_ID)
    .eq("agent_id", DEFAULT_AGENT_ID);
  const types = new Set((nonEmpty ?? []).map((r) => r.source_type));
  console.log(`[setup] existing types for agent: ${[...types].join(",")}`);

  const browser = await chromium.launch({ headless: true });

  // --------- Manager UI flow (AC1, AC2, AC4) ---------
  const mgrCtx = await browser.newContext({ baseURL: BASE_URL });
  await login(mgrCtx, MANAGER_EMAIL);
  const mgrPage = await mgrCtx.newPage();

  // AC1 — page renders with 4 slots
  try {
    await mgrPage.goto(`${BASE_URL}/app/ai/knowledge/sources`, {
      waitUntil: "domcontentloaded",
    });
    await mgrPage.waitForTimeout(2000);
    const ac1Shot = path.join(ARTIFACTS_DIR, "ac1-grid.png");
    await mgrPage.screenshot({ path: ac1Shot, fullPage: true });

    const labels = ["FAQ", "Política", "Conversas opt-in", "Catálogo"];
    const found: Record<string, boolean> = {};
    for (const l of labels) {
      const c = await mgrPage.locator(`text=${l}`).count();
      found[l] = c > 0;
    }
    const allFound = labels.every((l) => found[l]);
    record(
      "AC1 (4 slots render)",
      allFound,
      `found=${JSON.stringify(found)}; screenshot: ${ac1Shot}`,
    );
  } catch (e) {
    record("AC1 (4 slots render)", false, `error: ${(e as Error).message}`);
  }

  // AC2 — FAQ card metrics: chunks_count, "Pronto" badge, Re-indexar button, last_indexed_at
  try {
    const pageText = await mgrPage.locator("body").innerText();
    const hasChunks = /\b5\b/.test(pageText); // chunks_count=5
    const hasReadyBadge = /Pronto/.test(pageText);
    const reindexBtnCount = await mgrPage.getByRole("button", { name: /Re-indexar/i }).count();
    const hasReindex = reindexBtnCount >= 1;
    // Relative date markers we render: "agora há pouco", "há N min/h/d", or pt-BR locale date
    const hasDate = /(agora há pouco|há \d+\s?(min|h|d)|\d{2}\/\d{2}\/\d{4})/.test(pageText);
    const pass = hasChunks && hasReadyBadge && hasReindex && hasDate;
    record(
      "AC2 (FAQ card metrics)",
      pass,
      `chunks5=${hasChunks} pronto=${hasReadyBadge} reindexBtn=${reindexBtnCount} date=${hasDate}`,
    );
  } catch (e) {
    record("AC2 (FAQ card metrics)", false, `error: ${(e as Error).message}`);
  }

  // AC4 — empty CTA: "Configurar Catálogo" or "Configurar Conversas opt-in"
  try {
    const pageText = await mgrPage.locator("body").innerText();
    const hasCTA = /Configurar (Catálogo|Conversas opt-in)/.test(pageText);
    const ac4Shot = path.join(ARTIFACTS_DIR, "ac4-cta-empty.png");
    await mgrPage.screenshot({ path: ac4Shot, fullPage: true });
    record(
      "AC4 (empty slot CTA)",
      hasCTA,
      `CTA found=${hasCTA}; screenshot: ${ac4Shot}`,
    );
  } catch (e) {
    record("AC4 (empty slot CTA)", false, `error: ${(e as Error).message}`);
  }

  await mgrPage.close();

  // --------- API tests as manager (manager+ allowed) ---------
  const mgrApi: APIRequestContext = mgrCtx.request;

  // AC7 prep — count event_log rows for knowledge_source.updated BEFORE
  let beforeEventCount = 0;
  try {
    const { count } = await sb
      .from("event_log")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG_ID)
      .eq("event_type", "knowledge_source.updated");
    beforeEventCount = count ?? 0;
    console.log(`[event_log before] ${beforeEventCount}`);
  } catch (e) {
    console.log(`[event_log before] error: ${(e as Error).message}`);
  }

  // AC3 — POST reindex (manager) → 200 with single-wrap
  let ac3JsonShape = "";
  try {
    const resp = await mgrApi.post(
      `${BASE_URL}/api/v1/ai/knowledge/sources/${faqSourceId}/reindex`,
    );
    const body = await resp.json().catch(() => null);
    ac3JsonShape = JSON.stringify(body).slice(0, 240);
    // Single-wrap: body.data.{id, queued, agent_id}, NOT body.data.data.*
    const hasSingleWrap =
      body &&
      typeof body.data === "object" &&
      body.data !== null &&
      body.data.id === faqSourceId &&
      body.data.queued === true &&
      typeof body.data.agent_id === "string" &&
      // Verify NO nested .data.data
      !(typeof body.data.data === "object" && body.data.data !== null);
    record(
      "AC3 (reindex 200 single-wrap)",
      resp.status() === 200 && hasSingleWrap,
      `HTTP ${resp.status()} body=${ac3JsonShape}`,
    );
  } catch (e) {
    record("AC3 (reindex 200 single-wrap)", false, `error: ${(e as Error).message}`);
  }

  // AC9 — DB row: last_index_error cleared; last_index_status untouched (NULL legítimo).
  try {
    const { data: row, error } = await sb
      .from("ai_knowledge_sources")
      .select("last_index_status, last_index_error")
      .eq("id", faqSourceId!)
      .single();
    if (error) throw error;
    const validStatuses = [null, "failed", "partial"] as const;
    const pass =
      row.last_index_error === null &&
      (validStatuses as readonly (string | null)[]).includes(row.last_index_status);
    record(
      "AC9 (DB row consistent w/ schema)",
      pass,
      `row=${JSON.stringify(row)}`,
    );
  } catch (e) {
    record("AC9 (DB row consistent w/ schema)", false, `error: ${(e as Error).message}`);
  }

  // AC7 — event_log incremented by 1
  try {
    const { count } = await sb
      .from("event_log")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG_ID)
      .eq("event_type", "knowledge_source.updated");
    const after = count ?? 0;
    const delta = after - beforeEventCount;
    record(
      "AC7 (event_log +1)",
      delta === 1,
      `before=${beforeEventCount} after=${after} delta=${delta}`,
    );
  } catch (e) {
    record("AC7 (event_log +1)", false, `error: ${(e as Error).message}`);
  }

  // AC6 — RLS cross-tenant / not found → 404
  try {
    const resp = await mgrApi.post(
      `${BASE_URL}/api/v1/ai/knowledge/sources/00000000-0000-0000-0000-000000000000/reindex`,
    );
    const body = await resp.text();
    record(
      "AC6 (RLS 404)",
      resp.status() === 404 && /not_found/.test(body),
      `HTTP ${resp.status()} body=${body.slice(0, 160)}`,
    );
  } catch (e) {
    record("AC6 (RLS 404)", false, `error: ${(e as Error).message}`);
  }

  await mgrCtx.close();

  // --------- Agent role tests (AC5 + AC8) ---------
  const agentCtx = await browser.newContext({ baseURL: BASE_URL });
  await login(agentCtx, AGENT_EMAIL);
  const agentPage = await agentCtx.newPage();

  // AC5 — agent → /403 on UI
  try {
    await agentPage.goto(`${BASE_URL}/app/ai/knowledge/sources`, {
      waitUntil: "networkidle",
    });
    try {
      await agentPage.waitForURL(/\/403/, { timeout: 5000 });
    } catch {
      /* may have already redirected */
    }
    const finalUrl = agentPage.url();
    const ac5Shot = path.join(ARTIFACTS_DIR, "ac5-agent-403.png");
    await agentPage.screenshot({ path: ac5Shot, fullPage: true });
    record(
      "AC5 (agent → /403)",
      /\/403/.test(finalUrl),
      `final URL: ${finalUrl}; screenshot: ${ac5Shot}`,
    );
  } catch (e) {
    record("AC5 (agent → /403)", false, `error: ${(e as Error).message}`);
  }
  await agentPage.close();

  // AC8 — agent POST reindex → 403 forbidden_role
  try {
    const resp = await agentCtx.request.post(
      `${BASE_URL}/api/v1/ai/knowledge/sources/${faqSourceId}/reindex`,
    );
    const body = await resp.text();
    record(
      "AC8 (agent role 403)",
      resp.status() === 403 && /forbidden_role/.test(body),
      `HTTP ${resp.status()} body=${body.slice(0, 200)}`,
    );
  } catch (e) {
    record("AC8 (agent role 403)", false, `error: ${(e as Error).message}`);
  }

  await agentCtx.close();
  await browser.close();

  // --------- Final report ---------
  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE_URL,
    seeded: { faqSourceId, policySourceId },
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
