/**
 * Seed E2E da fila (G5-03): 1 contato + 1 channel_session + 1 conversa SEM dono,
 * aberta, com last_inbound_at conhecido → aparece na visão "Fila" do inbox com
 * posição + "aguardando há X". Alimenta o e2e queue-assign.spec.ts.
 *
 * Idempotente E auto-reset: a cada run devolve a conversa ao estado de fila
 * (assigned_to_user_id=null, status='open', unread=3) — o teste pode rodar de
 * novo após uma atribuição anterior. Depende de .e2e-creds.json
 * (rode scripts/seed-e2e-credentials.ts antes). Grava o bloco `queue`.
 *
 * Run: npx tsx scripts/seed-e2e-queue.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const CONTACT_NAME = "Cliente Fila E2E";
const SESSION_NAME = "e2e-queue-session";

interface Creds {
  org_id: string;
  users: Record<string, { id: string }>;
  queue?: unknown;
}

async function ensureSession(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("waha_session_name", SESSION_NAME)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: orgId,
      waha_session_name: SESSION_NAME,
      display_name: "Número Fila E2E",
      webhook_secret_encrypted: "\\x00",
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert channel_session: ${error?.message}`);
  return (data as { id: string }).id;
}

async function ensureContact(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("display_name", CONTACT_NAME)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await admin
    .from("contacts")
    .insert({ organization_id: orgId, display_name: CONTACT_NAME } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert contact: ${error?.message}`);
  return (data as { id: string }).id;
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const orgId = creds.org_id;

  const sessionId = await ensureSession(orgId);
  const contactId = await ensureContact(orgId);

  // Estado de fila: sem dono, aberta, esperando há 20 min.
  const queueState = {
    assigned_to_user_id: null,
    assignee_kind: null,
    assigned_at: null,
    status: "open",
    unread_count_for_assignee: 3,
    last_inbound_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    last_message_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    last_message_preview: "Olá, preciso de ajuda com meu pedido",
  };

  const { data: existing } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("channel_session_id", sessionId)
    .maybeSingle();

  let conversationId: string;
  if (existing) {
    conversationId = (existing as { id: string }).id;
    const { error } = await admin
      .from("conversations")
      .update(queueState as never)
      .eq("id", conversationId);
    if (error) throw new Error(`reset conversation: ${error.message}`);
    console.log(`[seed] conversation reset to queue state: ${conversationId}`);
  } else {
    const { data, error } = await admin
      .from("conversations")
      .insert({
        organization_id: orgId,
        contact_id: contactId,
        channel_session_id: sessionId,
        ...queueState,
      } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`insert conversation: ${error?.message}`);
    conversationId = (data as { id: string }).id;
    console.log(`[seed] conversation created in queue: ${conversationId}`);
  }

  creds.queue = {
    conversation_id: conversationId,
    contact_id: contactId,
    contact_name: CONTACT_NAME,
    channel_session_id: sessionId,
    agent_user_id: creds.users.agent!.id,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  console.log(`\n✅ Queue seed completo. conversation=${conversationId}`);
}

main().catch((err) => {
  console.error("❌ Queue seed falhou:", err);
  process.exit(1);
});
