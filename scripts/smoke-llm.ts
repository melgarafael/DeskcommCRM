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
 *   6. o teto de `ai_budgets` avisa na 1ª chamada acima dele e BLOQUEIA na 2ª,
 *      antes do provider (LlmBudgetExceededError) — e o script restaura o estado.
 *
 * Requer ANTHROPIC_API_KEY real no env. Custo: ~4 chamadas curtas de Haiku (as 2
 * do teste de cache são as caras; as do passo 6 são de uma palavra).
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

// Prefixo LONGO (~18k tokens de request): precisa ultrapassar o mínimo
// cacheável do modelo. SALT por execução: força cache FRIO a cada run do smoke
// (sem ele, o prefixo do run anterior ainda vivo no TTL de 1h faz a chamada 1
// LER em vez de ESCREVER e o assert de write quebra). Dentro do MESMO run o
// salt é constante — a byte-identidade entre as 2 chamadas (o que a doutrina
// exige em produção) continua sendo exatamente o que se afere.
const RUN_SALT = process.env.SMOKE_SALT ?? `run-${Date.now()}`;

function bigSystem(): string {
  const bloco = [
    'Você é o assistente de vendas da organização de teste do smoke.',
    'Regras de conduta: responda sempre em português de Moçambique, com no máximo duas frases.',
    'Nunca prometa prazos de entrega, descontos ou condições comerciais que não estejam no catálogo.',
    'Se o cliente pedir atendimento humano, confirme que a transferência será feita pelo sistema.',
    'Produtos do catálogo de teste: parafuso M3 (R$ 1), porca M3 (R$ 0,50), arruela lisa (R$ 0,25).',
  ].join(' ');
  return [
    `[smoke ${RUN_SALT}]`,
    ...Array.from({ length: 120 }, (_, i) => `[secao ${String(i + 1).padStart(3, '0')}] ${bloco}`),
  ].join('\n');
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

  const cfg = llmEdgeConfigFromEnv({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    LLM_CACHE_TTL: '1h',
  });
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

  // ── 6. O TETO QUE VINCULA: avisa antes de parar, e para ANTES do provider ──
  //
  // Este passo gravava `'0'` em `organizations.settings.llm.monthly_budget_cents`
  // e checava a exceção. Duas coisas o tornaram uma prova vazia:
  //
  //   (a) o resolvedor não lê mais aquele campo do jsonb — o teto mora em
  //       `ai_budgets`, atrás de `enforcement_mode`. O passo passaria a provar
  //       que um campo ignorado é ignorado;
  //   (b) `purpose: 'connection_test'` entrou em `PURPOSES_ISENTOS`. Mesmo com o
  //       teto armado corretamente, um teste de conexão NUNCA é recusado — o
  //       smoke ficaria verde por isenção, que é o pior verde que existe.
  //
  // A prova nova exercita a ESCADA inteira contra o mecanismo real: com o gasto
  // do mês acima do teto, a 1ª chamada AVISA e segue (condição 6: ninguém é
  // bloqueado sem ter sido avisado no mês) e só a 2ª bloqueia. Custo: uma
  // chamada curta a mais.
  // ⚠️ O RETRATO PRECISA SER COMPLETO, NÃO "O QUE EU LEMBREI DE OLHAR". A versão
  // anterior lia só `exists` e devolvia `enforcement_mode='off'` no fim — o teto
  // e o limiar que o dono configurou eram sobrescritos por 100 e 50 e ficavam
  // assim, sem aviso. Restaurar menos do que se sobrescreve é a mesma família de
  // defeito que esta feature conserta.
  const ESTADO_ANTERIOR = await db.query<{
    existe: boolean;
    teto: number | null;
    limiar: number | null;
    modo: string | null;
    efetivo_em: Date | null;
  }>(
    `select exists(select 1 from ai_budgets where organization_id = $1) as existe,
            (select monthly_limit_cents      from ai_budgets where organization_id = $1) as teto,
            (select alarm_threshold_pct      from ai_budgets where organization_id = $1) as limiar,
            (select enforcement_mode         from ai_budgets where organization_id = $1) as modo,
            (select enforcement_effective_at from ai_budgets where organization_id = $1) as efetivo_em`,
    [ORG],
  );
  // Gasto anterior do mês, para o teto (que tem piso de US$ 1,00) ser alcançável
  // sem queimar US$ 1 de verdade em Haiku. É uma linha de `llm_calls` como
  // qualquer outra — a régua `fn_gasto_de_ia_do_mes` soma exatamente isto.
  //
  // O `id` volta porque ela precisa ser APAGADA no fim: sem isso o smoke deixa
  // um gasto fantasma de US$ 5,00 no mês corrente da organização, no número que
  // passou a decidir se a IA para de responder.
  const { rows: semeada } = await db.query<{ id: string }>(
    `insert into llm_calls (organization_id, purpose, provider, model, cost_cents)
     values ($1, 'agent_turn', 'anthropic', $2, 500)
     returning id`,
    [ORG, MODEL],
  );
  const GASTO_SEMEADO_ID = semeada[0]!.id;
  await db.query(
    `insert into ai_budgets (organization_id, monthly_limit_cents, alarm_threshold_pct,
                             enforcement_mode, enforcement_effective_at)
     values ($1, 100, 50, 'bloquear', now() - interval '1 minute')
     on conflict (organization_id) do update
       set monthly_limit_cents      = 100,
           alarm_threshold_pct      = 50,
           enforcement_mode         = 'bloquear',
           enforcement_effective_at = now() - interval '1 minute'`,
    [ORG],
  );

  // 1ª acima do teto: avisa e SEGUE. `agent_turn` porque `connection_test` é
  // isento — o purpose faz parte do que está sendo provado.
  await runModelCall(db, cfg, {
    tenantId: ORG,
    purpose: 'agent_turn',
    system: 'Responda com uma palavra.',
    messages: [{ role: 'user', content: 'diga ok' }],
  });
  const { rows: aviso } = await db.query<{ n: string }>(
    `select count(*)::text as n from agent_inbox_items
      where organization_id = $1 and kind = 'budget_warning' and status = 'open'`,
    [ORG],
  );
  check(aviso[0]!.n === '1', 'gasto acima do teto: 1ª chamada AVISA e segue (budget_warning aberto)');

  const { rows: antes } = await db.query<{ n: string }>(
    `select count(*)::text as n from llm_calls where organization_id = $1`,
    [ORG],
  );
  let budgetErr: unknown = null;
  try {
    await runModelCall(db, cfg, {
      tenantId: ORG,
      purpose: 'agent_turn',
      system: 'Responda com uma palavra.',
      messages: [{ role: 'user', content: 'não deve sair byte' }],
    });
  } catch (err) {
    budgetErr = err;
  }
  check(budgetErr instanceof LlmBudgetExceededError, 'já avisado: 2ª chamada → LlmBudgetExceededError');
  const { rows: after } = await db.query<{ n: string; recusas: string }>(
    `select count(*)::text as n,
            count(*) filter (where status = 'erro' and error_code = 'orcamento_esgotado')::text as recusas
       from llm_calls where organization_id = $1`,
    [ORG],
  );
  // A recusa NÃO chama o provedor, mas GRAVA a linha de falha (`registrarFalha`)
  // — a tela de Execuções tem que explicar por que o agente parou. Exatamente
  // uma linha a mais que antes da recusa, e ela é a recusa por orçamento.
  check(
    Number(after[0]!.n) === Number(antes[0]!.n) + 1 && after[0]!.recusas === '1',
    'recusa por teto: nenhuma chamada ao provedor, e a recusa virou linha orcamento_esgotado em llm_calls',
  );
  const { rows: inbox } = await db.query<{ n: string }>(
    `select count(*)::text as n from agent_inbox_items where organization_id = $1 and kind = 'budget_exceeded'`,
    [ORG],
  );
  check(inbox[0]!.n === '1', 'alerta humano budget_exceeded criado (1x, sem duplicar)');

  // RESTAURA. Sem isto, um smoke rodado por engano contra um banco que não é o
  // efêmero deixa a organização PARADA para sempre — a mesma família de defeito
  // que esta feature conserta (controle que age sem quem o ligou perceber).
  const anterior = ESTADO_ANTERIOR.rows[0]!;
  if (anterior.existe) {
    await db.query(
      `update ai_budgets
          set monthly_limit_cents      = $2,
              alarm_threshold_pct      = $3,
              enforcement_mode         = $4,
              enforcement_effective_at = $5
        where organization_id = $1`,
      [ORG, anterior.teto, anterior.limiar, anterior.modo, anterior.efetivo_em],
    );
  } else {
    await db.query(`delete from ai_budgets where organization_id = $1`, [ORG]);
  }
  // O gasto semeado sai junto. Ele alimenta `fn_gasto_de_ia_do_mes`, que é a
  // régua que o gate consulta: deixá-lo é deixar US$ 5,00 de gasto que ninguém
  // teve dentro do número que decide.
  await db.query(`delete from llm_calls where id = $1`, [GASTO_SEMEADO_ID]);
  await db.query(
    `update agent_inbox_items set status = 'resolved'
      where organization_id = $1 and kind in ('budget_exceeded','budget_warning') and status = 'open'`,
    [ORG],
  );

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
