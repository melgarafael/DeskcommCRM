/**
 * Caso de anonimização LGPD para prova NA TELA (não no RPC).
 *
 * Monta um titular com rastro em todas as superfícies que o cascade tem de
 * varrer — e, de propósito, com dados que **NÃO podem sumir**:
 *
 *   DEVE SUMIR                          DEVE SOBREVIVER
 *   contato: nome, e-mail, telefone     activity.actor_kind (fato de auditoria)
 *   mensagens: body, metadata           activity.evidence (só ids, não é PII)
 *   activity.payload / metadata         timestamps (histórico preservado)
 *   activity.reason (texto de LLM)
 *
 * Um redact que apaga demais é tão errado quanto um que apaga de menos, e só o
 * teste dos DOIS lados pega isso.
 *
 * Idempotente: upsert por e-mail do contato. Grava `lgpd` em .e2e-creds.json.
 *
 * Run: npx tsx scripts/seed-e2e-lgpd.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

// `process.env` VENCE o `.env.local` (ver scripts/lib/env-de-teste.ts).
//
// A versão anterior lia `.env.local` DIRETO do disco, ignorando o ambiente — e
// por isso a suíte E2E semeava no banco de PRODUÇÃO mesmo com o `.env.e2e`
// injetado no webServer do Playwright: este script nunca olhava para lá.
const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-lgpd", credenciais);
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
const NOME = "Ana Souza LGPD E2E";
const EMAIL = "ana.souza.lgpd@titular.test";
const TELEFONE = "+5511970001234";
const LEAD_TITLE = "Titular LGPD E2E — pedido de anonimizacao";

/** `reason` é texto livre escrito por LLM: pode carregar PII e por isso tem de sumir. */
const REASON_COM_PII =
  "Cliente Ana Souza confirmou o telefone +5511970001234 e pediu retorno no e-mail dela.";
/** `evidence` guarda só ponteiros — decisão do regente: não é PII, tem de sobreviver. */
const EVIDENCE_SEM_PII = { trace_ids: ["trace_abc123"], run_ids: ["run_def456"] };

async function upsert<T extends Record<string, unknown>>(
  tabela: string,
  busca: Record<string, unknown>,
  linha: T,
): Promise<string> {
  let q = admin.from(tabela).select("id");
  for (const [k, v] of Object.entries(busca)) q = q.eq(k, v as never);
  const { data: existente, error: selErr } = await q.maybeSingle();
  if (selErr) throw new Error(`buscar ${tabela}: ${selErr.message}`);
  if (existente) {
    const id = (existente as { id: string }).id;
    const { error } = await admin.from(tabela).update(linha as never).eq("id", id);
    if (error) throw new Error(`atualizar ${tabela}: ${error.message}`);
    return id;
  }
  const { data, error } = await admin
    .from(tabela)
    .insert(linha as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`inserir ${tabela}: ${error?.message}`);
  return (data as { id: string }).id;
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Record<string, unknown>;
  const orgId = creds.org_id as string;
  const crmVivo = creds.crm_vivo as { pipeline_id: string; stage_ids: Record<string, string> };
  const stageId = Object.values(crmVivo.stage_ids)[0]!;

  const contactId = await upsert(
    "contacts",
    // chave por telefone: é o identificador canônico de contato e tem unique própria
    { organization_id: orgId, phone_number: TELEFONE },
    {
      organization_id: orgId,
      name: NOME,
      display_name: NOME,
      email: EMAIL,
      phone_number: TELEFONE,
      source: "manual",
      is_anonymized: false,
      anonymized_at: null,
    },
  );

  // conversations.channel_session_id é NOT NULL: reusar a sessão que a org já tem
  // (criar outra inventaria um número de WhatsApp que não existe).
  const { data: sessao, error: sErr } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .limit(1)
    .maybeSingle();
  if (sErr) throw new Error(`buscar channel_session: ${sErr.message}`);
  if (!sessao) throw new Error("org sem channel_session — rode o seed de credenciais antes");

  const conversationId = await upsert(
    "conversations",
    { organization_id: orgId, contact_id: contactId },
    {
      organization_id: orgId,
      contact_id: contactId,
      channel_session_id: (sessao as { id: string }).id,
      status: "open",
      channel: "whatsapp",
    },
  );

  const mensagens = [
    { external_id: "lgpd-e2e-1", body: `Oi, aqui é a ${NOME}, meu telefone é ${TELEFONE}`, direction: "inbound" },
    { external_id: "lgpd-e2e-2", body: "Pode me mandar o orçamento no meu e-mail?", direction: "inbound" },
    { external_id: "lgpd-e2e-3", body: "Claro, Ana! Enviando agora.", direction: "outbound" },
  ];
  const messageIds: string[] = [];
  for (const m of mensagens) {
    messageIds.push(
      await upsert(
        "messages",
        { organization_id: orgId, external_id: m.external_id },
        {
          organization_id: orgId,
          conversation_id: conversationId,
          channel_session_id: (sessao as { id: string }).id,
          contact_id: contactId,
          external_id: m.external_id,
          type: "text",
          body: m.body,
          direction: m.direction,
          status: "delivered",
          sent_at: new Date().toISOString(),
          metadata: { origem: "seed-lgpd", telefone_bruto: TELEFONE },
        },
      ),
    );
  }

  const leadId = await upsert(
    "crm_leads",
    { organization_id: orgId, title: LEAD_TITLE },
    {
      organization_id: orgId,
      pipeline_id: crmVivo.pipeline_id,
      stage_id: stageId,
      contact_id: contactId,
      title: LEAD_TITLE,
      status: "open",
      source: "manual",
      value_cents: 250_000,
      currency: "MZN",
      position_in_stage: 9000,
      last_activity_at: new Date().toISOString(),
    },
  );

  // Atividade da IA: tem reason com PII (deve sumir) E evidence com ids (deve ficar).
  const atividadeIa = await upsert(
    "crm_lead_activities",
    { organization_id: orgId, lead_id: leadId, type: "ai_turn" },
    {
      organization_id: orgId,
      lead_id: leadId,
      contact_id: contactId,
      source_module: "ai",
      type: "ai_turn",
      actor_kind: "ai",
      reason: REASON_COM_PII,
      evidence: EVIDENCE_SEM_PII,
      payload: { resumo: `${NOME} pediu orçamento`, telefone: TELEFONE },
      metadata: { canal: "whatsapp", contato: EMAIL },
    },
  );

  // Atividade humana: sem reason, para provar que o cascade não inventa dado.
  const atividadeHumana = await upsert(
    "crm_lead_activities",
    { organization_id: orgId, lead_id: leadId, type: "note" },
    {
      organization_id: orgId,
      lead_id: leadId,
      contact_id: contactId,
      source_module: "crm",
      type: "note",
      actor_kind: "user",
      reason: null,
      evidence: { trace_ids: [] },
      payload: { nota: `Falei com ${NOME} por telefone` },
      metadata: { origem: "seed-lgpd" },
    },
  );

  const requestId = await upsert(
    "lgpd_requests",
    { organization_id: orgId, contact_id: contactId, request_type: "redact" },
    {
      organization_id: orgId,
      contact_id: contactId,
      // O CHECK do banco aceita data_request | redact | store_redact. A UI fala
      // em "customer_redact" — divergência anotada para verificação separada.
      request_type: "redact",
      source: "manual",
      scope: "contact",
      status: "received",
      received_at: new Date().toISOString(),
      due_at: new Date(Date.now() + 15 * 24 * 3600_000).toISOString(),
    },
  );

  creds.lgpd = {
    contact_id: contactId,
    contact_name: NOME,
    contact_email: EMAIL,
    contact_phone: TELEFONE,
    conversation_id: conversationId,
    message_ids: messageIds,
    lead_id: leadId,
    lead_title: LEAD_TITLE,
    activity_ai_id: atividadeIa,
    activity_user_id: atividadeHumana,
    request_id: requestId,
    reason_com_pii: REASON_COM_PII,
    evidence_sem_pii: EVIDENCE_SEM_PII,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));

  console.info(`✅ Caso LGPD pronto:`);
  console.info(`   contato   ${contactId} (${NOME})`);
  console.info(`   conversa  ${conversationId} com ${messageIds.length} mensagens`);
  console.info(`   lead      ${leadId} com 2 atividades (ai + user)`);
  console.info(`   request   ${requestId} status=received  → /app/lgpd/requests/${requestId}`);
}

main().catch((err) => {
  console.error("❌ Seed LGPD falhou:", err);
  process.exit(1);
});
