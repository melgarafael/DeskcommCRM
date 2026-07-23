/**
 * Validação Zod do env do WORKER (agent-engine) — lança no startup se faltar
 * variável crítica. Pós-fusão: o worker fala com o MESMO Supabase do app —
 * SUPABASE_DB_URL (Postgres direto, padrão do kit self-host) para o motor, e
 * URL + service role para os handlers do app (envio).
 */
import { z } from 'zod';

const envSchema = z.object({
  // Postgres do Supabase (connection string — Settings → Database). O motor usa
  // `pg` direto: FOR UPDATE SKIP LOCKED, advisory locks, FTS.
  SUPABASE_DB_URL: z.string().url(),
  // Supabase API — os handlers do app (sendMessageHandler) exigem o client
  // service-role. Mesmos valores do .env.local do app.
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // Chave LLM de plataforma (fallback quando a org não tem BYOK em
  // ai_provider_credentials). Opcional no boot: sem ela e sem BYOK, o turno
  // falha com erro instrutivo — nunca silêncio.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  // Modelo default do agente quando a org não define o dela (knob, nunca constante).
  AGENT_DEFAULT_MODEL: z.string().min(1).default('claude-sonnet-4-5'),
  // Teto de conexões por pool do pg. Sem valor = pg decide (default 10).
  DB_POOL_MAX: z.coerce.number().int().positive().optional(),
  // Knobs da fila — defaults conservadores, documentados no .env.example.
  QUEUE_MAX_CONCURRENCY: z.coerce.number().int().positive().default(8),
  QUEUE_VISIBILITY_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // Porta do /healthz (bind 0.0.0.0 no container; 0 = porta efêmera em teste).
  HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  QUEUE_REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(30_000),
  // Watchdog de sessão (Fase 4A-2) — o ÚNICO ponto do engine que fala com o
  // WAHA direto (admin-plane, regra dura nº 4): reconcilia o espelho
  // channel_sessions com o status real e reenvia mensagens AI presas em queued.
  // Opcionais no boot: sem WAHA_API_BASE_URL/KEY o watchdog fica OFF (warn).
  WAHA_API_BASE_URL: z.string().url().optional(),
  WAHA_API_KEY: z.string().min(1).optional(),
  WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WATCHDOG_REDRIVE_MIN_AGE_MS: z.coerce.number().int().positive().default(30_000),
  WATCHDOG_REDRIVE_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  WATCHDOG_REDRIVE_SPACING_MS: z.coerce.number().int().positive().default(4_000),
  // Dono ÚNICO dos eventos ai_agent.dispatch_requested (mesma chave do app):
  // 'engine' (default) = o drain deste worker consome; 'native' = o dispatcher
  // EPIC-13 consome e o drain daqui NÃO liga. Nunca os dois.
  AGENT_DISPATCH_CONSUMER: z.enum(['engine', 'native']).default('engine'),
  // Modo do gate de disclosure: 'inject' (default conservador) ou 'veto'.
  DISCLOSURE_MODE: z.enum(['inject', 'veto']).default('inject'),
  // Resposta 'queued' (sessão ≠ WORKING): job reagendado com este atraso, SEM
  // consumir attempts.
  SEND_QUEUED_RETRY_MS: z.coerce.number().int().positive().default(300_000),
  // Drain do event_log (mesmo banco pós-fusão) — lote, ritmo e backoff ocioso.
  CRM_DRAIN_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  CRM_DRAIN_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  CRM_DRAIN_IDLE_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  // Evento 'processing' órfão (crash do worker) volta a 'pending' após isto.
  CRM_EVENT_REAP_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Coalescência de rajada inbound: mensagens do MESMO contato dentro desta
  // janela viram UM job (responder em rajada é gatilho de ban). 0 = sem debounce.
  INBOUND_DEBOUNCE_MS: z.coerce.number().int().min(0).default(8_000),
  // Circuito de saúde do número — ritmo do ticker (block/response rate por número).
  NUMBER_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  // Cron persistente por contato — knobs, nunca constantes.
  CRON_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  CRON_STAGGER_WINDOW_MS: z.coerce.number().int().min(0).default(60_000),
  CRON_RETRY_BASE_MS: z.coerce.number().int().positive().default(30_000),
  CRON_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  // Janela aceitável do follow-up agendado pela tool schedule_followup.
  FOLLOWUP_MIN_AHEAD_MS: z.coerce.number().int().positive().default(300_000),
  FOLLOWUP_MAX_AHEAD_MS: z.coerce.number().int().positive().default(15_552_000_000),
  // TTL do prefixo estável de prompt cache (doutrina: 1h).
  LLM_CACHE_TTL: z.enum(['5m', '1h']).default('1h'),
  // Payload curado da tool get_lead_context.
  LEAD_CONTEXT_HISTORY_LIMIT: z.coerce.number().int().positive().default(20),
  LEAD_CONTEXT_MAX_TOKENS: z.coerce.number().int().positive().default(1_000),
  // Memória durável por contato — orçamento fixo do índice de notas.
  LEAD_NOTES_INDEX_MAX_TOKENS: z.coerce.number().int().positive().default(500),
  // Recall híbrido das notas (BM25 × vetorial × decay × MMR).
  LEAD_RECALL_HALF_LIFE_DAYS: z.coerce.number().positive().default(30),
  LEAD_RECALL_MMR_LAMBDA: z.coerce.number().min(0).max(1).default(0.7),
  LEAD_RECALL_TOP_K: z.coerce.number().int().positive().default(5),
  LEAD_RECALL_BM25_WEIGHT: z.coerce.number().min(0).default(0.5),
  LEAD_RECALL_VECTOR_WEIGHT: z.coerce.number().min(0).default(0.5),
  // Compaction + flush pré-compaction.
  COMPACTION_TRIGGER_MESSAGES: z.coerce.number().int().positive().default(40),
  COMPACTION_MODEL: z.string().min(1).optional(),
  COMPACTION_TRANSCRIPT_MAX_TOKENS: z.coerce.number().int().positive().default(400),
  // Pruning de tool results antigos.
  PRUNE_TOOL_RESULTS_WINDOW_TURNS: z.coerce.number().int().positive().default(4),
  PRUNE_TOOL_RESULTS_MIN_RESULT_TOKENS: z.coerce.number().int().positive().default(200),
  // Skills situacionais — near-misses viram candidatos ao golden set (curadoria
  // humana; escrita por fs em runtime, gitignored).
  GOLDEN_CANDIDATES_DIR: z.string().min(1).default('lib/agent-engine/golden-candidates'),
  // Classificadores auxiliares (modelo BARATO; sem valor = default da org).
  STAGE_CLASSIFIER_MODEL: z.string().min(1).optional(),
  JAILBREAK_CLASSIFIER_MODEL: z.string().min(1).optional(),
  // Camada SEMÂNTICA de promessa na cadeia before_send (1 chamada por envio quando on).
  PROMISE_SEMANTIC_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  PROMISE_SEMANTIC_MODEL: z.string().min(1).optional(),
  // Onda 5 (Task 5.1) — modelo auxiliar dos turnos classify/decide_timing do
  // sistema de fluxos de follow-up (sem valor = default da org).
  FOLLOWUP_AI_MODEL: z.string().min(1).optional(),
  // Loop do agente — teto de steps de tool-calls por run.
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(8),
  // Circuit breaker de tools por run.
  TOOL_BREAKER_EXACT_WARN: z.coerce.number().int().positive().default(2),
  TOOL_BREAKER_EXACT_BLOCK: z.coerce.number().int().positive().default(5),
  TOOL_BREAKER_SAME_TOOL_WARN: z.coerce.number().int().positive().default(3),
  TOOL_BREAKER_SAME_TOOL_HALT: z.coerce.number().int().positive().default(8),
  TOOL_BREAKER_NO_PROGRESS_WARN: z.coerce.number().int().positive().default(3),
  TOOL_BREAKER_NO_PROGRESS_BLOCK: z.coerce.number().int().positive().default(5),
  // Observabilidade — janela do /metrics e do alerta de cache hit.
  METRICS_WINDOW_MS: z.coerce.number().int().positive().default(86_400_000),
  CACHE_HIT_ALERT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  CACHE_HIT_ALERT_MIN_RUNS: z.coerce.number().int().positive().default(20),
  // RAG/embedding das notas (recall vetorial) — opcional; sem chave, só BM25.
  RAG_TOP_K: z.coerce.number().int().positive().default(5),
  RAG_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  RAG_MAX_TOKENS: z.coerce.number().int().positive().default(2_000),
  RAG_EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  RAG_EMBEDDING_API_KEY: z.string().min(1).optional(),
  RAG_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Flywheel agendado (4B): rodada judge→distiller sobre turnos reais a cada
  // intervalo. 0 = OFF (só o gatilho manual pnpm flywheel:judge). Gate humano
  // sempre: proposta nunca vira comportamento sem o dono publicar na tela.
  FLYWHEEL_INTERVAL_MS: z.coerce.number().int().min(0).default(21_600_000),
  FLYWHEEL_BATCH_LIMIT: z.coerce.number().int().positive().default(10),
  // Contenção de egress — hosts EXTRA além do Supabase/WAHA (CSV). Fail-closed.
  EGRESS_EXTRA_ALLOWED_HOSTS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * O erro lista SÓ os nomes das variáveis inválidas — nunca valores
 * (SUPABASE_DB_URL carrega credencial; credencial fora de log).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Var VAZIA = ausente (padrão de env files): o template gera `CHAVE=` e o
  // README promete "deixe vazio e cadastre depois na tela" (BYOK) — sem isto,
  // ANTHROPIC_API_KEY= derrubava o worker no boot (bug pego pela prova limpa).
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== ''),
  ) as NodeJS.ProcessEnv;
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`env inválido — verifique no .env: ${names.join(', ')}`);
  }
  return parsed.data;
}
