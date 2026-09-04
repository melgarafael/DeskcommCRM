/**
 * Seed E2E do GATE DE ELEGIBILIDADE DA IA (J20) — fixtures que as três specs
 * compartilham:
 *
 *   tests/e2e/j20-elegibilidade-respondi.spec.ts           (J20.6)
 *   tests/e2e/j20-elegibilidade-followup.spec.ts           (J20.12)
 *   tests/e2e/j20-elegibilidade-atendimento-manual.spec.ts (J20.18)
 *
 * O que cria (idempotente por nome/label/session_name únicos, service role,
 * grava o bloco `elegibilidade` em .e2e-creds.json — mesmo padrão de
 * scripts/seed-e2e-followup-agent.ts):
 *
 *   1. `channel_sessions` "e2e-elegibilidade-session" com
 *      `metadata.ai_gate = 'allowlist'` — o CANAL onde o gate está LIGADO.
 *      É o único lugar em que as specs escrevem `ai_gate`: nenhum contato é
 *      autorizado em massa. `status='WORKING'`, warmup completo.
 *   2. `ai_provider_credentials` validada (bytea placeholder — nunca decifrada
 *      nos caminhos que a suíte exercita; `validated_at` só destrava o publish
 *      do agente, igual ao `prepare-agent-fixtures` do followup-journey).
 *   3. `webhook_sources` (kind lead_capture) apontando para o 1º funil da org —
 *      a URL onde J20.6 posta a submissão do Respondi.
 *
 * NÃO cria agente nem fluxo de follow-up: cada spec publica o seu pela API
 * REAL depois do login (é o caminho de produção; ver followup-journey.spec.ts).
 *
 * Run: npx tsx scripts/seed-e2e-elegibilidade.ts
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-elegibilidade", credenciais);

const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

const SESSION_NAME = "e2e-elegibilidade-session";
const CREDENTIAL_LABEL = "E2E Elegibilidade — credencial";
const SOURCE_NAME = "E2E Elegibilidade — captação Respondi";

interface Creds {
  org_id: string;
  elegibilidade?: {
    channel_session_id: string;
    waha_path_token: string;
    credential_id: string;
    pipeline_id: string;
    stage_id: string;
    webhook_source_id: string;
    webhook_source_token: string;
  };
}

async function primeiroFunil(orgId: string): Promise<{ pipelineId: string; stageId: string }> {
  const { data, error } = await admin
    .from("crm_pipelines")
    .select("id, crm_stages(id, position)")
    .eq("organization_id", orgId)
    .eq("is_archived", false)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`crm_pipelines: ${error.message}`);
  const pipelineId = (data as { id: string } | null)?.id;
  const stages = ((data as { crm_stages?: Array<{ id: string; position: number }> } | null)
    ?.crm_stages ?? []).slice().sort((a, b) => a.position - b.position);
  const stageId = stages[0]?.id;
  if (!pipelineId || !stageId) {
    throw new Error(
      "A org de teste não tem funil com etapa. Rode antes: npx tsx scripts/seed-e2e-funis.ts",
    );
  }
  return { pipelineId, stageId };
}

async function ensureChannelSession(orgId: string): Promise<{ id: string; token: string }> {
  const { data: existing, error: selErr } = await admin
    .from("channel_sessions")
    .select("id, webhook_path_token, metadata")
    .eq("organization_id", orgId)
    .eq("waha_session_name", SESSION_NAME)
    .maybeSingle();
  if (selErr) throw new Error(`channel_sessions select: ${selErr.message}`);

  if (existing) {
    const row = existing as { id: string; webhook_path_token: string; metadata: Record<string, unknown> };
    // Auto-cura: garante que o gate está LIGADO e a sessão WORKING (uma corrida
    // anterior pode ter deixado noutro estado).
    await admin
      .from("channel_sessions")
      .update({
        status: "WORKING",
        metadata: { ...(row.metadata ?? {}), ai_gate: "allowlist" },
      })
      .eq("id", row.id);
    return { id: row.id, token: row.webhook_path_token };
  }

  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: orgId,
      waha_session_name: SESSION_NAME,
      display_name: "Número Elegibilidade E2E",
      status: "WORKING",
      warmup_completed_at: new Date().toISOString(),
      webhook_secret_encrypted: "\\x00",
      metadata: { ai_gate: "allowlist" },
    } as never)
    .select("id, webhook_path_token")
    .single();
  if (error || !data) throw new Error(`channel_sessions insert: ${error?.message}`);
  const row = data as { id: string; webhook_path_token: string };
  return { id: row.id, token: row.webhook_path_token };
}

async function ensureCredential(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", orgId)
    .eq("label", CREDENTIAL_LABEL)
    .maybeSingle();
  if (existing) {
    await admin
      .from("ai_provider_credentials")
      .update({ validated_at: new Date().toISOString(), is_active: true })
      .eq("id", (existing as { id: string }).id);
    return (existing as { id: string }).id;
  }

  const { data, error } = await admin
    .from("ai_provider_credentials")
    .insert({
      organization_id: orgId,
      provider: "anthropic",
      label: CREDENTIAL_LABEL,
      api_key_encrypted: "\\x00",
      api_key_iv: "\\x00",
      api_key_tag: "\\x00",
      api_key_last4: "e2e1",
      is_active: true,
      validated_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`ai_provider_credentials insert: ${error?.message}`);
  return (data as { id: string }).id;
}

async function ensureWebhookSource(
  orgId: string,
  pipelineId: string,
  stageId: string,
): Promise<{ id: string; token: string }> {
  const { data: existing } = await admin
    .from("webhook_sources")
    .select("id, path_token")
    .eq("organization_id", orgId)
    .eq("name", SOURCE_NAME)
    .maybeSingle();
  if (existing) {
    const row = existing as { id: string; path_token: string };
    return { id: row.id, token: row.path_token };
  }

  const token = randomUUID().replace(/-/g, "");
  const { data, error } = await admin
    .from("webhook_sources")
    .insert({
      organization_id: orgId,
      name: SOURCE_NAME,
      path_token: token,
      kind: "lead_capture",
      default_pipeline_id: pipelineId,
      default_stage_id: stageId,
      field_map: {},
      is_active: true,
    } as never)
    .select("id, path_token")
    .single();
  if (error || !data) throw new Error(`webhook_sources insert: ${error?.message}`);
  const row = data as { id: string; path_token: string };
  return { id: row.id, token: row.path_token };
}

async function main(): Promise<void> {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(
      "Falta .e2e-creds.json — rode antes: npx tsx scripts/seed-e2e-credentials.ts",
    );
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const orgId = creds.org_id;
  if (!orgId) throw new Error(".e2e-creds.json sem org_id — re-rode seed-e2e-credentials.ts");

  const { pipelineId, stageId } = await primeiroFunil(orgId);
  const session = await ensureChannelSession(orgId);
  const credentialId = await ensureCredential(orgId);
  const source = await ensureWebhookSource(orgId, pipelineId, stageId);

  creds.elegibilidade = {
    channel_session_id: session.id,
    waha_path_token: session.token,
    credential_id: credentialId,
    pipeline_id: pipelineId,
    stage_id: stageId,
    webhook_source_id: source.id,
    webhook_source_token: source.token,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));

  console.info(
    `\n✅ Seed elegibilidade completo.\n` +
      `   channel_session=${session.id} (ai_gate=allowlist, token=${session.token})\n` +
      `   credential=${credentialId}\n` +
      `   webhook_source=${source.id} (token=${source.token})`,
  );
}

main().catch((err) => {
  console.error("❌ Seed elegibilidade falhou:", err instanceof Error ? err.message : err);
  process.exit(1);
});
