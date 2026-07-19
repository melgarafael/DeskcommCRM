/**
 * Teste de conexão BYOK (F2-23 acceptance 3): resolve a config da org e faz UMA
 * chamada mínima ao provider configurado, pelo MESMO seam de produção
 * (runModelCall) — valida chave decifrável, provider registrado, modelo aceito e
 * budget, e deixa o rastro honesto em llm_calls (purpose='connection_test').
 * CLI de operador: scripts/ops-test-model.ts (`pnpm ops:test-model --org <id>`).
 */
import type pg from 'pg';

import type { LlmEdgeConfig } from './credentials';
import { runModelCall, type RunModelCallDeps } from './run-model-call';

export interface TestModelResult {
  provider: string;
  model: string;
  latencyMs: number;
  outputTokens: number;
}

export async function testModelConnection(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  tenantId: string,
  deps: RunModelCallDeps = {},
): Promise<TestModelResult> {
  const { provider, model, latencyMs, usage } = await runModelCall(
    db,
    cfg,
    {
      tenantId,
      purpose: 'connection_test',
      messages: [{ role: 'user', content: 'Responda apenas: ok' }],
    },
    deps,
  );
  return { provider, model, latencyMs, outputTokens: usage.outputTokens };
}
