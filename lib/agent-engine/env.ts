/**
 * Validação Zod do env do daemon — lança no startup se faltar variável crítica.
 * Mínimo desta fase: só o que F2-02 usa (Postgres do harness).
 */
import { z } from 'zod';

const envSchema = z.object({
  // Postgres PRÓPRIO do harness (docker compose local/VPS; service container no CI).
  DATABASE_URL: z.url(),
  // Teto de conexões por pool do pg (createPool). Sem valor = pg decide (default 10),
  // que é o caso de produção. Só os testes o setam baixo: rodam em paralelo (vários
  // pools × maxForks do vitest) e o produto precisa caber em max_connections=100 do CI.
  DB_POOL_MAX: z.coerce.number().int().positive().optional(),
  // Knobs da fila (F2-03) — defaults conservadores, documentados no .env.example.
  // Cap GLOBAL de jobs 'running' simultâneos do daemon (único; ver queue.ts).
  QUEUE_MAX_CONCURRENCY: z.coerce.number().int().positive().default(8),
  // Job 'running' sem concluir há mais que isso volta a 'pending' via reaper (stack.md §3: 10 min).
  QUEUE_VISIBILITY_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // Knobs do daemon (F2-04) — defaults conservadores, documentados no .env.example.
  // Porta do /healthz (bind em 127.0.0.1); 0 = porta efêmera (testes).
  HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  // Pausa do worker-loop quando a fila está vazia (ritmo é knob, nunca constante).
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  // Intervalo do ticker que roda o reaper de jobs órfãos (stack.md §6: ~60s).
  QUEUE_REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // Prazo do graceful shutdown: SIGTERM espera jobs em curso até isso; excedeu →
  // exit 1 e o reaper devolve o lease após o visibility timeout.
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(30_000),
  // Borda de saída CRM (F2-06) — opcionais no boot porque só a F2-09 (handler de
  // turno) as consome; crmEdgeConfigFromEnv() lança instrutivo se faltarem lá.
  // Base do DeskcommCRM pareado (o MCP fica em {CRM_BASE_URL}/api/mcp).
  CRM_BASE_URL: z.url().optional(),
  // Bearer da tabela api_tokens do CRM — criado no pareamento com scopes
  // mcp:write + role:manager + actor:ai_agent (edge-contract §4). Server-side only.
  CRM_API_TOKEN: z.string().min(1).optional(),
  // Timeout por chamada MCP ao CRM (knob, nunca constante).
  CRM_MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Contenção de egress (F4-03; blueprint 6.1/6.6) — hosts EXTRA da allowlist de rede,
  // além do host do CRM (derivado de CRM_BASE_URL). CSV, ex.: WAHA admin do tenant.
  // Vazio (default) = só o CRM é alcançável pelo cliente de egress; qualquer outro
  // destino falha closed. Nunca hardcoded — allowlist é config, não constante.
  EGRESS_EXTRA_ALLOWED_HOSTS: z.string().optional(),
  // Modo do gate de disclosure (F4-05; blueprint 5.7 — disclosure by design). Decide o que
  // fazer quando a 1ª mensagem a um lead novo sai SEM o disclosure de assistente virtual:
  //   'inject' (default CONSERVADOR) → o disclosure é prependado à mensagem (a apresentação
  //             sempre acontece, sem depender do modelo repetir);
  //   'veto'   → a mensagem é bloqueada e o modelo é ensinado a incluir o disclosure.
  // O template em si é versionado por tenant (disclosure_template_pointers) — sem template
  // publicado o gate é no-op. Nunca constante: modo é knob.
  DISCLOSURE_MODE: z.enum(['inject', 'veto']).default('inject'),
  // Resposta 'queued' (sessão ≠ WORKING / waha_not_configured): o job volta a
  // 'pending' com este atraso, SEM consumir attempts — sessão fora não pode
  // matar mensagem de lead saudável (F2-06 acceptance 3).
  SEND_QUEUED_RETRY_MS: z.coerce.number().int().positive().default(300_000),
  // Borda de ENTRADA CRM (F2-05) — drain do event_log via role vendaval_drain
  // (edge-contract §1/§4). Opcional no boot: sem ela o daemon sobe SEM drenar
  // (pareamento ainda não feito); com ela o loop de drain liga sozinho.
  CRM_DRAIN_DATABASE_URL: z.url().optional(),
  // Lote por tick de claim (edge-contract §1: limit 20).
  CRM_DRAIN_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  // Coalescência de rajada inbound (F2-24; achado 1.4 OpenClaw collect/steer):
  // mensagens do MESMO lead dentro desta janela viram UM job (o run responde a
  // todas — responder em rajada é gatilho de ban). Default global CONSERVADOR de
  // 8s: longo o bastante para juntar a rajada típica de WhatsApp, curto o bastante
  // para não parecer lento. Override por tenant em tenants.settings.inbound_debounce_ms.
  // 0 = sem debounce (degrada ao comportamento pré-F2-24: 1 run por mensagem).
  INBOUND_DEBOUNCE_MS: z.coerce.number().int().min(0).default(8_000),
  // Ritmo do poller (edge-contract §1): 2s sob carga, backoff adaptativo até 15s ocioso.
  CRM_DRAIN_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  CRM_DRAIN_IDLE_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  // Watchdog de sessão WAHA (F2-14) — liga junto com o drain (mesma env de
  // pareamento). Ritmo do ticker (stack.md §6: ~60s) e timeout do reaper de
  // eventos 'processing' órfãos no event_log do CRM (stack.md §3 item 3: 5 min).
  WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  CRM_EVENT_REAP_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Circuito de saúde do número (F2-26) — ritmo do ticker que computa block/response
  // rate por número e decide hold/unhold. Roda contra o harness (não precisa do CRM).
  // 5 min: o circuito reage em janela de horas, não de segundos; sub-minuto seria
  // varredura à toa. Limiares/janela/cool-down são knobs POR NÚMERO
  // (channel_knobs.health_knobs; defaults em daemon/src/health/defaults.ts).
  NUMBER_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  // Cron persistente por lead (F3-01; achado OpenClaw 1.2) — knobs, nunca constantes.
  // CRON_TICK_INTERVAL_MS: ritmo do ticker que claima crons vencidos e enfileira.
  // 30s: o cron reage em janela de minutos (follow-up), sub-minuto seria varredura à toa.
  CRON_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  // CRON_STAGGER_WINDOW_MS: janela do stagger determinístico anti-rajada — crons no
  // MESMO minuto espalham por [0, janela) por hash(lead_id). 60s: dilui o topo da hora
  // sem atrasar o follow-up de forma perceptível.
  CRON_STAGGER_WINDOW_MS: z.coerce.number().int().min(0).default(60_000),
  // CRON_RETRY_BASE_MS: base do backoff exponencial do retry TRANSIENTE de disparo
  // (base*2^(n-1)). 30s → 30s,1m,2m,4m,8m e esgotado (max_attempts) desabilita + inbox.
  CRON_RETRY_BASE_MS: z.coerce.number().int().positive().default(30_000),
  // CRON_BATCH_SIZE: máximo de crons disparados por tick (um por transação).
  CRON_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  // Tool schedule_followup (F3-02) — janela aceitável do retorno que o AGENTE agenda.
  // promised_at fora dela (no passado, cedo ou distante demais) → erro de ENSINO ao
  // modelo, sem agendar. Knobs, nunca constantes; o stagger reusa CRON_STAGGER_WINDOW_MS.
  // FOLLOWUP_MIN_AHEAD_MS: antecedência mínima — 5 min barra follow-up quase-instantâneo
  // (dispararia em rajada) sem podar "te retorno em meia hora".
  FOLLOWUP_MIN_AHEAD_MS: z.coerce.number().int().positive().default(300_000),
  // FOLLOWUP_MAX_AHEAD_MS: horizonte máximo — 180 dias; além disso é quase sempre
  // erro do modelo (data absurda). Conservador e documentado.
  FOLLOWUP_MAX_AHEAD_MS: z.coerce.number().int().positive().default(15_552_000_000),
  // Camada de modelo agnóstica (F2-23) — chave-mestra que cifra/decifra as chaves
  // BYOK por org em org_llm_credentials (pgp_sym_encrypt; stack.md §2). Vive SÓ no
  // env, nunca no DB/log. Opcional no boot: llmEdgeConfigFromEnv() lança instrutivo
  // em quem for chamar modelo sem ela.
  LLM_CRED_KEY: z.string().min(16).optional(),
  // TTL do prefixo estável de prompt cache (F2-17; stack.md §2): bloco org-wide
  // [tools + system do playbook] com cacheControl explícito no seam. Doutrina é
  // 1h (CLAUDE.md regra 15); '5m' só para experimentação de custo.
  LLM_CACHE_TTL: z.enum(['5m', '1h']).default('1h'),
  // Payload curado da tool get_lead_context (F2-08) — knobs, nunca constantes.
  // Últimas N mensagens do histórico incluídas no payload.
  LEAD_CONTEXT_HISTORY_LIMIT: z.coerce.number().int().positive().default(20),
  // Teto do payload serializado (contado pela heurística conservadora de
  // get-lead-context.ts); estouro TRUNCA (antigas caem primeiro), nunca falha.
  LEAD_CONTEXT_MAX_TOKENS: z.coerce.number().int().positive().default(1_000),
  // Memória durável por lead (F3-05) — orçamento FIXO do ÍNDICE de notas (só as
  // headlines + id) injetado no sufixo de cada run. Medido pela mesma heurística
  // chars/3,5. HARD CAP na escrita (padrão Hermes): save_lead_note recusa a nota que
  // estouraria e ensina o modelo a consolidar (supersedes) — nunca trunca em silêncio.
  // Default conservador de 500 tokens: dezenas de headlines curtas cabem sem inflar
  // o sufixo por-lead. Knob, nunca constante.
  LEAD_NOTES_INDEX_MAX_TOKENS: z.coerce.number().int().positive().default(500),
  // Recall híbrido das notas do lead (F3-06; blueprint 1.6) — knobs, nunca constantes.
  // LEAD_RECALL_HALF_LIFE_DAYS: meia-vida do decay temporal (peso = 0.5^(idade/meia-vida)).
  // 30 dias é a doutrina do blueprint (sinal recente do lead vence sinal velho).
  LEAD_RECALL_HALF_LIFE_DAYS: z.coerce.number().positive().default(30),
  // LEAD_RECALL_MMR_LAMBDA: λ do MMR em [0,1] — 1 = só relevância, 0 = só diversidade.
  // 0.7 favorece relevância, injetando alguma diversidade contra notas redundantes.
  LEAD_RECALL_MMR_LAMBDA: z.coerce.number().min(0).max(1).default(0.7),
  // LEAD_RECALL_TOP_K: teto de notas recuperadas por recall (conservador).
  LEAD_RECALL_TOP_K: z.coerce.number().int().positive().default(5),
  // Pesos do score-base híbrido (BM25 × vetorial). Default equilibrado 0.5/0.5:
  // token exato e paráfrase pesam igual até a org medir o que converte.
  LEAD_RECALL_BM25_WEIGHT: z.coerce.number().min(0).default(0.5),
  LEAD_RECALL_VECTOR_WEIGHT: z.coerce.number().min(0).default(0.5),
  // Compaction + flush pré-compaction (F3-07; OpenClaw 1.5) — knobs, nunca constantes.
  // COMPACTION_TRIGGER_MESSAGES: dispara quando o histórico do lead tem ≥ N mensagens.
  // 40: conservador — a maioria das conversas cabe sem compactar; só as longas pagam o
  // custo do modelo auxiliar. Antes disso o transcript cru (capado por get_lead_context)
  // basta. Subir se o custo do aux batch pesar; baixar se o prompt ficar grande cedo.
  COMPACTION_TRIGGER_MESSAGES: z.coerce.number().int().positive().default(40),
  // COMPACTION_MODEL: modelo BARATO do flush+compaction (aux batch), resolvido pela camada
  // agnóstica (F2-23) — separado do modelo do AGENTE. Sujeito a enabled_models da org. Sem
  // valor = usa o defaultModel da org (fallback seguro); definir um modelo pequeno corta custo.
  COMPACTION_MODEL: z.string().min(1).optional(),
  // COMPACTION_TRANSCRIPT_MAX_TOKENS: orçamento do transcript que sobra no prompt após
  // compactar (o resto vira resumo). 400: cauda recente curta; regra de cache 15 (nunca
  // transcript integral). Medido pela heurística chars/3,5 do resto do harness.
  COMPACTION_TRANSCRIPT_MAX_TOKENS: z.coerce.number().int().positive().default(400),
  // Pruning de tool results antigos (F3-10; blueprint 1.5 — fecha a tríade anti-context-rot)
  // — knobs, nunca constantes. PRUNE_TOOL_RESULTS_WINDOW_TURNS: rodadas de tool-result
  // mantidas ÍNTEGRAS (contadas do fim); as anteriores viram stub curto referenciável. 4:
  // conservador — a maioria dos runs faz poucas rodadas e não poda nada; só runs longos (várias
  // releituras/notas) pagam. A rodada CORRENTE nunca é podada (window ≥1).
  PRUNE_TOOL_RESULTS_WINDOW_TURNS: z.coerce.number().int().positive().default(4),
  // PRUNE_TOOL_RESULTS_MIN_RESULT_TOKENS: política — só poda o tool result cujo output excede
  // este nº de tokens (heurística chars/3,5). 200: resultados pequenos (ack de envio) ficam
  // íntegros; só os volumosos (contexto/nota grande) viram stub. Subir para podar menos.
  PRUNE_TOOL_RESULTS_MIN_RESULT_TOKENS: z.coerce.number().int().positive().default(200),
  // Skills situacionais (F3-09; blueprint 3.3) — diretório onde os near-misses de
  // guideline-matching ('devia ter usado a skill X e não usou') viram candidatos ao golden
  // set para curadoria humana. O daemon escreve por fs em runtime (não a tool Write, que o
  // hook de freeze bloqueia). Default eval/golden/candidates (gitignored: é saída de runtime,
  // o golden congelado é curado à mão). Knob, nunca constante.
  GOLDEN_CANDIDATES_DIR: z.string().min(1).default('eval/golden/candidates'),
  // Stage-classifier por turno (F3-11; padrão SalesGPT) — modelo BARATO do classificador
  // auxiliar (aux batch), resolvido pela camada agnóstica (F2-23) — separado do modelo do
  // AGENTE, sujeito a enabled_models da org. Sem valor = usa o defaultModel da org (fallback
  // seguro); definir um modelo pequeno corta custo. Nunca um id hardcoded. O classificador
  // SUGERE o estágio (hint no prompt); a máquina F2-10 (update_lead_state) segue a única porta.
  STAGE_CLASSIFIER_MODEL: z.string().min(1).optional(),
  // Classifier anti-jailbreak no inbound (F4-04; blueprint 6.3) — modelo BARATO do
  // classificador auxiliar (advisório), resolvido pela camada agnóstica (F2-23), separado do
  // modelo do AGENTE e sujeito a enabled_models da org. Sem valor = usa o defaultModel da org
  // (fallback seguro); definir um modelo pequeno corta custo. Nunca um id hardcoded. O
  // classificador FLAGRA o turno; flag alta + promessa fora de tabela (F4-01) no mesmo turno
  // escala para inbox_items. Ausente/sem knobs = classifier NÃO roda.
  JAILBREAK_CLASSIFIER_MODEL: z.string().min(1).optional(),
  // Camada SEMÂNTICA de promessa (F4-02) na cadeia before_send (F4-08 gate 5). CUSTO: quando
  // ligada, roda UM classificador auxiliar (modelo barato) POR TENTATIVA DE ENVIO — não por
  // turno. É o preço de fechar o buraco de promessa em texto livre que a regex (F4-01) não pega.
  // Default LIGADO (guardrail de compliance conservador); desligue por org que aceite o risco em
  // troca de custo/latência. O gate só veta com a camada determinística (F4-01) tendo passado.
  PROMISE_SEMANTIC_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Modelo auxiliar BARATO do classificador semântico (resolvido pela camada agnóstica F2-23,
  // sujeito a enabled_models da org). Sem valor = usa o defaultModel da org. Nunca hardcoded.
  PROMISE_SEMANTIC_MODEL: z.string().min(1).optional(),
  // Loop do agente (F2-09) — teto de steps de tool-calls por run (stopWhen do
  // seam F2-23). Default pequeno de propósito; circuit breaker fino é F2-15.
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(8),
  // Circuit breaker de tools do agente (F2-15; padrão Hermes tool_guardrails,
  // blueprint 2.1) — thresholds por RUN, defaults do padrão minerado:
  // exact_failure (mesma tool + mesmos args) warn 2 / block 5; same_tool_failure
  // (mesma tool, args variados) warn 3 / halt 8; idempotent_no_progress (tool
  // read-only repetindo resultado idêntico) warn 3 / block 5 — conservador.
  TOOL_BREAKER_EXACT_WARN: z.coerce.number().int().positive().default(2),
  TOOL_BREAKER_EXACT_BLOCK: z.coerce.number().int().positive().default(5),
  TOOL_BREAKER_SAME_TOOL_WARN: z.coerce.number().int().positive().default(3),
  TOOL_BREAKER_SAME_TOOL_HALT: z.coerce.number().int().positive().default(8),
  TOOL_BREAKER_NO_PROGRESS_WARN: z.coerce.number().int().positive().default(3),
  TOOL_BREAKER_NO_PROGRESS_BLOCK: z.coerce.number().int().positive().default(5),
  // Observabilidade v1 (F2-16) — janela de agregação do GET /metrics E do alerta
  // de cache hit (default 24h). Threshold/mínimo de runs do alerta: média do
  // cache_read_ratio da janela < threshold com ≥ min runs → inbox_items 1× por
  // episódio (blueprint 8.3: alerta <40%). Knobs, nunca constantes.
  METRICS_WINDOW_MS: z.coerce.number().int().positive().default(86_400_000),
  CACHE_HIT_ALERT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  CACHE_HIT_ALERT_MIN_RUNS: z.coerce.number().int().positive().default(20),
  // Backup/restore do Postgres do harness (F2-27; stack.md §Backup). O pg_dump é o
  // `pnpm ops:backup` (timer systemd); o daemon só MONITORA a atualidade dos dumps.
  // BACKUP_DIR: destino dos .dump. Opcional no boot: sem ela o monitor fica off
  // (deploy que ainda não ligou backup sobe normal) e o ops:backup recusa com instrução.
  BACKUP_DIR: z.string().min(1).optional(),
  // Retenção: dumps mais velhos que isso o ops:backup apaga (knob, nunca constante).
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  // Staleness: dump mais recente mais velho que isso → inbox_items(critical). Default
  // 48h — um backup diário perdido tem ~1 dia de folga antes de alarmar (conservador).
  BACKUP_STALENESS_MS: z.coerce.number().int().positive().default(172_800_000),
  // Ritmo do monitor de staleness no daemon (barato: só stat do diretório). 1h.
  BACKUP_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  // Diretório dos binários pg (pg_dump/pg_restore) quando NÃO estão no PATH — precisam
  // casar o major do servidor. Vazio = PATH (caso da VPS). Lido pelo ops:backup.
  PG_BIN_DIR: z.string().min(1).optional(),
  // RAG por tenant via subagente-quarentena (F3-08; edge-contract §3) — knobs, nunca
  // constantes. RAG_TOP_K/RAG_SIMILARITY_THRESHOLD são os defaults do CRM
  // (retrieve_top_k_chunks: k 5, threshold 0.72). RAG_MAX_TOKENS é o teto DURO do
  // payload curado devolvido ao run principal (blueprint 3.6: ≤2k tokens).
  RAG_TOP_K: z.coerce.number().int().positive().default(5),
  RAG_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  RAG_MAX_TOKENS: z.coerce.number().int().positive().default(2_000),
  // Modelo de embedding — PIN DE CONTRATO: o MESMO do indexador do CRM
  // (text-embedding-3-small, 1536 dims). Knob só para acompanhar uma troca do
  // indexador; o default É o contrato (divergir quebra o recall em silêncio).
  RAG_EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  // Chave OpenAI do embedding (server-side; egress api.openai.com, edge-contract §4).
  // Opcional no boot: sem ela o daemon sobe sem RAG; embedConfigFromEnv() lança
  // instrutivo em quem for embedar. Nunca vai a log/contexto do modelo (regra dura 7).
  RAG_EMBEDDING_API_KEY: z.string().min(1).optional(),
  // Timeout por chamada de embedding (knob, nunca constante).
  RAG_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Console web standalone (FU-01a; ui-stack.md §2/§8) — SPA Vite servida pelo
  // daemon + auth própria (better-auth, e-mail+senha) sobre o MESMO Postgres do
  // harness, schema dedicado `console` (migration 0027). Todos os segredos por env,
  // NUNCA hardcoded/commitado (regra dura 7).
  // BETTER_AUTH_SECRET: segredo server-side que assina cookies/tokens de sessão.
  // Opcional no boot (o daemon sobe sem o Console); consoleAuthConfigFromEnv() lança
  // instrutivo em quem for subir o Console sem ele. Nunca vai a log nem ao cliente.
  BETTER_AUTH_SECRET: z.string().min(16).optional(),
  // Porta do servidor do Console (bind 127.0.0.1, atrás de reverse proxy na VPS).
  // Separada do /healthz (HEALTH_PORT). 0 = porta efêmera (testes).
  CONSOLE_PORT: z.coerce.number().int().min(0).max(65_535).default(8788),
  // baseURL do better-auth (origem pública do Console). Vazio = derivado de
  // 127.0.0.1:CONSOLE_PORT (dev/e2e); em produção aponta o domínio https do Console.
  // Governa também a flag `secure` do cookie (https → secure), derivada pelo better-auth.
  CONSOLE_BASE_URL: z.url().optional(),
  // Expiração da sessão em segundos (knob, nunca constante). Default conservador de
  // 7 dias; a sessão expira em `now + isto` e o guardrail de rota recusa sessão vencida.
  CONSOLE_SESSION_MAX_AGE_S: z.coerce.number().int().positive().default(604_800),
  // Diretório do build estático da SPA (web/dist) servido pelo Console. Vazio = o
  // servidor sobe em modo API-only (sem SPA); os testes de unidade usam esse modo.
  CONSOLE_DIST_DIR: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * O erro lista SÓ os nomes das variáveis inválidas — nunca valores
 * (DATABASE_URL carrega credencial; credencial fora de log).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`env inválido — verifique no .env: ${names.join(', ')}`);
  }
  return parsed.data;
}
