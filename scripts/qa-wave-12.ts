/* eslint-disable no-console */
/**
 * Wave 12 E2E QA — Citations capture + UI debug toggle.
 * Run: npx tsx scripts/qa-wave-12.ts
 */
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

// inline minimal .env.local loader
{
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] && !process.env[m[1]]) {
        let v = m[2] ?? "";
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env[m[1]] = v;
      }
    }
  }
}

const BASE_URL = "http://localhost:3000";
const ARTIFACTS_DIR = path.resolve(process.cwd(), "test-results/wave-12");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const creds = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), ".e2e-creds.json"), "utf8"),
);
const PASSWORD: string = creds.password;
const MANAGER_EMAIL: string = creds.users.manager.email;
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
  await page.getByRole("button", { name: /entrar/i }).click();
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

type SB = ReturnType<typeof createClient>;

async function ensureChannelSession(sb: SB): Promise<string> {
  const existing = await sb
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", ORG_ID)
    .limit(1)
    .maybeSingle();
  if (existing.data && (existing.data as { id: string }).id) {
    return (existing.data as { id: string }).id;
  }
  const insert = await sb
    .from("channel_sessions")
    .insert({
      organization_id: ORG_ID,
      waha_session_name: `e2e-wave12-${Date.now()}`,
      webhook_secret_encrypted: "x".repeat(32),
      display_name: "E2E Wave12",
      engine: "NOWEB",
      status: "STOPPED",
    } as never)
    .select("id")
    .single();
  if (insert.error) throw new Error(`channel_sessions insert: ${insert.error.message}`);
  return (insert.data as { id: string }).id;
}

interface SeedIds {
  contactId: string;
  conversationId: string;
  channelSessionId: string;
  msgAId: string;
  msgBId: string;
  msgCId: string;
  msgDId: string; // optional human/non-AI outbound
}

async function seed(sb: SB): Promise<SeedIds> {
  const channelSessionId = await ensureChannelSession(sb);

  const cIns = await sb
    .from("contacts")
    .insert({
      organization_id: ORG_ID,
      phone_number: "+5511999990000",
      display_name: "E2E Wave12 Bot Test",
      source: "manual",
    } as never)
    .select("id")
    .single();
  if (cIns.error) throw new Error(`contacts insert: ${cIns.error.message}`);
  const contactId = (cIns.data as { id: string }).id;

  const conIns = await sb
    .from("conversations")
    .insert({
      organization_id: ORG_ID,
      contact_id: contactId,
      channel_session_id: channelSessionId,
      channel: "whatsapp",
      status: "open",
    } as never)
    .select("id")
    .single();
  if (conIns.error) throw new Error(`conversations insert: ${conIns.error.message}`);
  const conversationId = (conIns.data as { id: string }).id;

  const baseMsg = {
    organization_id: ORG_ID,
    conversation_id: conversationId,
    contact_id: contactId,
    channel_session_id: channelSessionId,
    type: "text",
    status: "sent",
  };

  const t0 = Date.now();
  const ins = await sb
    .from("messages")
    .insert([
      {
        ...baseMsg,
        direction: "outbound",
        sent_via: "ai",
        body: "Olá! Sua dúvida sobre devolução: você tem 7 dias úteis após o recebimento.",
        sent_at: new Date(t0 + 1000).toISOString(),
        metadata: {
          ai_generated: true,
          citations: [
            {
              chunk_id: "c1",
              source_type: "policy",
              source_anchor: "§Devoluções",
              score: 0.91,
              snippet:
                "O cliente possui 7 dias úteis para devolução conforme CDC art. 49.",
            },
            {
              chunk_id: "c2",
              source_type: "faq",
              source_anchor: "Como devolver",
              score: 0.78,
              snippet: "Inicie pelo painel...",
            },
          ],
        },
      },
      {
        ...baseMsg,
        direction: "outbound",
        sent_via: "ai",
        body: "Resposta sem RAG",
        sent_at: new Date(t0 + 2000).toISOString(),
        metadata: { ai_generated: true, citations: [] },
      },
      {
        ...baseMsg,
        direction: "inbound",
        sent_via: "system",
        body: "Quero devolver meu produto",
        sent_at: new Date(t0).toISOString(),
        metadata: {},
      },
      {
        ...baseMsg,
        direction: "outbound",
        sent_via: "user",
        body: "Mensagem humana de operador (regression)",
        sent_at: new Date(t0 + 3000).toISOString(),
        metadata: {},
      },
    ] as never)
    .select("id, sent_via, body, direction, metadata, sent_at");
  if (ins.error) throw new Error(`messages insert: ${ins.error.message}`);
  const rows = ins.data as Array<{
    id: string;
    sent_via: string;
    body: string;
    direction: string;
    metadata: Record<string, unknown>;
  }>;

  // Identify A/B/C/D by body+direction
  const find = (pred: (r: (typeof rows)[number]) => boolean) =>
    rows.find(pred)!.id;
  const msgAId = find(
    (r) => r.direction === "outbound" && r.sent_via === "ai" && /7 dias úteis/.test(r.body),
  );
  const msgBId = find(
    (r) => r.direction === "outbound" && r.sent_via === "ai" && r.body === "Resposta sem RAG",
  );
  const msgCId = find((r) => r.direction === "inbound");
  const msgDId = find((r) => r.direction === "outbound" && r.sent_via === "user");

  return { contactId, conversationId, channelSessionId, msgAId, msgBId, msgCId, msgDId };
}

async function cleanup(sb: SB, ids: Partial<SeedIds>): Promise<void> {
  try {
    if (ids.conversationId) {
      await sb.from("messages").delete().eq("conversation_id", ids.conversationId);
      await sb.from("conversations").delete().eq("id", ids.conversationId);
    }
    if (ids.contactId) {
      await sb.from("contacts").delete().eq("id", ids.contactId);
    }
  } catch (e) {
    console.log(`[cleanup] error: ${(e as Error).message}`);
  }
}

async function gotoConversation(page: Page, conversationId: string) {
  await page.goto(`${BASE_URL}/app/inbox?id=${conversationId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(2500);
}

/** Returns a Locator for the message bubble that contains the given body text. */
function bubbleByText(page: Page, text: string) {
  // The bubble is the closest container of the <p> rendering body
  return page.locator("div.rounded-2xl").filter({ hasText: text }).first();
}

async function main() {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  let ids: SeedIds | null = null;
  try {
    console.log("[setup] seeding contact/conversation/messages…");
    ids = await seed(sb);
    console.log(`[setup] ids=${JSON.stringify(ids)}`);
  } catch (e) {
    console.error("[setup] FATAL:", (e as Error).message);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const ctx = await browser.newContext({ baseURL: BASE_URL });
    await login(ctx, MANAGER_EMAIL);

    const page = await ctx.newPage();
    await gotoConversation(page, ids.conversationId);

    // Wait for thread messages to load (initially shows "Sem mensagens" until query resolves).
    const aBubble = bubbleByText(page, "7 dias úteis");
    try {
      await aBubble.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      /* surface in sanity below */
    }
    const aVisible = await aBubble.isVisible().catch(() => false);
    console.log(`[sanity] message A visible in thread: ${aVisible}`);
    if (!aVisible) {
      // Capture for debugging
      await page.screenshot({
        path: path.join(ARTIFACTS_DIR, "debug-thread-not-loaded.png"),
        fullPage: true,
      });
    }

    // ---------- AC1: Info icon visible inside AI bubble ----------
    try {
      const infoBtn = aBubble.locator('button[aria-label="Mostrar citações da resposta"]');
      const count = await infoBtn.count();
      const visible = count > 0 ? await infoBtn.first().isVisible() : false;
      const shot = path.join(ARTIFACTS_DIR, "ac1-info-icon.png");
      await page.screenshot({ path: shot, fullPage: true });
      record(
        "AC1 (Info icon present in AI bubble)",
        count >= 1 && visible,
        `info_buttons_in_A=${count} visible=${visible} shot=${shot}`,
      );
    } catch (e) {
      record("AC1 (Info icon present in AI bubble)", false, `error: ${(e as Error).message}`);
    }

    // ---------- AC2: Click → panel opens with 2 citation cards ----------
    try {
      await aBubble
        .locator('button[aria-label="Mostrar citações da resposta"]')
        .first()
        .click();
      await page.waitForTimeout(700);
      const title = page.getByText("Citações da resposta IA");
      const titleVisible = await title.isVisible().catch(() => false);
      const bodyText = await page.locator("body").innerText();
      const hasPolitica = /Política/.test(bodyText);
      const has91 = /91%/.test(bodyText);
      const has7days = /7 dias úteis/.test(bodyText);
      const hasFAQ = /FAQ/.test(bodyText);
      const has78 = /78%/.test(bodyText);
      const shot = path.join(ARTIFACTS_DIR, "ac2-panel-citations.png");
      await page.screenshot({ path: shot, fullPage: true });
      const pass = titleVisible && hasPolitica && has91 && has7days && hasFAQ && has78;
      record(
        "AC2 (Panel opens with 2 citation cards)",
        pass,
        `title=${titleVisible} politica=${hasPolitica} 91%=${has91} 7dias=${has7days} FAQ=${hasFAQ} 78%=${has78} shot=${shot}`,
      );
      // Close panel (Escape)
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    } catch (e) {
      record("AC2 (Panel opens with 2 citation cards)", false, `error: ${(e as Error).message}`);
    }

    // ---------- AC3: Message B (no citations) → "Resposta sem RAG hits" ----------
    try {
      const bBubble = bubbleByText(page, "Resposta sem RAG");
      await bBubble
        .locator('button[aria-label="Mostrar citações da resposta"]')
        .first()
        .click();
      await page.waitForTimeout(600);
      const bodyText = await page.locator("body").innerText();
      const hasNoHits = /Resposta sem RAG hits/.test(bodyText);
      const shot = path.join(ARTIFACTS_DIR, "ac3-empty-citations.png");
      await page.screenshot({ path: shot, fullPage: true });
      record(
        "AC3 (No-RAG message shows empty-state)",
        hasNoHits,
        `empty_state_visible=${hasNoHits} shot=${shot}`,
      );
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    } catch (e) {
      record("AC3 (No-RAG message shows empty-state)", false, `error: ${(e as Error).message}`);
    }

    // ---------- AC5: Inbound message has no Info icon ----------
    try {
      const inBubble = bubbleByText(page, "Quero devolver meu produto");
      const infoCount = await inBubble
        .locator('button[aria-label="Mostrar citações da resposta"]')
        .count();
      record(
        "AC5 (Inbound bubble has no Info icon)",
        infoCount === 0,
        `info_buttons_in_inbound=${infoCount}`,
      );
    } catch (e) {
      record("AC5 (Inbound bubble has no Info icon)", false, `error: ${(e as Error).message}`);
    }

    // ---------- AC6: Non-AI outbound (sent_via=user) has no Info icon ----------
    try {
      const dBubble = bubbleByText(page, "Mensagem humana de operador");
      const infoCount = await dBubble
        .locator('button[aria-label="Mostrar citações da resposta"]')
        .count();
      record(
        "AC6 (Non-AI outbound has no Info icon)",
        infoCount === 0,
        `info_buttons_in_human_outbound=${infoCount}`,
      );
    } catch (e) {
      record("AC6 (Non-AI outbound has no Info icon)", false, `error: ${(e as Error).message}`);
    }

    // ---------- AC4: localStorage toggle off → no Info icons anywhere ----------
    try {
      await page.evaluate(() => {
        window.localStorage.setItem("deskcomm.show_ai_citations", "0");
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      const totalInfoButtons = await page
        .locator('button[aria-label="Mostrar citações da resposta"]')
        .count();
      const shot = path.join(ARTIFACTS_DIR, "ac4-toggle-off.png");
      await page.screenshot({ path: shot, fullPage: true });
      record(
        "AC4 (Toggle off hides all Info icons)",
        totalInfoButtons === 0,
        `info_buttons_total=${totalInfoButtons} shot=${shot}`,
      );
      // Cleanup localStorage
      await page.evaluate(() => {
        window.localStorage.removeItem("deskcomm.show_ai_citations");
      });
    } catch (e) {
      record("AC4 (Toggle off hides all Info icons)", false, `error: ${(e as Error).message}`);
    }

    await page.close();
    await ctx.close();
  } finally {
    await browser.close();
  }

  // ---------- AC7: static review of MessageBubble.tsx ----------
  try {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "components/inbox/MessageBubble.tsx"),
      "utf8",
    );
    // optional prop signature
    const optional = /debugCitations\?:\s*boolean/.test(src);
    // gate: button rendered iff isOutbound && aiGenerated && (debugCitations ?? false)
    const gateLine = /showCitationButton\s*=[\s\S]*?\(debugCitations\s*\?\?\s*false\)/.test(src);
    // when undefined the gate evaluates to false → no button
    const pass = optional && gateLine;
    record(
      "AC7 (MessageBubble debugCitations is optional + gated)",
      pass,
      `optional_prop=${optional} gate_uses_nullish_coalescing_false=${gateLine}`,
    );
  } catch (e) {
    record("AC7 (MessageBubble debugCitations is optional + gated)", false, `error: ${(e as Error).message}`);
  }

  // ---------- Cleanup ----------
  await cleanup(sb, ids);
  console.log("[cleanup] removed seeded messages/conversation/contact");

  // ---------- Report ----------
  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE_URL,
    seeded: ids,
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
