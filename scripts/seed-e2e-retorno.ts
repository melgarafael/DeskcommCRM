/**
 * Seed E2E do RETORNO AGENDADO (IA 360 · wave 2).
 *
 * ⚠️ O AGENDAMENTO NÃO É INSERT À MÃO. O script chama a CAPACIDADE REAL
 * (`crm_schedule_followup`, o handler que o agente configurado na tela executa),
 * com um contexto de agente de verdade. Um INSERT em `cron_jobs` provaria que o
 * banco aceita uma linha que EU montei; o que a jornada precisa provar é que a
 * capacidade que o dono liga faz o retorno existir — inclusive a atividade que
 * ela emite na timeline, que um INSERT não emitiria.
 *
 * Estado deixado no banco:
 *   - contato + conversa + negócio ABERTO, frio (última atividade há 5 dias);
 *   - um agente de IA (dono do negócio, para o Radar mostrar autoria);
 *   - UM retorno agendado por esse agente, para daqui a 2 dias.
 *
 * Idempotente e auto-reset: apaga os retornos anteriores deste contato antes de
 * agendar, para o teste de cancelar poder rodar de novo.
 *
 * Run: npx tsx scripts/seed-e2e-retorno.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import type { McpContext } from "../lib/mcp/types";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

// `process.env` VENCE o `.env.local` (ver scripts/lib/env-de-teste.ts).
//
// A versão anterior lia `.env.local` DIRETO do disco, ignorando o ambiente — e
// por isso a suíte E2E semeava no banco de PRODUÇÃO mesmo com o `.env.e2e`
// injetado no webServer do Playwright: este script nunca olhava para lá.
const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-retorno", credenciais);
const env = {
  NEXT_PUBLIC_SUPABASE_URL: credenciais.url,
  SUPABASE_SERVICE_ROLE_KEY: credenciais.serviceRole,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: credenciais.anonKey,
  NEXT_PUBLIC_APP_URL: credenciais.appUrl,
  SUPABASE_DB_URL: credenciais.dbUrl,
} as Record<string, string>;
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY em .env.local");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const LEAD_TITLE = "Demanda E2E do retorno";
const CONTACT_NAME = "Cliente Retorno E2E";
const AGENT_NAME = "Agente Retorno E2E";
const MOTIVO = "reconfirmar a proposta que o cliente pediu para pensar";

interface Creds {
  org_id: string;
  retorno?: unknown;
}

async function ensureAgent(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", AGENT_NAME)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await admin
    .from("ai_agents")
    .insert({
      organization_id: orgId,
      name: AGENT_NAME,
      system_prompt: "Agente de teste da jornada de retorno.",
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert ai_agent: ${error?.message}`);
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

async function ensureLead(
  orgId: string,
  contactId: string,
  agentId: string,
): Promise<{ leadId: string; pipelineId: string }> {
  const { data: pipeline } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_archived", false)
    .order("is_default", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!pipeline) throw new Error("org sem funil — rode scripts/seed-e2e-credentials.ts antes");
  const pipelineId = (pipeline as { id: string }).id;

  const { data: stage } = await admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!stage) throw new Error("funil sem etapa aberta");

  // Frio: cinco dias sem movimento. É o que põe o negócio no Radar.
  const cincoDiasAtras = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const campos = {
    organization_id: orgId,
    pipeline_id: pipelineId,
    stage_id: (stage as { id: string }).id,
    contact_id: contactId,
    title: LEAD_TITLE,
    status: "open",
    owner_kind: "ai",
    owner_agent_id: agentId,
    owner_user_id: null,
    last_activity_at: cincoDiasAtras,
  };

  const { data: existing } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", orgId)
    .eq("title", LEAD_TITLE)
    .maybeSingle();
  if (existing) {
    const id = (existing as { id: string }).id;
    await admin.from("crm_leads").update(campos as never).eq("id", id);
    return { leadId: id, pipelineId };
  }
  const { data, error } = await admin
    .from("crm_leads")
    .insert(campos as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert crm_lead: ${error?.message}`);
  return { leadId: (data as { id: string }).id, pipelineId };
}

async function main(): Promise<void> {
  const { crmScheduleFollowup } = await import("../lib/mcp/tools/retencao");
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const orgId = creds.org_id;

  const agentId = await ensureAgent(orgId);
  const contactId = await ensureContact(orgId);
  const { leadId, pipelineId } = await ensureLead(orgId, contactId, agentId);

  // Auto-reset: o teste da tela CANCELA o retorno, então cada execução precisa
  // encontrar exatamente um retorno agendado — não o cancelado da rodada anterior.
  await admin.from("cron_jobs").delete().eq("organization_id", orgId).eq("contact_id", contactId);
  await admin
    .from("crm_lead_activities")
    .delete()
    .eq("organization_id", orgId)
    .eq("lead_id", leadId)
    .in("type", ["followup_scheduled", "followup_cancelled"]);

  const ctx: McpContext = {
    organizationId: orgId,
    role: "agent",
    actor: { type: "ai_agent", id: agentId, agent_id: agentId, role: "agent" },
    // UUID de verdade: `api_audit_log.actor_api_token_id` é uuid, e um rótulo
    // legível ali faria o audit da capacidade falhar em silêncio no seed —
    // escondendo justamente o caminho que este script existe para exercitar.
    apiTokenId: "00000000-0000-4000-8000-e2e000000000",
    requestId: `seed-retorno-${Date.now()}`,
    supabase: admin,
  };

  const daquiADoisDias = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const resultado = (await crmScheduleFollowup.handler(
    {
      lead_id: leadId,
      contact_id: undefined,
      promised_at: daquiADoisDias,
      in_hours: undefined,
      reason: MOTIVO,
      promise: "volto a falar com você depois de amanhã",
      context: undefined,
    },
    ctx,
  )) as { agendado: boolean; retorno_id?: string; quando?: string; mensagem?: string };

  if (!resultado.agendado) {
    throw new Error(`a capacidade recusou o agendamento: ${JSON.stringify(resultado)}`);
  }

  const bloco = {
    lead_id: leadId,
    lead_title: LEAD_TITLE,
    pipeline_id: pipelineId,
    contact_id: contactId,
    contact_name: CONTACT_NAME,
    agent_id: agentId,
    agent_name: AGENT_NAME,
    retorno_id: resultado.retorno_id,
    quando: resultado.quando,
    motivo: MOTIVO,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify({ ...creds, retorno: bloco }, null, 2));
  console.info(`[seed-e2e-retorno] ${JSON.stringify(bloco)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
