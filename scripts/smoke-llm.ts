/**
 * Smoke LLM (gate de release / upgrade de major do AI SDK — regra dura 16 do
 * harness): valida contra o MODELO REAL que a disciplina de custo/cache da
 * regra 15 sobreviveu à stack instalada. Roda via scripts/smoke-llm.sh (que
 * sobe o Postgres efêmero) ou contra SMOKE_DB_URL já provisionado.
 *
 * Checks:
 *   1. shape do usage do SDK: inputTokens/outputTokens + inputTokenDetails.
 *      {cacheReadTokens,cacheWriteTokens} existem e são números;
 *   2. 1ª chamada ESCREVE cache (cacheWriteTokens > 0) — providerOptions
 *      cacheControl continua virando cache_control no request;
 *   3. 2ª chamada byte-idêntica LÊ cache (cacheReadTokens > 0);
 *   4. prefixo medido ≥ mínimo cacheável do modelo;
 *   5. llm_calls persistiu tokens/custo (custo > 0);
 *   6. budget da org bloqueia ANTES do provider (LlmBudgetExceededError).
 *
 * Requer ANTHROPIC_API_KEY real no env. Custo: ~2 chamadas curtas de Haiku.
 */
import pg from 'pg';
import { z } from 'zod';

import {
  runModelCall,
  tool,
  llmEdgeConfigFromEnv,
  LlmBudgetExceededError,
} from '@/lib/agent-engine/edge/llm/run-model-call';
import { stablePrefixHash } from '@/lib/agent-engine/edge/llm/stable-prefix';

const DB_URL = process.env.SMOKE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54329/postgres';
const MODEL = process.env.SMOKE_MODEL ?? 'claude-haiku-4-5';
/** Mínimo cacheável POR MODELO (regra 15) — o smoke falha se o prefixo não cobre. */
const MIN_CACHEABLE: Record<string, number> = {
  'claude-haiku-4-5': 4096,
  'claude-opus-4-8': 4096,
  'claude-sonnet-4-6': 2048,
  'claude-sonnet-4-5': 1024,
};
const ORG = 'ab5a0c3e-0000-4000-8000-00000000c0de';

function fail(msg: string): never {
  console.error(`✗ SMOKE FAIL: ${msg}`);
  process.exit(1);
}

function check(cond: boolean, label: string): void {
  if (!cond) fail(label);
  console.log(`✓ ${label}`);
}

// Prefixo estável LONGO e determinístico (~6k tokens): precisa ultrapassar o
// mínimo cacheável do modelo. Zero conteúdo volátil (regra do stable-prefix).
function bigSystem(): string {
  const bloco = [
    'Você é o assistente de vendas da organização de teste do smoke.',
    'Regras de conduta: responda sempre em português do Brasil, com no máximo duas frases.',
    'Nunca prometa prazos de entrega, descontos ou condições comerciais que não estejam no catálogo.',
    'Se o cliente pedir atendimento humano, confirme que a transferência será feita pelo sistema.',
    'Produtos do catálogo de teste: parafuso M3 (R$ 1), porca M3 (R$ 0,50), arruela lisa (R$ 0,25).',
  ].join(' ');
  return Array.from({ length: 120 }, (_, i) => `[secao ${String(i + 1).padStart(3, '0')}] ${bloco}`).join('\n');
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) fail('ANTHROPIC_API_KEY ausente no env — o smoke exige o modelo real');
  const min = MIN_CACHEABLE[MODEL];
  if (min === undefined) fail(`modelo ${MODEL} sem entrada em MIN_CACHEABLE — adicione o mínimo cacheável dele`);

  const db = new pg.Pool({ connectionString: DB_URL, max: 3 });
  await db.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, 'smoke-llm', 'Smoke LLM', 'Smoke LLM',
             jsonb_build_object('llm', jsonb_build_object('provider', 'anthropic', 'default_model', $2::text)))
     on conflict (id) do update set settings = excluded.settings`,
    [ORG, MODEL],
  );

  const cfg = llmEdgeConfigFromEnv({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, LLM_CACHE_TTL: '1h' });
  const system = bigSystem();
  const tools = {
    consultar_catalogo: tool({
      description: 'Consulta o preço de um item do catálogo de teste.',
      inputSchema: z.object({ item: z.string() }),
      // sem execute: o smoke não precisa que o modelo chame; a tool existe para
      // exercitar a serialização determinística + breakpoint de cache na última tool.
    }),
  };

  const hashA = await stablePrefixHash({ system, tools });
  const hashB = await stablePrefixHash({ system, tools });
  check(hashA === hashB, `prefixo byte-idêntico entre builds (hash ${hashA.slice(0, 12)}…)`);

  console.log(`→ chamada 1 (${MODEL}, esperado: cache WRITE)…`);
  const call1 = await runModelCall(db, cfg, {
    tenantId: ORG,
    purpose: 'connection_test',
    system,
    tools,
    messages: [{ role: 'user', content: 'Olá! Qual o preço do parafuso M3?' }],
    maxSteps: 2,
  });

  // 1. shape do usage (regra 16): os paths que o seam lê existem no SDK instalado
  const raw = call1.result.usage as Record<string, unknown>;
  console.log(`  usage cru do SDK: ${JSON.stringify(raw)}`);
  check(typeof raw['inputTokens'] === 'number', 'usage.inputTokens é número no SDK instalado');
  check(typeof raw['outputTokens'] === 'number', 'usage.outputTokens é número no SDK instalado');
  const details = raw['inputTokenDetails'] as Record<string, unknown> | undefined;
  check(details !== undefined && details !== null, 'usage.inputTokenDetails existe no SDK instalado');
  check(
    'cacheReadTokens' in (details ?? {}) && 'cacheWriteTokens' in (details ?? {}),
    'usage.inputTokenDetails.{cacheReadTokens,cacheWriteTokens} presentes',
  );

  // 2 + 4. cache WRITE real e prefixo ≥ mínimo do modelo
  check(call1.usage.cacheWriteTokens > 0, `chamada 1 escreveu cache (${call1.usage.cacheWriteTokens} tokens)`);
  check(
    call1.usage.cacheWriteTokens >= min,
    `prefixo medido (${call1.usage.cacheWriteTokens}) ≥ mínimo cacheável do ${MODEL} (${min})`,
  );

  console.log(`→ chamada 2 (mesmo prefixo, esperado: cache READ)…`);
  const call2 = await runModelCall(db, cfg, {
    tenantId: ORG,
    purpose: 'connection_test',
    system,
    tools,
    messages: [{ role: 'user', content: 'E a porca M3, quanto custa?' }],
    maxSteps: 2,
  });

  // 3. cache READ real
  check(call2.usage.cacheReadTokens > 0, `chamada 2 leu cache (${call2.usage.cacheReadTokens} tokens)`);
  check(
    call2.usage.cacheReadTokens >= min,
    `hit cobriu o prefixo inteiro (${call2.usage.cacheReadTokens} ≥ ${min})`,
  );

  // 5. persistência de custo
  const { rows } = await db.query<{ n: string; cost: number; cache_read: number; cache_write: number }>(
    `select count(*)::text as n, coalesce(sum(cost_cents),0)::float8 as cost,
            coalesce(sum(cache_read_tokens),0)::float8 as cache_read,
            coalesce(sum(cache_write_tokens),0)::float8 as cache_write
     from llm_calls where organization_id = $1`,
    [ORG],
  );
  const agg = rows[0]!;
  check(agg.n === '2', `llm_calls tem exatamente as 2 chamadas (${agg.n})`);
  check(agg.cost > 0, `custo persistido > 0 (${agg.cost.toFixed(4)} cents)`);
  check(agg.cache_write > 0 && agg.cache_read > 0, 'cache_read/write_tokens persistidos em llm_calls');

  // 6. budget bloqueia ANTES do provider
  await db.query(
    `update organizations
     set settings = jsonb_set(settings, '{llm,monthly_budget_cents}', '0'::jsonb) where id = $1`,
    [ORG],
  );
  let budgetErr: unknown = null;
  try {
    await runModelCall(db, cfg, {
      tenantId: ORG,
      purpose: 'connection_test',
      system,
      messages: [{ role: 'user', content: 'não deve sair byte' }],
    });
  } catch (err) {
    budgetErr = err;
  }
  check(budgetErr instanceof LlmBudgetExceededError, 'budget 0 → LlmBudgetExceededError antes do provider');
  const { rows: after } = await db.query<{ n: string }>(
    `select count(*)::text as n from llm_calls where organization_id = $1`,
    [ORG],
  );
  check(after[0]!.n === '2', 'recusa por budget não gerou chamada nem linha nova');
  const { rows: inbox } = await db.query<{ n: string }>(
    `select count(*)::text as n from agent_inbox_items where organization_id = $1 and kind = 'budget_exceeded'`,
    [ORG],
  );
  check(after[0]!.n === '2' && inbox[0]!.n === '1', 'alerta humano budget_exceeded criado (1x, sem duplicar)');

  console.log(
    `\nSMOKE LLM PASS — ai@7: modelo=${call1.model} custo_total=${agg.cost.toFixed(4)}c ` +
      `write=${call1.usage.cacheWriteTokens} read=${call2.usage.cacheReadTokens} (mínimo ${MODEL}=${min})`,
  );
  await db.end();
}

main().catch((err) => {
  console.error('✗ SMOKE FAIL (exceção):', err);
  process.exit(1);
});
