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
 *
 * Com SMOKE_OPENROUTER=1 e OPENROUTER_API_KEY, repete 2, 3 e 5 pelo seam com o
 * Claude pela OpenRouter oficial e OPENROUTER_PROMPT_CACHE=on — o caminho
 * seam → embrulho da fábrica → custo gravado (`usage.cost`) — e acrescenta um laço
 * de ferramentas para provar a cauda. A prova por provedor de origem é outra:
 * scripts/prova-cache-openrouter.ts. Custo: 3 chamadas curtas de Haiku 4.5.
 */
import pg from 'pg';
import { z } from 'zod';

import {
  runModelCall,
  tool,
  llmEdgeConfigFromEnv,
  LlmBudgetExceededError,
} from '@/lib/agent-engine/edge/llm/run-model-call';
import { custoInformadoPeloOpenRouter } from '@/lib/agent-engine/edge/llm/pricing';
import { stablePrefixHash } from '@/lib/agent-engine/edge/llm/stable-prefix';

import { passoSeguinteLeuOCache } from './lib/cache-do-laco';

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
    'Regras de conduta: responda sempre em português do Brasil, com no máximo duas frases.',
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

  if (process.env.SMOKE_OPENROUTER === '1' && process.env.OPENROUTER_API_KEY) {
    await smokeOpenRouter(db);
  }

  console.log(
    `\nSMOKE LLM PASS — ai@7: modelo=${call1.model} custo_total=${agg.cost.toFixed(4)}c ` +
      `write=${call1.usage.cacheWriteTokens} read=${call2.usage.cacheReadTokens} (mínimo ${MODEL}=${min})`,
  );
  await db.end();
}

/**
 * Claude pela OpenRouter oficial, pelo SEAM: os pontos de cache que o embrulho da
 * fábrica põe no corpo chegam e funcionam, e `cost_cents` é o que a OpenRouter
 * cobrou. Org própria, para não mexer no teto e nas linhas do bloco Anthropic.
 */
async function smokeOpenRouter(db: pg.Pool): Promise<void> {
  const ORG_OR = 'ab5a0c3e-0000-4000-8000-0000000000e0';
  const MODELO_OR = process.env.SMOKE_OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4.5';
  // O knob é lido pela fábrica a cada chamada (process.env), como em produção.
  process.env.OPENROUTER_PROMPT_CACHE = 'on';
  await db.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, 'smoke-llm-openrouter', 'Smoke LLM OpenRouter', 'Smoke LLM OpenRouter',
             jsonb_build_object('llm', jsonb_build_object('provider', 'openrouter', 'default_model', $2::text)))
     on conflict (id) do update set settings = excluded.settings`,
    [ORG_OR, MODELO_OR],
  );
  const cfg = llmEdgeConfigFromEnv({ OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, LLM_CACHE_TTL: '1h' });
  const origens: unknown[] = [];
  const log = {
    info: (msg: string, campos?: Record<string, unknown>) => {
      if (msg === 'llm: chamada concluída') origens.push(campos?.['custo_origem']);
    },
    warn: () => {},
    error: (msg: string, campos?: Record<string, unknown>) => console.error(msg, campos),
  };
  const system = bigSystem();
  const chamar = (content: string, extra: { maxSteps?: number; tools?: Parameters<typeof runModelCall>[2]['tools'] } = {}) =>
    runModelCall(
      db,
      cfg,
      { tenantId: ORG_OR, purpose: 'connection_test', system, messages: [{ role: 'user', content }], ...extra },
      { log },
    );

  console.info(`→ OpenRouter chamada 1 (${MODELO_OR}, esperado: cache WRITE)…`);
  const c1 = await chamar('Olá! Qual o preço do parafuso M3?');
  check(c1.provider === 'openrouter', 'OpenRouter: a chamada foi pela fábrica openrouter');
  check(c1.usage.cacheWriteTokens > 0, `OpenRouter: chamada 1 escreveu cache (${c1.usage.cacheWriteTokens})`);

  console.info('→ OpenRouter chamada 2 (mesmo prefixo, esperado: cache READ)…');
  const c2 = await chamar('E a porca M3, quanto custa?');
  check(c2.usage.cacheReadTokens >= 4096, `OpenRouter: chamada 2 leu o prefixo (${c2.usage.cacheReadTokens} ≥ 4096)`);

  console.info('→ OpenRouter chamada 3 (laço de ferramentas, esperado: o passo 2 lê a cauda do passo 1)…');
  const c3 = await chamar('Use a ferramenta consultar_preco para o item "arruela" e depois responda com o preço.', {
    maxSteps: 3,
    tools: {
      consultar_preco: tool({
        description: 'Consulta o preço de um item do catálogo de teste.',
        inputSchema: z.object({ item: z.string() }),
        execute: async () => 'R$ 0,25',
      }),
    },
  });
  const passos = c3.result.steps ?? [];
  check(passos.length >= 2, `OpenRouter: o laço rodou ${passos.length} passos`);
  const cauda = passos[0] && passos[1] ? passoSeguinteLeuOCache(passos[0].usage, passos[1].usage) : null;
  check(
    cauda?.ok === true,
    `OpenRouter: o passo 2 leu do cache tudo o que o passo 1 deixou nele (${cauda?.lido ?? '?'} ≥ ${cauda?.deixado ?? '?'})`,
  );

  for (const [i, c] of [c1, c2, c3].entries()) {
    const fatura = custoInformadoPeloOpenRouter(c.result);
    check(fatura !== undefined && fatura > 0, `OpenRouter: chamada ${i + 1} trouxe usage.cost (${fatura}c)`);
    const { rows } = await db.query<{ cost: number }>(`select cost_cents::float8 as cost from llm_calls where id = $1`, [c.callId]);
    check(
      Math.abs((rows[0]?.cost ?? -1) - fatura!) < 1e-9,
      `OpenRouter: llm_calls.cost_cents da chamada ${i + 1} = Σ usage.cost × 100 (${rows[0]?.cost})`,
    );
  }
  check(
    origens.length === 3 && origens.every((o) => o === 'informado_pelo_provedor'),
    "OpenRouter: o log das 3 chamadas traz custo_origem 'informado_pelo_provedor'",
  );
}

main().catch((err) => {
  console.error('✗ SMOKE FAIL (exceção):', err);
  process.exit(1);
});
