/**
 * Provoca UM turno real do agente de IA pelo caminho de produção, para que a
 * cadeia `before_send` grave linhas em `before_send_traces`.
 *
 * Por que existe: a tabela exige `job_id` de `job_queue` — envio manual pelo
 * inbox NÃO gera trace. O baseline de gates do plano de canais
 * (`docs/superpowers/plans/2026-07-27-canais-seam-fases-0-2.md`, Task 0 Step 5)
 * seria um CSV só com header sem isto, e um CSV vazio passa em qualquer `diff`.
 *
 * O que faz: POST no webhook per-tenant do WAHA (mesma rota que o WAHA de
 * verdade chama) com um inbound de texto. A ingestão cria contato/conversa/
 * mensagem e emite `ai_agent.dispatch_requested`; o worker (`pnpm worker`)
 * drena o evento, enfileira `inbound_turn` e roda o turno.
 *
 * Uso (app já servida; worker rodando em paralelo):
 *   pnpm exec tsx --env-file=.env.local scripts/provoke-agent-turn.ts \
 *     [--text "..."] [--session <waha_session_name>] [--app-url http://localhost:3002]
 *
 * O `--env-file` não é opcional: `lib/crypto/aes_gcm` importa `lib/env`, que
 * valida o ambiente do PROCESSO (o parser de .env.local daqui alimenta só este
 * script).
 */

import { createClient } from "@supabase/supabase-js";

import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

const env = carregarEnvLocal();

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const APP_URL = arg("app-url", env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3002");
const SESSION_NAME = arg("session", "e2e-radar-session");
const TEXT = arg("text", "Oi! Vi o anuncio de voces. Quanto custa e como funciona a entrega?");
const FROM = arg("from", "5531988887777");

/**
 * Garante uma credencial BYOK REAL para a org.
 *
 * Sem isto o turno morre com `Invalid authentication tag length: 1`: os seeds de
 * e2e criam `ai_provider_credentials` com bytea placeholder (`\x00`) e um dos
 * specs marca `validated_at` — a resolução de credencial prefere a BYOK mais
 * recente ativa+validada e tenta decifrar o placeholder. Inserimos uma linha NOVA
 * (não mexemos na fixture alheia): mais recente vence o `order by created_at desc`.
 */
async function ensureRealCredential(orgId: string): Promise<void> {
  // Sem ANTHROPIC_API_KEY, a chave da OpenRouter vira a credencial da org: é por
  // ela que a avaliação da parada roda (docs/runbooks/parada-apos-envio.md), e o
  // agente publicado com `provider = 'openrouter'` a acha por provedor.
  const provider = env.ANTHROPIC_API_KEY ? "anthropic" : "openrouter";
  const key = env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY;
  if (!key) {
    // Provedor direto: as credenciais foram cadastradas pela tela (IA › Provedores)
    // e o turno as acha por provedor — nenhuma chave passa por aqui.
    const { data: daOrg } = await admin
      .from("ai_provider_credentials")
      .select("provider, api_key_last4")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .not("validated_at", "is", null);
    const lista = (daOrg ?? []) as Array<{ provider: string; api_key_last4: string | null }>;
    if (lista.length > 0) {
      console.info(`[provoke] sem chave no ambiente: o turno usa as credenciais da organização (${lista.map((c) => `${c.provider} …${c.api_key_last4 ?? "?"}`).join(", ")})`);
      return;
    }
    throw new Error("ANTHROPIC_API_KEY e OPENROUTER_API_KEY ausentes e a organização sem credencial ativa e validada — sem uma delas não há turno real");
  }
  const label =
    provider === "anthropic" ? "Baseline Canais (chave real de plataforma)" : "Baseline Canais (chave real OpenRouter)";
  const { data: existing } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", orgId)
    .eq("label", label)
    .maybeSingle();
  if (existing) {
    console.log(`[provoke] credencial real já existe: ${(existing as { id: string }).id}`);
    return;
  }
  const enc = encryptKey(key);
  const { data, error } = await admin
    .from("ai_provider_credentials")
    .insert({
      organization_id: orgId,
      provider,
      label,
      api_key_encrypted: bufToBytea(enc.ciphertext),
      api_key_iv: bufToBytea(enc.iv),
      api_key_tag: bufToBytea(enc.tag),
      api_key_last4: key.slice(-4),
      is_active: true,
      validated_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert ai_provider_credentials: ${error?.message}`);
  console.log(`[provoke] credencial real criada: ${(data as { id: string }).id}`);
}

/**
 * `organizations.settings.llm.default_model` — sem ele o turno morre com
 * "modelo LLM não definido". Numa instalação real quem preenche é a tela de
 * setup de IA; num banco fresco de baseline, preenchemos aqui.
 */
async function ensureDefaultModel(orgId: string): Promise<void> {
  const { data: org, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .single();
  if (error || !org) throw new Error(`select organizations: ${error?.message}`);
  const settings = ((org as { settings: Record<string, unknown> | null }).settings ?? {}) as Record<
    string,
    unknown
  >;
  const llm = (settings.llm ?? {}) as Record<string, unknown>;
  if (typeof llm.default_model === "string" && llm.default_model.length > 0) {
    console.log(`[provoke] default_model já definido: ${llm.default_model}`);
    return;
  }
  const model = arg("model", "claude-sonnet-4-5");
  const next = { ...settings, llm: { ...llm, provider: "anthropic", default_model: model } };
  const { error: upErr } = await admin
    .from("organizations")
    .update({ settings: next } as never)
    .eq("id", orgId);
  if (upErr) throw new Error(`update organizations.settings: ${upErr.message}`);
  console.log(`[provoke] default_model definido: ${model}`);
}

async function main(): Promise<void> {
  const { data: session, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, waha_session_name, webhook_path_token")
    .eq("waha_session_name", SESSION_NAME)
    .maybeSingle();
  if (error || !session) throw new Error(`channel_session '${SESSION_NAME}' não encontrada: ${error?.message}`);

  const s = session as {
    id: string;
    organization_id: string;
    waha_session_name: string;
    webhook_path_token: string;
  };

  await ensureRealCredential(s.organization_id);
  await ensureDefaultModel(s.organization_id);

  const externalId = `false_${FROM}@c.us_BASELINE${Date.now()}`;
  const body = {
    event: "message",
    session: s.waha_session_name,
    payload: {
      id: externalId,
      from: `${FROM}@c.us`,
      to: "5531999990000@c.us",
      fromMe: false,
      body: TEXT,
      type: "chat",
      hasMedia: false,
      timestamp: Math.floor(Date.now() / 1000),
      _data: { notifyName: "Lead Baseline Canais" },
    },
  };

  const url = `${APP_URL}/api/v1/webhooks/waha/${s.webhook_path_token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`[provoke] POST ${url} → ${res.status} ${text.slice(0, 200)}`);
  if (!res.ok) process.exit(1);

  // Prova que a ingestão andou: a mensagem existe e o evento de dispatch nasceu.
  for (let i = 0; i < 20; i++) {
    const { data: ev } = await admin
      .from("event_log")
      .select("id, event_type, status")
      .eq("organization_id", s.organization_id)
      .eq("event_type", "ai_agent.dispatch_requested")
      .order("created_at", { ascending: false })
      .limit(1);
    if (ev && ev.length > 0) {
      console.log(`[provoke] dispatch_requested emitido: ${JSON.stringify(ev[0])}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("ai_agent.dispatch_requested não apareceu no event_log em 10s");
}

main().catch((err) => {
  console.error("[provoke] falhou:", err);
  process.exit(1);
});
