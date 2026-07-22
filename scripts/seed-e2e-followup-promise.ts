/**
 * Seed E2E de uma PROMESSA de follow-up (Task 7.1): 1 contato + 1 `cron_jobs`
 * row (kind='at', job_kind='followup_turn') com o payload que a tool
 * `schedule_followup` grava — sem passar pelo agente de IA, direto via
 * service role (mesmo padrão de scripts/seed-e2e-queue.ts). Não existe rota
 * pública que crie esse tipo de linha (só a tool do agente, em runtime), então
 * o seed de teste replica o shape exato do payload em vez de inventar um
 * endpoint novo só pra isto.
 *
 * Idempotente: apaga as linhas de teste anteriores do mesmo contato antes de
 * inserir a nova, então cada run deixa exatamente 1 promessa viva. Depende de
 * .e2e-creds.json (rode scripts/seed-e2e-credentials.ts antes). Grava o bloco
 * `followup_promise`.
 *
 * Run: npx tsx scripts/seed-e2e-followup-promise.ts
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
const CONTACT_NAME = "Cliente Promessa E2E";

interface Creds {
  org_id: string;
  followup_promise?: unknown;
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

  const contactId = await ensureContact(orgId);

  // Idempotência: remove promessas de teste anteriores deste contato antes de recriar.
  await admin
    .from("cron_jobs")
    .delete()
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("job_kind", "followup_turn");

  const promisedAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // em 3 dias
  const payload = {
    reason: "Cliente pediu para retornar depois do feriado",
    promise: "Vamos avisar assim que o produto voltar ao estoque",
    promised_at: promisedAt.toISOString(),
    context_snapshot: null,
  };

  const { data, error } = await admin
    .from("cron_jobs")
    .insert({
      organization_id: orgId,
      contact_id: contactId,
      kind: "at",
      job_kind: "followup_turn",
      next_run_at: promisedAt.toISOString(),
      enabled: true,
      payload,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert cron_jobs: ${error?.message}`);
  const cronJobId = (data as { id: string }).id;

  creds.followup_promise = {
    cron_job_id: cronJobId,
    contact_id: contactId,
    contact_name: CONTACT_NAME,
    reason: payload.reason,
    promise: payload.promise,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  console.log(`\n✅ Follow-up promise seed completo. cron_job=${cronJobId} contact=${contactId}`);
}

main().catch((err) => {
  console.error("❌ Follow-up promise seed falhou:", err);
  process.exit(1);
});
