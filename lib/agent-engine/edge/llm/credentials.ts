/**
 * Config LLM por org, pós-fusão (PORT-NOTES): a credencial BYOK vive em
 * `ai_provider_credentials` do CRM (AES-256-GCM via lib/crypto/aes_gcm — colunas
 * api_key_encrypted/api_key_iv/api_key_tag) e os knobs de modelo/params/teto vivem
 * em `organizations.settings->'llm'`. Sem BYOK, o fallback é a chave de plataforma
 * do env (ANTHROPIC_API_KEY) — só para provider anthropic. O plaintext da chave
 * existe apenas em memória do processo no instante da chamada; nunca em log.
 *
 * A config é lida do DB A CADA chamada (resolveOrgLlmConfig) — trocar modelo/
 * provider/teto é UPDATE na config, sem restart nem deploy.
 */
import type pg from 'pg';
import { z } from 'zod';

import { byteaToBuffer, decryptKey } from '@/lib/crypto/aes_gcm';
import type { CacheTtl } from './stable-prefix';

/** Config da camada LLM montada do env validado (padrão crmEdgeConfigFromEnv). */
export interface LlmEdgeConfig {
  /** chave de plataforma (fallback quando a org não tem BYOK). Opcional no boot. */
  anthropicApiKey?: string;
  /**
   * TTL do prefixo estável de cache (knob LLM_CACHE_TTL). Opcional para quem
   * monta a config na mão (testes) — o seam aplica a doutrina '1h' quando ausente.
   */
  cacheTtl?: CacheTtl;
}

export function llmEdgeConfigFromEnv(env: {
  ANTHROPIC_API_KEY?: string;
  LLM_CACHE_TTL?: string;
}): LlmEdgeConfig {
  const ttl = env.LLM_CACHE_TTL ?? '1h';
  if (ttl !== '5m' && ttl !== '1h') {
    throw new Error("LLM_CACHE_TTL inválido — use '5m' ou '1h' (default 1h)");
  }
  return {
    ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
    cacheTtl: ttl,
  };
}

/** Org sem credencial LLM utilizável — erro tipado, mensagem sem valores (credencial fora). */
export class LlmNotConfiguredError extends Error {
  override readonly name = 'llm_not_configured';
  constructor() {
    super(
      'org sem credencial LLM utilizável — cadastre uma chave BYOK ativa/validada em ai_provider_credentials ou defina ANTHROPIC_API_KEY (fallback de plataforma, só provider anthropic)',
    );
  }
}

export interface OrgLlmConfig {
  provider: string;
  /** plaintext decifrado — existe só em memória, jamais logado/persistido */
  apiKey: string;
  defaultModel: string | null;
  params: Record<string, unknown>;
  enabledModels: string[];
  monthlyBudgetCents: number | null;
}

// Leitura DEFENSIVA de organizations.settings->'llm' (jsonb livre): campo com
// shape errado cai no default, nunca derruba o turno.
const llmSettingsSchema = z
  .object({
    provider: z.string().min(1).catch('anthropic'),
    default_model: z.string().min(1).nullable().catch(null),
    params: z.record(z.unknown()).catch({}),
    enabled_models: z.array(z.string()).catch([]),
    monthly_budget_cents: z.number().finite().nullable().catch(null),
  })
  .passthrough()
  .catch({
    provider: 'anthropic',
    default_model: null,
    params: {},
    enabled_models: [],
    monthly_budget_cents: null,
  });

/**
 * Resolve a config LLM da org: knobs de organizations.settings->'llm' + credencial
 * BYOK mais recente ativa/validada de ai_provider_credentials (decifrada com
 * aes_gcm). Sem BYOK → fallback cfg.anthropicApiKey (só anthropic). Sem nada →
 * LlmNotConfiguredError. Chamada a cada run — troca de config vale no run seguinte.
 */
export async function resolveOrgLlmConfig(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  organizationId: string,
): Promise<OrgLlmConfig> {
  const { rows } = await db.query<{ llm: unknown }>(
    `select settings->'llm' as llm from organizations where id = $1`,
    [organizationId],
  );
  if (rows.length === 0) {
    throw new Error('organização inexistente ao resolver config LLM');
  }
  const settings = llmSettingsSchema.parse(rows[0]?.llm ?? {});

  const { rows: credRows } = await db.query<{
    api_key_encrypted: unknown;
    api_key_iv: unknown;
    api_key_tag: unknown;
  }>(
    `select api_key_encrypted, api_key_iv, api_key_tag
     from ai_provider_credentials
     where organization_id = $1 and provider = $2
       and is_active and validated_at is not null
     order by created_at desc
     limit 1`,
    [organizationId, settings.provider],
  );

  let apiKey: string;
  const cred = credRows[0];
  if (cred !== undefined) {
    apiKey = decryptKey({
      ciphertext: byteaToBuffer(cred.api_key_encrypted),
      iv: byteaToBuffer(cred.api_key_iv),
      tag: byteaToBuffer(cred.api_key_tag),
    });
  } else if (settings.provider === 'anthropic' && cfg.anthropicApiKey) {
    apiKey = cfg.anthropicApiKey;
  } else {
    throw new LlmNotConfiguredError();
  }

  return {
    provider: settings.provider,
    apiKey,
    defaultModel: settings.default_model ?? null,
    params: settings.params,
    enabledModels: settings.enabled_models,
    monthlyBudgetCents: settings.monthly_budget_cents ?? null,
  };
}
