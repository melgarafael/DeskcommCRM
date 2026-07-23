# Fase 0 — Mineração de referências para o sistema de follow-up

> Insumo do design do sistema de follow-up inteligente (builder de fluxos + fila + seletor no agente).
> Repos minerados: odysseus, hermes-agent, openclaw, tomikcrm (v1 real do builder).
> Data: 2026-07-21.

## 1. Odysseus (`~/Downloads/odysseus`)

**TL;DR:** scheduler completo e maduro em `src/task_scheduler.py` (classe `TaskScheduler`). Modelo híbrido: cron (croniter) + recorrência wall-clock daily/weekly/monthly + one-shot (`once`) + gatilho por contagem de eventos. Persistência SQLAlchemy, recuperação explícita de zumbis no boot. LLM agenda via tool `manage_tasks`.

### Padrões roubáveis
1. **Datetime como mensagem user-role separada** para não invalidar prompt cache em jobs recorrentes (`task_scheduler.py:1578-1587`) — system prompt fica byte-idêntico. (O Deskcomm já faz o equivalente no `followup-turn.ts`: bloco temporal no sufixo.)
2. **Recuperação de zumbis no boot**: runs deixadas em `running`/`queued` por crash viram `aborted`; `next_run` vencidos são empurrados para `now+60s` (`start()`, linhas 447-496) — evita rajada pós-restart.
3. **Invariante de ouro: avançar `next_run` mesmo em erro/no-op/cancel** — task quebrada nunca busy-loopa o scheduler (4 caminhos distintos garantem isso).
4. **Polling adaptativo**: sleep = distância ao próximo `next_run`, teto 60s, piso 1s — corrige o atraso clássico de tick fixo.
5. **TaskDeferred com backoff** (20→40min) como mecanismo de adiamento distinto de erro.
6. **Foreground gating**: tasks de background cedem passagem ao usuário ativo e se reagendam (+15min).
7. **Recuperação em sessão DB nova quando o commit do error-path falha** — raro alguém cobrir esse caso.
8. **Histórico por execução** (`TaskRun`: status, result, error, tokens, steps JSON, model) com cascade — observabilidade de cada disparo.
9. **Encadeamento `then_task_id` com detecção de ciclo** (`_has_chain_cycle`).

### Armadilhas
1. **Sem re-hidratação de contexto conversacional**: cada disparo monta as mensagens do zero; `session_id` é só destino de output. Estado entre execuções depende de tools (notes/memory). Pegadinha de expectativa.
2. **Conversão de timezone delegada ao LLM** (`scheduled_time` deve chegar em UTC; o modelo converte) — modelo fraco = horário errado silencioso. Nós validamos server-side.
3. **Dois subsistemas paralelos de agendamento** (ScheduledTask vs. Note.due_date/calendar) — fácil duplicar lembrete. Lição: UMA porta de entrada de agendamento.
4. **Concorrência serial hard-coded** (Semaphore(1)) — task longa bloqueia a fila toda.
5. **UTC-naive em todo o DB** — funciona porque é disciplina de um arquivo só; frágil fora dele.
6. **Estado de ping em JSON no filesystem** — não sobrevive a container efêmero; um arquivo global chegou a vazar entre usuários.

Arquivos-chave: `src/task_scheduler.py`, `src/event_bus.py`, `src/tools/system.py`, `src/tool_schemas.py`, `core/database.py`.

## 2. Hermes-agent (`~/hermes-agent`)

**TL;DR:** cron de 2 eixos — store/execução (`cron/jobs.py` + `cron/scheduler.py`) e trigger plugável (`cron/scheduler_provider.py`). Persistência em `~/.hermes/cron/jobs.json` (fsync + atomic_replace + flock, auto-repair de corrupção). Ticker de 60s. O agente cria os próprios crons via tool única `cronjob` (action-oriented). Semântica **at-most-once** deliberada.

### Padrões roubáveis
1. **At-most-once via advance-before-run**: empurra `next_run_at` sob lock ANTES de executar — aceita perder 1 run num crash em vez de disparar rajada (o oposto exato do bug de burst pós-restart).
2. **Claim com TTL derivado do timeout** (`run_claim`/`fire_claim` CAS) para dedup entre processos/máquinas sem coordenação externa; claim future-dated é tratado como stale (clock skew).
3. **Collapse de backlog**: job atrasado dispara 1× e fast-forwarda para a próxima ocorrência futura — nunca acumula disparos.
4. **Snapshot de provider/model no create** — job "unpinned" falha fechado se o default global mudar depois (drift-guard).
5. **Delivery error separado de run error** (`last_delivery_error`) — falha de entrega não se confunde com falha do agente.
6. **Session seeding / attach_to_session**: entrega de cron vira respondível — a resposta do usuário cai numa sessão que já contém o brief do follow-up. É a versão hermes do nosso problema "usuário responde o follow-up e o agente não sabe do que se trata".
7. **Guard de foot-gun no create-time**: `lifecycle_guard` bane cron que reinicia o próprio gateway (loop SIGTERM-respawn); scan de prompt-injection em 2 tiers (strict no prompt do usuário, loose no prompt montado); scan anti-exfil de credenciais.
8. **Origin payload**: o job guarda `{platform, chat_id, thread_id, user_id}` — roteamento de entrega de fonte confiável, capturado do runtime na criação (nunca do modelo). Mesmo princípio do nosso `schedule_followup`.
9. **Guard anti-silêncio-perigoso**: recorrente cujo `compute_next_run` falha NÃO é desabilitado silenciosamente — vira `state="error"` mas continua enabled, visível.

### Armadilhas
1. **Sem retry/backoff/dead-letter** — falha = registra e segue. (Nosso `cron_jobs` já tem attempts/backoff — manter.)
2. **`parse_duration` só aceita m/h/d** — "me chama em 2 meses" não tem unidade; precisa virar horas ou ISO. Lição: aceitar ISO-8601 absoluto como formato canônico da tool (como nosso `promised_at` já faz).
3. **Contexto isolado por default** — follow-up conversacional exige `attach_to_session=True` opt-in, fácil de esquecer. Nosso default deve ser o inverso: follow-up SEMPRE re-hidrata.
4. **JSON único global** como store — blast-radius de corrupção; nós temos Postgres.
5. **Recompute de TZ não distingue DST de migração de host** — pode pular ocorrência num boundary de DST (trade-off assumido).

Arquivos-chave: `cron/jobs.py`, `cron/scheduler.py`, `cron/scheduler_provider.py`, `tools/cronjob_tools.py`, `lifecycle_guard.py`.

## 3. OpenClaw (`~/Downloads/openclaw`)

**TL;DR:** o cron mais sofisticado dos três. Vive em `src/cron/**` (contratos + runtime), SQLite como store, tool única `cron` com action discriminador via RPC ao gateway. Schedule e payload são **uniões discriminadas separadas** — "quando roda" (`at`/`every`/`cron`/`on-exit`) e "o que roda" (`systemEvent`/`agentTurn`/`command`/`script`) são eixos ortogonais. Todo run vira registro em `task_runs` (retenção 2000 rows/job).

### Padrões roubáveis
1. **Schedule ⊥ payload como uniões discriminadas** — evento não-temporal (`on-exit`) encaixa na mesma abstração retornando `nextRunAtMs=undefined`. Modelo mental direto pro nosso builder: nó de espera (quando) ≠ nó de ação (o quê).
2. **Anti-double-fire em profundidade (3 camadas)**: reserva durável pré-admissão (`queuedAtMs` persistido com rollback), marker in-process com `generation`, cap de concorrência global (8). Sobrevive a restart E a reload de módulo.
3. **Prompt de run unattended em camadas com contrato explícito**: "seu reply final É o deliverable, não um plano; responda `HEARTBEAT_OK` se nada a fazer; o scheduler é dono do retry". Resolve o agente que responde "ok, vou fazer" a um disparo agendado.
4. **Fresh session que carrega preferências mas descarta contexto ambiente** — lista explícita de campos "quem sou eu" (thinking/model/label) vs "de onde vim" (channel routing, elevation). A lista É o design.
5. **Classificação de retry estruturada** (`rate_limit|overloaded|network|timeout|server_error`) + backoff escalonado `[30s,60s,5m,15m,60m]` indexado por `consecutiveErrors`; transiente re-tenta, permanente desabilita; **retry só antes de `executionStarted`** (depois, tools podem ter side-effects não-idempotentes).
6. **Auto-limitação de privilégio no create**: job criado pelo agente herda no máximo a allowlist de tools do criador; `command` payload nem é exposto à tool do agente (superfície operator-admin separada).
7. **Startup-run-repair**: `runningAtMs` órfão no boot vira run falho (backoff/alerta); jobs overdue são **reagendados +2min**, não replayados na janela de connect; ledger durável vence write stale do store.
8. **Failure alerts com threshold + cooldown + destino separado** do delivery de sucesso.
9. **Pacing dinâmico**: o run pode propor `next_check in:"30m"` com clamp em `pacing.min/max` — a IA ajusta a própria cadência dentro de trilhos. **Peça central pro nosso "espera inteligente".**
10. **Heartbeat ≠ cron**: batimento recorrente de baixa cerimônia na main session vs agendador durável de tarefas discretas com histórico; cron sempre defere heartbeat.

### Armadilhas
1. **DOM/DOW em cron usam OR, não AND** (comportamento Vixie) — `0 9 15 * 1` dispara dia 15 E toda segunda.
2. **Timezone com defaults divergentes**: cron sem tz = host, `at` sem tz = UTC. Fácil de errar; nós já forçamos tz explícita.
3. **Regex de retry frouxo marcava "context limit 512" como HTTP 5xx retriável** — classificar erro estruturado > regex de mensagem.
4. **Sessão isolada não infere idioma/canal** — precisa vir no payload.
5. **Arquivar sessão desabilita jobs bound e restaurar NÃO reabilita.**

Arquivos-chave: `src/cron/types.ts`, `src/cron/service/timer.ts`, `src/cron/isolated-agent/run.ts`, `src/agents/tools/cron-tool.ts`, `docs/automation/cron-jobs.md`.

## 4. TomikCRM (`~/Downloads/tomikcrm`) — a v1 real

**TL;DR:** não existe UM sistema de follow-up no Tomik — existem TRÊS motores coexistindo (Flow Builder visual, Sequences lineares, Silence+Demand do agente), com três relógios (`next_eval_at`, `next_run_at`, `run_at`), três crons e três tabelas de estado. O Flow Builder delega envio às Sequences via RPC. Esse acoplamento triplo é o anti-padrão-raiz.

### O que a v1 acertou (promover no redesign)
1. **Estado em linha + timestamp absoluto + polling por cron** (`followup_lead_executions.next_eval_at`, worker step-per-tick a cada 2 min) — o único modelo robusto a prazos longos por design. Uma espera de 90 dias é só um timestamp.
2. **Enrollment idempotente por índice parcial único** (`(flow_id, lead_id) WHERE active`) — 1 execução ativa por lead/fluxo.
3. **Log imutável de eventos de execução** (`followup_execution_events`) — auditoria do caminho percorrido.
4. **Política de handoff por fluxo** (`pause|cancel|allow`) e **herança de janela em 3 níveis** (nó → step → sequência) — conceitos bons, execução furada.

### As 3 causas-raiz do "robótico e com erro em prazos longos"
- **(a) Janela de 24h do WhatsApp ignorada no AGENDAMENTO.** A espera longa vence, mas a janela fechou: texto de sessão é **descartado silenciosamente** (`window_closed_text_not_allowed`) e mídia entra em **retry infinito de 5 em 5 min** "até a janela abrir" — que nunca abre para lead silencioso. Job órfão eterno.
- **(b) Nó "IA Classifica" sem período de graça.** Se não há mensagem inbound no instante da avaliação, retorna `no_reply_fallback` imediatamente (confidence 1) — o lead é classificado como "sem resposta" segundos após o disparo, a menos que o autor lembre de pôr um nó Espera antes. Robótico por construção.
- **(c) Estados presos sem consumidor.** Pausa por handoff seta `next_eval_at=null` com `cancel_reason='human_handoff_active'` — **que nenhum worker lê**. Humano fecha a conversa e o fluxo fica pausado para sempre. Idem: analyzer com OpenAI cronicamente fora = loop de retry sem teto.

### Outras fragilidades documentadas
- Schema do Flow Builder **fora de migrations** (arquivos `UPDATE-vNNN-CLIENTE-SQL.md` aplicados manualmente por cliente) → drift entre orgs; a causa estrutural de "dava erro em umas orgs e não em outras".
- Demanda ("me chama em X dias"): parser regex determinístico razoável, mas **sem validação de horizonte máximo nem de data no passado**; duas âncoras de tempo diferentes no mesmo parser; `America/Sao_Paulo` hardcoded; fuso reimplementado à mão em 2 lugares.
- Idempotência de ação por **SELECT no log de eventos** (janela de corrida) em vez de constraint; claim otimista por match de `updated_at` em vez de `FOR UPDATE SKIP LOCKED`; lease (5 min) > tick (2 min).
- `isWithinBusinessHours` com `catch → return true` — **falha aberta**: fuso inválido dispara fora do horário.
- `node_type`/`condition_type` como text livre **sem CHECK** — nó inválido só explode em runtime no worker.
- `agent_scheduled_steps` sem índice de unicidade — aceita agendamentos duplicados.

Arquivos-âncora: `supabase/functions/followup-flow-worker/`, `followup-sequence-engine/step-executor.ts`, `followup-response-analyzer/`, `tenant-mcp/index.ts:537-689,6895-7016`, `src/lib/followup-schedule-policy.ts`.

## Síntese para o design

**O que o Deskcomm já tem que os 4 repos validam:** `cron_jobs` (at/every/cron + tz + stagger + backoff) ≅ união discriminada de schedule do openclaw; `schedule_followup` com janela mín/máx via knobs = a validação de horizonte que faltou no Tomik; `followup_turn` com bloco de re-entrada temporal = a re-hidratação que odysseus/hermes NÃO fazem; before-send guardrails + pacing = a consciência de janela que faltou no Tomik.

**Decisões extraídas da mineração:**
1. **UM motor, UM relógio.** Tudo (silêncio, demanda, fluxo) é o mesmo grafo com o mesmo enrollment; sem motores paralelos (anti-padrão-raiz do Tomik, ecoado no odysseus com seus 2 subsistemas).
2. **Estado em linha + `next_eval_at` absoluto + polling** (padrão validado no Tomik flow-worker) com **`FOR UPDATE SKIP LOCKED`** no claim (corrige a fragilidade do claim otimista).
3. **At-most-once para envio ao lead** (hermes: advance-before-run; openclaw: retry só antes de side-effects): mensagem duplicada de follow-up é pior que mensagem perdida — rajada = ban.
4. **Backoff escalonado + dead-letter + alerta** (openclaw `[30s,60s,5m,15m,60m]` + failure alert com cooldown; nosso `agent_inbox_items` é o destino) — nunca retry infinito (Tomik) nem zero retry (hermes).
5. **Consciência de janela de 24h NO AGENDAMENTO**: nó de espera que cruza a janela exige fallback declarado (template aprovado / copy de reentrada); validação no PUBLISH do fluxo, não no disparo.
6. **Grace period estrutural no "IA Classifica"**: o nó espera resposta OU timeout explícito — nunca classifica no instante zero.
7. **Todo estado pausado tem consumidor de retomada**: handoff resume por evento (fechamento da conversa → event_log → worker); zero estados órfãos.
8. **Espera inteligente = pacing com clamp** (openclaw `next_check` + `pacing.min/max`): a IA propõe o momento dentro de trilhos configurados.
9. **Zumbi-repair no boot/tick** (odysseus/openclaw): runs órfãs viram falha explícita; vencidos não fazem burst (collapse de backlog do hermes).
10. **Fluxos versionados imutáveis** (`*_versions` + `*_pointers`, padrão do harness): lead em voo continua na versão em que entrou; `node_type` com CHECK; schema TODO em migrations (nunca o drift manual do Tomik).
11. **Datetime fora do system prompt** (odysseus/nosso followup-turn): bloco temporal no sufixo, cache preservado.
12. **Tool de agendamento valida server-side** (nunca delegar conversão de tz ao modelo — armadilha odysseus); ISO-8601 absoluto como formato canônico.
