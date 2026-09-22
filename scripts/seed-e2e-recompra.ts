/**
 * Seed E2E da Recompra (Radar sobre pedidos reais). Cria:
 *   - contato "Mercado E2E Recompra" + 5 vendas espaçadas ~22 dias, última há
 *     30 dias → "Recompra atrasada" com atraso de +8;
 *   - contato "Padaria E2E Voo" + 3 vendas + 1 rascunho recente → "Em voo".
 *
 * Datas relativas a hoje (a suite roda qualquer dia). Idempotente por nome.
 * Depende de .e2e-creds.json (scripts/seed-e2e-credentials.ts).
 *
 * Run: npx tsx scripts/seed-e2e-recompra.ts
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-recompra", credenciais);
const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

function isoDiasAtras(dias: number): string {
  return new Date(Date.now() - dias * 86400000).toISOString();
}

async function ensureContact(orgId: string, nome: string): Promise<string> {
  const { data: existing } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("display_name", nome)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await admin
    .from("contacts")
    .insert({ organization_id: orgId, name: nome, display_name: nome, source: "e2e" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert contact: ${error?.message}`);
  return (data as { id: string }).id;
}

async function ensureOrder(
  orgId: string,
  contactId: string,
  nome: string,
  diasAtras: number,
  totalCents: number,
  status: string,
  numero: number,
): Promise<void> {
  const { data: existing } = await admin
    .from("commercial_orders")
    .select("id")
    .eq("organization_id", orgId)
    .eq("numero", numero)
    .maybeSingle();
  if (existing) return;
  const { error } = await admin.from("commercial_orders").insert({
    organization_id: orgId,
    numero,
    contact_id: contactId,
    cliente_nome: nome,
    status,
    origem: "vendedor",
    total_cents: totalCents,
    subtotal_cents: totalCents,
    created_at: isoDiasAtras(diasAtras),
  });
  if (error) throw new Error(`insert order ${numero}: ${error.message}`);
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as { org_id: string };
  const orgId = creds.org_id;

  const mercado = await ensureContact(orgId, "Mercado E2E Recompra");
  const intervalos = [118, 96, 73, 52, 30];
  const valores = [500000, 540000, 490000, 520000, 510000];
  for (let i = 0; i < intervalos.length; i++) {
    await ensureOrder(orgId, mercado, "Mercado E2E Recompra", intervalos[i] as number, valores[i] as number, "faturado", 91001 + i);
  }

  const padaria = await ensureContact(orgId, "Padaria E2E Voo");
  for (let i = 0; i < 3; i++) {
    await ensureOrder(orgId, padaria, "Padaria E2E Voo", 80 - i * 25, 10000, "faturado", 91101 + i);
  }
  await ensureOrder(orgId, padaria, "Padaria E2E Voo", 2, 480000, "rascunho", 91104);

  // eslint-disable-next-line no-console
  console.log("seed-e2e-recompra OK");
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
