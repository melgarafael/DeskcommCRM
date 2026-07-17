/**
 * BYOK por org (F2-23; stack.md §2 §BYOK multi-tenant): a chave do provedor vive
 * CIFRADA em org_llm_credentials (pgp_sym_encrypt, pgcrypto) e a chave-mestra
 * LLM_CRED_KEY vive no env do daemon — nunca no DB, nunca em log, nunca no
 * contexto do modelo. Cifra e decifra acontecem DENTRO do Postgres; o plaintext
 * só existe em memória do processo no instante da chamada ao provider.
 *
 * A config é lida do DB A CADA chamada (resolveOrgLlmConfig) — trocar modelo/
 * provider/teto é UPDATE na config, sem restart nem deploy.
 */
import type pg from 'pg';

import type { CacheTtl } from './stable-prefix';

/** Config da camada LLM montada do env validado (padrão crmEdgeConfigFromEnv). */
export interface LlmEdgeConfig {
  credKey: string;
  /**
   * TTL do prefixo estável de cache (F2-17; knob LLM_CACHE_TTL). Opcional para
   * quem monta a config na mão (testes) — o seam aplica a doutrina '1h'
   * (CLAUDE.md regra 15) quando ausente.
   */
  cacheTtl?: CacheTtl;
}

export function llmEdgeConfigFromEnv(env: { LLM_CRED_KEY?: string; LLM_CACHE_TTL?: string }): LlmEdgeConfig {
  if (!env.LLM_CRED_KEY) {
    throw new Error(
      'camada LLM não configurada — defina LLM_CRED_KEY no .env (chave-mestra do BYOK, stack.md §2)',
    );
  }
  const ttl = env.LLM_CACHE_TTL ?? '1h';
  if (ttl !== '5m' && ttl !== '1h') {
    throw new Error("LLM_CACHE_TTL inválido — use '5m' ou '1h' (default 1h; stack.md §2)");
  }
  return { credKey: env.LLM_CRED_KEY, cacheTtl: ttl };
}

/** Org sem credencial LLM default — erro tipado, mensagem sem valores (PII/credencial fora). */
export class LlmNotConfiguredError extends Error {
  override readonly name = 'llm_not_configured';
  constructor() {
    super('org sem credencial LLM configurada — cadastre provider/chave/modelo em org_llm_credentials');
  }
}

export interface OrgLlmConfig {
  provider: string;
  /** plaintext decifrado — existe só em memória, jamais logado/persistido */
  apiKey: string;
  defaultModel: string;
  params: Record<string, unknown>;
  enabledModels: string[];
  monthlyBudgetCents: number | null;
}

/**
 * Resolve a config default da org, decifrando a chave no Postgres com a
 * chave-mestra do env. Chamada a cada run — é o que faz a troca de modelo
 * valer no run seguinte, sem restart.
 */
export async function resolveOrgLlmConfig(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  tenantId: string,
): Promise<OrgLlmConfig> {
  const { rows } = await db.query<{
    provider: string;
    api_key: string;
    default_model: string;
    params: Record<string, unknown>;
    enabled_models: string[];
    monthly_budget_cents: number | null;
  }>(
    `select provider,
            pgp_sym_decrypt(api_key_encrypted, $2) as api_key,
            default_model, params, enabled_models, monthly_budget_cents
     from org_llm_credentials
     where tenant_id = $1 and is_default`,
    [tenantId, cfg.credKey],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new LlmNotConfiguredError();
  }
  return {
    provider: row.provider,
    apiKey: row.api_key,
    defaultModel: row.default_model,
    params: row.params,
    enabledModels: row.enabled_models,
    monthlyBudgetCents: row.monthly_budget_cents,
  };
}

/**
 * Upsert da credencial BYOK da org — a chave entra cifrada no MESMO statement
 * (pgp_sym_encrypt); nenhum caminho grava plaintext.
 */
export async function setOrgLlmCredentials(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  tenantId: string,
  input: {
    provider: string;
    apiKey: string;
    defaultModel: string;
    params?: Record<string, unknown>;
    enabledModels?: string[];
    monthlyBudgetCents?: number | null;
  },
): Promise<void> {
  await db.query(
    `insert into org_llm_credentials
       (tenant_id, provider, api_key_encrypted, default_model, params, enabled_models, monthly_budget_cents)
     values ($1, $2, pgp_sym_encrypt($3, $4), $5, $6, $7, $8)
     on conflict (tenant_id, provider) do update
       set api_key_encrypted = excluded.api_key_encrypted,
           default_model = excluded.default_model,
           params = excluded.params,
           enabled_models = excluded.enabled_models,
           monthly_budget_cents = excluded.monthly_budget_cents,
           updated_at = now()`,
    [
      tenantId,
      input.provider,
      input.apiKey,
      cfg.credKey,
      input.defaultModel,
      input.params ?? {},
      input.enabledModels ?? [],
      input.monthlyBudgetCents ?? null,
    ],
  );
}
