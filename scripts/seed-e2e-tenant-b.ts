/**
 * Segundo tenant para o NEGATIVO de realtime (cenário 9 da §7).
 *
 * Sem ele, o teste de duas abas prova que o evento CHEGA — e não prova que ele
 * não vaza. Realtime que atravessa tenant é pior que realtime que não funciona:
 * o primeiro é vazamento de dado de cliente, o segundo é só uma feature morta.
 *
 * Cria org B + 1 usuário manager (senha conhecida) + pipeline com 1 lead, para
 * que o board dele renderize e ASSINE o canal — uma aba que não assina não prova
 * isolamento nenhum, só prova que não estava escutando.
 *
 * Idempotente: upsert por slug/e-mail. Grava o bloco `tenant_b` em .e2e-creds.json.
 *
 * Run: npx tsx scripts/seed-e2e-tenant-b.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

// `process.env` VENCE o `.env.local` (ver scripts/lib/env-de-teste.ts).
//
// A versão anterior lia `.env.local` DIRETO do disco, ignorando o ambiente — e
// por isso a suíte E2E semeava no banco de PRODUÇÃO mesmo com o `.env.e2e`
// injetado no webServer do Playwright: este script nunca olhava para lá.
const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-tenant-b", credenciais);
const env = {
  NEXT_PUBLIC_SUPABASE_URL: credenciais.url,
  SUPABASE_SERVICE_ROLE_KEY: credenciais.serviceRole,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: credenciais.anonKey,
  NEXT_PUBLIC_APP_URL: credenciais.appUrl,
  SUPABASE_DB_URL: credenciais.dbUrl,
} as Record<string, string>;

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const ORG_SLUG = "e2e-tenant-b";
const ORG_NAME = "E2E Tenant B";
const EMAIL = "e2e-b-manager@deskcomm.test";
const PASSWORD = "E2E!Test1234";
const LEAD_TITLE = "Lead do Tenant B — nao pode vazar";

/** TOTP RFC-6238 — o produto EXIGE 2FA de admin, e a tela de LGPD é admin-only. */
function gerarTotp(secretBase32: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(c);
    if (idx >= 0) bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(Date.now() / 1000 / 30), 4);
  const hmac = crypto.createHmac("sha1", bytes).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

/**
 * Enrola TOTP para o admin do tenant B. Sem isto o produto — corretamente —
 * prende o admin na tela "sua conta exige 2FA", com o menu vazio, e nenhuma
 * tela do app é alcançável. Mesma receita de scripts/seed-e2e-credentials.ts.
 */
async function ensureTotp(
  userId: string,
  anterior: { factor_id: string; secret: string } | null,
): Promise<{ factor_id: string; secret: string }> {
  const { data: listed, error: listErr } = await admin.auth.admin.mfa.listFactors({ userId });
  if (listErr) throw new Error(`listFactors: ${listErr.message}`);
  const factors = listed?.factors ?? [];

  if (anterior && factors.some((f) => f.id === anterior.factor_id && f.status === "verified")) {
    console.info(`[seed-b] TOTP reaproveitado: ${anterior.factor_id}`);
    return anterior;
  }
  for (const f of factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
    if (error) throw new Error(`deleteFactor ${f.id}: ${error.message}`);
  }

  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInErr } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (signInErr) throw new Error(`signIn para enroll: ${signInErr.message}`);
  const { data: enrolled, error: enrollErr } = await anon.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "e2e-tenant-b",
  });
  if (enrollErr || !enrolled) throw new Error(`mfa.enroll: ${enrollErr?.message}`);
  const secret = enrolled.totp.secret;
  const { data: challenge, error: chErr } = await anon.auth.mfa.challenge({ factorId: enrolled.id });
  if (chErr || !challenge) throw new Error(`mfa.challenge: ${chErr?.message}`);
  const { error: verErr } = await anon.auth.mfa.verify({
    factorId: enrolled.id,
    challengeId: challenge.id,
    code: gerarTotp(secret),
  });
  if (verErr) throw new Error(`mfa.verify: ${verErr.message}`);
  await anon.auth.signOut();
  console.info(`[seed-b] TOTP enrolado: ${enrolled.id}`);
  return { factor_id: enrolled.id, secret };
}

async function ensureOrg(): Promise<string> {
  const { data: existing, error } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", ORG_SLUG)
    .maybeSingle();
  if (error) throw new Error(`buscar org: ${error.message}`);
  if (existing) return (existing as { id: string }).id;

  const { data, error: insErr } = await admin
    .from("organizations")
    .insert({
      slug: ORG_SLUG,
      display_name: ORG_NAME,
      legal_name: ORG_NAME,
      timezone: "Africa/Maputo",
      locale: "pt-PT",
      onboarded_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (insErr || !data) throw new Error(`criar org: ${insErr?.message}`);
  console.info(`[seed-b] org criada: ${(data as { id: string }).id}`);
  return (data as { id: string }).id;
}

async function ensureUser(): Promise<string> {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const existing = list.users.find((u) => u.email === EMAIL);
  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password: PASSWORD });
    if (error) throw new Error(`resetar senha ${EMAIL}: ${error.message}`);
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "E2E B Admin" },
  });
  if (error || !data?.user) throw new Error(`criar user ${EMAIL}: ${error?.message}`);
  console.info(`[seed-b] user criado: ${data.user.id}`);
  return data.user.id;
}

async function ensureMembership(userId: string, orgId: string): Promise<void> {
  const { data: existing, error } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`buscar membership: ${error.message}`);
  if (existing) {
    const { error: updErr } = await admin
      .from("user_organizations")
      .update({ role: "admin", revoked_at: null } as never)
      .eq("user_id", userId)
      .eq("organization_id", orgId);
    if (updErr) throw new Error(`atualizar membership: ${updErr.message}`);
    return;
  }
  const { error: insErr } = await admin.from("user_organizations").insert({
    user_id: userId,
    organization_id: orgId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  } as never);
  if (insErr) throw new Error(`inserir membership: ${insErr.message}`);
}

async function ensureBoard(orgId: string): Promise<{ pipelineId: string; leadId: string }> {
  // A plataforma já provisiona um pipeline default ao criar a org (e há unique
  // parcial em (organization_id) where is_default). Reusar o que existe é o certo:
  // criar outro colide, e duplicar pipeline padrão seria inventar um segundo funil.
  const { data: pipe, error: pErr } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (pErr) throw new Error(`buscar pipeline default: ${pErr.message}`);
  if (!pipe) throw new Error(`org ${orgId} não tem pipeline default provisionado`);
  const pipelineId = (pipe as { id: string }).id;

  const { data: stage, error: sErr } = await admin
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position")
    .limit(1)
    .maybeSingle();
  if (sErr) throw new Error(`buscar stage: ${sErr.message}`);
  if (!stage) throw new Error(`pipeline ${pipelineId} sem estágio utilizável`);
  const stageId = (stage as { id: string }).id;

  const { data: leadExist, error: lErr } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", orgId)
    .eq("title", LEAD_TITLE)
    .maybeSingle();
  if (lErr) throw new Error(`buscar lead: ${lErr.message}`);
  if (leadExist) return { pipelineId, leadId: (leadExist as { id: string }).id };

  const { data, error } = await admin
    .from("crm_leads")
    .insert({
      organization_id: orgId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      title: LEAD_TITLE,
      status: "open",
      source: "manual",
      value_cents: 100_000,
      currency: "MZN",
      position_in_stage: 1000,
      last_activity_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`criar lead: ${error?.message}`);
  return { pipelineId, leadId: (data as { id: string }).id };
}

/**
 * Pegada de LGPD DESCARTÁVEL no tenant B — para ensaiar o ciclo de anonimização
 * sem tocar na org compartilhada, onde um `store_redact` atingiria 55 contatos,
 * 132 mensagens e 51 leads de forma irreversível.
 *
 * Sem mensagens de propósito: o tenant B não tem `channel_session`, e criar uma
 * seria inventar um número de WhatsApp que não existe.
 */
async function ensurePegadaLgpd(
  orgId: string,
  pipelineId: string,
  stageId: string,
): Promise<{ contactId: string; leadId: string; activityId: string; requestId: string }> {
  const NOME_B = "Titular Descartavel Tenant B";
  const TEL_B = "+5511960009999";

  const { data: cExist, error: cErr } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("phone_number", TEL_B)
    .maybeSingle();
  if (cErr) throw new Error(`buscar contato B: ${cErr.message}`);
  const contatoLinha = {
    organization_id: orgId,
    name: NOME_B,
    display_name: NOME_B,
    email: "titular.b@descartavel.test",
    phone_number: TEL_B,
    source: "manual",
    is_anonymized: false,
    anonymized_at: null,
  };
  let contactId: string;
  if (cExist) {
    contactId = (cExist as { id: string }).id;
    const { error } = await admin.from("contacts").update(contatoLinha as never).eq("id", contactId);
    if (error) throw new Error(`atualizar contato B: ${error.message}`);
  } else {
    const { data, error } = await admin.from("contacts").insert(contatoLinha as never).select("id").single();
    if (error || !data) throw new Error(`criar contato B: ${error?.message}`);
    contactId = (data as { id: string }).id;
  }

  const { data: lExist, error: lErr } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", orgId)
    .eq("title", "Ensaio LGPD — tenant B")
    .maybeSingle();
  if (lErr) throw new Error(`buscar lead B: ${lErr.message}`);
  let leadId: string;
  const leadLinha = {
    organization_id: orgId,
    pipeline_id: pipelineId,
    stage_id: stageId,
    contact_id: contactId,
    title: "Ensaio LGPD — tenant B",
    status: "open",
    source: "manual",
    value_cents: 50_000,
    currency: "MZN",
    position_in_stage: 2000,
    last_activity_at: new Date().toISOString(),
  };
  if (lExist) {
    leadId = (lExist as { id: string }).id;
    const { error } = await admin.from("crm_leads").update(leadLinha as never).eq("id", leadId);
    if (error) throw new Error(`atualizar lead B: ${error.message}`);
  } else {
    const { data, error } = await admin.from("crm_leads").insert(leadLinha as never).select("id").single();
    if (error || !data) throw new Error(`criar lead B: ${error?.message}`);
    leadId = (data as { id: string }).id;
  }

  const atividadeLinha = {
    organization_id: orgId,
    lead_id: leadId,
    contact_id: contactId,
    source_module: "ai",
    type: "ai_turn",
    actor_kind: "ai",
    reason: `Titular ${NOME_B} confirmou o telefone ${TEL_B}.`,
    evidence: { trace_ids: ["trace_b_001"], run_ids: ["run_b_001"] },
    payload: { resumo: `${NOME_B} pediu retorno`, telefone: TEL_B },
    metadata: { canal: "whatsapp" },
  };
  const { data: aExist, error: aErr } = await admin
    .from("crm_lead_activities")
    .select("id")
    .eq("lead_id", leadId)
    .eq("type", "ai_turn")
    .maybeSingle();
  if (aErr) throw new Error(`buscar atividade B: ${aErr.message}`);
  let activityId: string;
  if (aExist) {
    activityId = (aExist as { id: string }).id;
    const { error } = await admin
      .from("crm_lead_activities")
      .update(atividadeLinha as never)
      .eq("id", activityId);
    if (error) throw new Error(`atualizar atividade B: ${error.message}`);
  } else {
    const { data, error } = await admin
      .from("crm_lead_activities")
      .insert(atividadeLinha as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`criar atividade B: ${error?.message}`);
    activityId = (data as { id: string }).id;
  }

  // store_redact: o ÚNICO tipo que a UI conhece hoje. Aqui é seguro porque o
  // tenant é descartável e só tem este titular.
  const reqLinha = {
    organization_id: orgId,
    request_type: "store_redact",
    source: "manual",
    scope: "tenant",
    status: "received",
    received_at: new Date().toISOString(),
    due_at: new Date(Date.now() + 15 * 24 * 3600_000).toISOString(),
  };
  const { data: rExist, error: rErr } = await admin
    .from("lgpd_requests")
    .select("id")
    .eq("organization_id", orgId)
    .eq("request_type", "store_redact")
    .maybeSingle();
  if (rErr) throw new Error(`buscar request B: ${rErr.message}`);
  let requestId: string;
  if (rExist) {
    requestId = (rExist as { id: string }).id;
    const { error } = await admin.from("lgpd_requests").update(reqLinha as never).eq("id", requestId);
    if (error) throw new Error(`atualizar request B: ${error.message}`);
  } else {
    const { data, error } = await admin.from("lgpd_requests").insert(reqLinha as never).select("id").single();
    if (error || !data) throw new Error(`criar request B: ${error?.message}`);
    requestId = (data as { id: string }).id;
  }

  return { contactId, leadId, activityId, requestId };
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Record<string, unknown>;
  const orgId = await ensureOrg();
  const userId = await ensureUser();
  await ensureMembership(userId, orgId);
  const { pipelineId, leadId } = await ensureBoard(orgId);

  const { data: stageB } = await admin
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", pipelineId)
    .order("position")
    .limit(1)
    .maybeSingle();
  const pegada = await ensurePegadaLgpd(orgId, pipelineId, (stageB as { id: string }).id);
  const anterior = (creds.tenant_b as { totp?: { factor_id: string; secret: string } } | undefined)?.totp ?? null;
  const totp = await ensureTotp(userId, anterior);

  creds.tenant_b = {
    org_id: orgId,
    org_slug: ORG_SLUG,
    user_id: userId,
    email: EMAIL,
    password: PASSWORD,
    pipeline_id: pipelineId,
    lead_id: leadId,
    lead_title: LEAD_TITLE,
    role: "admin",
    totp,
    lgpd: pegada,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  console.info(`\n✅ Tenant B pronto: org=${orgId} pipeline=${pipelineId}`);
  console.info(`   login: ${EMAIL} / ${PASSWORD}`);
}

main().catch((err) => {
  console.error("❌ Seed do tenant B falhou:", err);
  process.exit(1);
});
