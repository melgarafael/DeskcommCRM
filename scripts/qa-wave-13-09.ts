/* eslint-disable no-console */
/**
 * Wave 9 (EPIC-13) QA — Webhook WAHA hook → event_log dispatch.
 * Backend-only feature (no UI). Code-level checks + grep-based contract verification.
 *
 * Run: npx tsx scripts/qa-wave-13-09.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const GLOBAL_ROUTE = path.join(ROOT, "app/api/v1/webhooks/waha/route.ts");
const TOKEN_ROUTE = path.join(ROOT, "app/api/v1/webhooks/waha/[token]/route.ts");

type Result = { ac: string; pass: boolean; evidence: string };
const results: Result[] = [];
const record = (ac: string, pass: boolean, evidence: string) => {
  results.push({ ac, pass, evidence });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${ac} — ${evidence}`);
};

const globalSrc = fs.readFileSync(GLOBAL_ROUTE, "utf8");
const tokenSrc = fs.readFileSync(TOKEN_ROUTE, "utf8");

function extractFn(src: string, name: string): string {
  const re = new RegExp(`async function ${name}\\b[\\s\\S]*?\\n}\\n`, "m");
  const m = src.match(re);
  return m ? m[0] : "";
}

const globalInbound = extractFn(globalSrc, "handleInbound");
const tokenInbound = extractFn(tokenSrc, "handleInbound");
const globalOutbound = extractFn(globalSrc, "handleOutboundFromUserPhone");
const tokenOutbound = extractFn(tokenSrc, "handleOutboundFromUserPhone");

// TC-W9-01
{
  const reEmit = /\.rpc\(\s*"emit_event"[\s\S]*?p_event_type:\s*"ai_agent\.dispatch_requested"/;
  const a = reEmit.test(globalInbound);
  const b = reEmit.test(tokenInbound);
  record(
    "TC-W9-01 ambos routes (global + [token]) emitem ai_agent.dispatch_requested via emit_event RPC",
    a && b,
    `global=${a} token=${b}`,
  );
}

// TC-W9-02
{
  function emitAfter23505(body: string): boolean {
    const idx23505 = body.indexOf('insertErr?.code === "23505"');
    const idxEmit = body.indexOf("ai_agent.dispatch_requested");
    return idx23505 >= 0 && idxEmit >= 0 && idxEmit > idx23505;
  }
  const a = emitAfter23505(globalInbound);
  const b = emitAfter23505(tokenInbound);
  record(
    "TC-W9-02 emit ocorre APOS o early-return de 23505 (sem duplicacao em retransmissao WAHA)",
    a && b,
    `global=${a} token=${b}`,
  );
}

// TC-W9-03
{
  function hasSelectId(body: string): boolean {
    const m = body.match(/\.from\("messages"\)[\s\S]*?\.insert\([\s\S]*?\)[\s\S]*?\.select\("id"\)/);
    return !!m;
  }
  const a = hasSelectId(globalInbound);
  const b = hasSelectId(tokenInbound);
  record(
    "TC-W9-03 insert da mensagem inbound captura id via .select(\"id\")",
    a && b,
    `global=${a} token=${b}`,
  );
}

// TC-W9-04
{
  const required = [
    "organization_id",
    "conversation_id",
    "contact_id",
    "channel_session_id",
    "inbound_message_id",
  ];
  function hasAllKeys(body: string): { ok: boolean; missing: string[] } {
    // ancora no bloco do dispatch_requested (token route tem outro p_payload de message.received antes)
    const reBlock = /p_event_type:\s*"ai_agent\.dispatch_requested"[\s\S]*?p_payload:\s*\{([\s\S]*?)\}/;
    const m = body.match(reBlock);
    if (!m) return { ok: false, missing: required };
    const block = m[1] ?? "";
    const missing = required.filter((k) => !new RegExp(`\\b${k}\\s*:`).test(block));
    return { ok: missing.length === 0, missing };
  }
  const a = hasAllKeys(globalInbound);
  const b = hasAllKeys(tokenInbound);
  record(
    "TC-W9-04 payload contem {organization_id, conversation_id, contact_id, channel_session_id, inbound_message_id}",
    a.ok && b.ok,
    `global_missing=[${a.missing.join(",")}] token_missing=[${b.missing.join(",")}]`,
  );
}

// TC-W9-05
{
  function fireAndForget(body: string): boolean {
    const reAwait = /await\s+admin\s*\.rpc\(\s*"emit_event"[\s\S]{0,400}?ai_agent\.dispatch_requested/;
    const reThen =
      /\.rpc\(\s*"emit_event"[\s\S]*?ai_agent\.dispatch_requested[\s\S]*?\.then\(\s*\(\s*\{\s*error\s*\}\s*\)\s*=>\s*\{[\s\S]*?console\.error/;
    return !reAwait.test(body) && reThen.test(body);
  }
  const a = fireAndForget(globalInbound);
  const b = fireAndForget(tokenInbound);
  record(
    "TC-W9-05 emit fire-and-forget (sem await) + .then() logando erro — webhook segue 200",
    a && b,
    `global=${a} token=${b}`,
  );
}

// TC-W9-06
{
  const a = !/ai_agent\.dispatch_requested/.test(globalOutbound);
  const b = !/ai_agent\.dispatch_requested/.test(tokenOutbound);
  record(
    "TC-W9-06 handleOutboundFromUserPhone (fromMe=true) NAO emite ai_agent.dispatch_requested",
    a && b,
    `global=${a} token=${b}`,
  );
}

// TC-W9-07
{
  function groupSkipBeforeEmit(body: string): boolean {
    // Aceita as duas formas: `parsed.kind === "group") return;` (global) ou
    // `if (isGroup) return;` (token route, que usa flag boolean derivada).
    const reGroup = /(parsed\.kind\s*===\s*"group"\s*\)\s*return;|if\s*\(\s*isGroup\s*\)\s*return\s*;)/;
    const m = body.match(reGroup);
    if (!m || m.index == null) return false;
    const idxEmit = body.indexOf("ai_agent.dispatch_requested");
    return idxEmit > m.index;
  }
  const a = groupSkipBeforeEmit(globalInbound);
  const b = groupSkipBeforeEmit(tokenInbound);
  record(
    "TC-W9-07 group inbound (@g.us) early-return ANTES do emit (grupos nao geram dispatch)",
    a && b,
    `global=${a} token=${b}`,
  );
}

// TC-W9-08
{
  let ok = false;
  let evidence = "";
  try {
    execFileSync("npx", ["tsc", "--noEmit"], { cwd: ROOT, stdio: "pipe" });
    ok = true;
    evidence = "tsc --noEmit exit 0";
  } catch (e) {
    const err = e as { stdout?: Buffer; status?: number };
    evidence = `tsc exit ${err.status} stdout=${(err.stdout ?? Buffer.alloc(0)).toString().slice(-300)}`;
  }
  record("TC-W9-08 npx tsc --noEmit exits 0 (typecheck clean apos wave 9)", ok, evidence);
}

// TC-W9-09
{
  function metadataAndOrg(body: string): boolean {
    const reMeta = /p_metadata:\s*\{\s*source:\s*"waha_webhook"\s*,\s*request_id:/;
    const reOrg = /p_organization_id:\s*session\.organization_id/;
    return reMeta.test(body) && reOrg.test(body);
  }
  const a = metadataAndOrg(globalInbound);
  const b = metadataAndOrg(tokenInbound);
  record(
    "TC-W9-09 emit_event recebe p_metadata={source:'waha_webhook', request_id} + p_organization_id",
    a && b,
    `global=${a} token=${b}`,
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length > 0) {
  console.log("FAILS:");
  for (const f of failed) console.log(`  - ${f.ac}: ${f.evidence}`);
  process.exit(1);
}
