/**
 * Seed E2E do mapa da Prospecção. Cria 3 prospects geolocalizados em
 * Canoinhas/SC (coordenadas reais aproximadas do centro):
 *   - "Restaurante E2E Mapa" (novo, com telefone);
 *   - "Mercado E2E Mapa" (qualificado, vinculado a contato = no CRM);
 *   - "Padaria E2E Mapa" (cliente).
 *
 * Idempotente por nome. Depende de .e2e-creds.json.
 *
 * Run: npx tsx scripts/seed-e2e-prospeccao-mapa.ts
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-prospeccao-mapa", credenciais);
const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

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

async function ensureProspect(
  orgId: string,
  p: {
    nome: string;
    categoria: string;
    latitude: number;
    longitude: number;
    telefone: string | null;
    status_comercial: string;
    score: number;
    contact_id?: string | null;
  },
): Promise<void> {
  const { data: existing } = await admin
    .from("business_prospects")
    .select("id")
    .eq("organization_id", orgId)
    .eq("nome", p.nome)
    .maybeSingle();
  if (existing) return;
  const { error } = await admin.from("business_prospects").insert({
    organization_id: orgId,
    nome: p.nome,
    nome_normalizado: p.nome.toLowerCase(),
    categoria: p.categoria,
    cidade: "Canoinhas",
    estado: "SC",
    telefone: p.telefone,
    latitude: p.latitude,
    longitude: p.longitude,
    provider: "e2e",
    status_comercial: p.status_comercial,
    score: p.score,
    contact_id: p.contact_id ?? null,
  });
  if (error) throw new Error(`insert prospect ${p.nome}: ${error.message}`);
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as { org_id: string };
  const orgId = creds.org_id;

  const contato = await ensureContact(orgId, "Mercado E2E Mapa (contato)");
  await ensureProspect(orgId, {
    nome: "Restaurante E2E Mapa",
    categoria: "Restaurante",
    latitude: -26.1767,
    longitude: -50.39,
    telefone: "(47) 3622-0001",
    status_comercial: "novo",
    score: 80,
  });
  await ensureProspect(orgId, {
    nome: "Mercado E2E Mapa",
    categoria: "Mercado",
    latitude: -26.18,
    longitude: -50.385,
    telefone: "(47) 3622-0002",
    status_comercial: "qualificado",
    score: 65,
    contact_id: contato,
  });
  await ensureProspect(orgId, {
    nome: "Padaria E2E Mapa",
    categoria: "Padaria",
    latitude: -26.17,
    longitude: -50.395,
    telefone: null,
    status_comercial: "cliente",
    score: 50,
  });

  // eslint-disable-next-line no-console
  console.log("seed-e2e-prospeccao-mapa OK");
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
