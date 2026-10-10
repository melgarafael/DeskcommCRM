-- 0050_agent_harness — schema do motor SDR (harness) portado do Vendaval para o
-- banco do CRM (fusão). Mapeamento canônico (lib/agent-engine/PORT-NOTES.md):
--   tenants → organizations · tenant_id → organization_id · leads → contacts ·
--   lead_id → contact_id · channel_session_id → FK real p/ channel_sessions(id).
-- Mortos no porte: tenants/leads (espelhos — o CRM é o mesmo banco agora),
-- event_inbox (o drain lê event_log direto), org_llm_credentials (BYOK do CRM =
-- ai_provider_credentials), colunas LGPD/handoff de leads (contacts.consent /
-- is_anonymized / conversations.bot_silenced_until já existem).
-- Idempotente (if not exists / or replace / do $$); SEM begin/commit; psql puro.

-- ============================================================================
-- Escalação humana do RUNTIME (ex-inbox_items do Vendaval; a UI lê daqui).
-- organization_id NULL = plataforma (ex.: infra) — visível só ao service role.
-- Kind já inclui 'judge_unaligned' (extensão da 0025 do Vendaval, embutida).
-- ============================================================================
create table if not exists agent_inbox_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  kind text not null check (kind in
    ('qr_rescan','job_dead','event_dead','budget_exceeded','handoff',
     'promotion_review','judge_unaligned','other')),
  severity text not null default 'warn' check (severity in ('info','warn','critical')),
  title text not null,
  body text,
  ref_kind text,
  ref_id uuid,
  status text not null default 'open' check (status in ('open','ack','resolved')),
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_inbox_items_open on agent_inbox_items (organization_id, created_at desc)
  where status = 'open';

-- ============================================================================
-- 0002 — fila durável FOR UPDATE SKIP LOCKED com lane por contact_id.
-- ============================================================================
create table if not exists job_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade, -- NULL para watchdog/flywheel (jobs sem contato)
  kind text not null check (kind in ('inbound_turn','followup_turn','watchdog','flywheel')),
  source_event_id uuid,                -- event_log.id (CRM, mesmo banco) que originou o job — dedup evento→job
  payload jsonb not null default '{}',
  status text not null default 'pending'
    check (status in ('pending','running','done','failed','dead')),
  priority smallint not null default 100,
  run_after timestamptz not null default now(),
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  last_error text,                     -- normalizado/truncado no código — nunca conteúdo de mensagem (PII)
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  -- jobs de turno TÊM contato; watchdog/flywheel NÃO — o schema força a coerência
  check ((kind in ('inbound_turn','followup_turn')) = (contact_id is not null))
);

create index if not exists idx_job_queue_claim on job_queue (status, run_after) where status = 'pending';

-- INVARIANTE (lane): 1 job 'running' por contato por vez; paralelismo entre contatos.
-- É o CINTO — o claim em duas etapas evita chegar aqui; na corrida residual o 23505
-- é capturado e o claim perde só a rodada.
create unique index if not exists uniq_job_queue_one_running_per_contact on job_queue (contact_id)
  where status = 'running' and contact_id is not null;

-- DEDUP evento→job: o handoff é at-least-once; evento re-entregue não vira 2º turno.
create unique index if not exists uniq_job_queue_source_event on job_queue (organization_id, source_event_id)
  where source_event_id is not null;

-- ============================================================================
-- 0003 — ledger de envio idempotente. Uma linha por mensagem `seq` do turno; `id`
-- É a idempotency_key da tentativa LÓGICA (re-attempt após 'failed' rotaciona o id).
-- ============================================================================
create table if not exists send_ledger (
  id uuid primary key default gen_random_uuid(), -- a idempotency_key da tentativa lógica corrente
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  job_id uuid not null references job_queue(id) on delete cascade,
  seq smallint not null,
  -- sha256 hex do corpo — PII (o corpo em si) NUNCA entra no ledger nem em log.
  body_hash text not null,
  -- requested: inserido imediatamente antes do envio (crash aqui → retry re-envia a MESMA key)
  -- accepted:  envio confirmado ('sent') — retry pula
  -- queued:    aceito e retido (sessão ≠ WORKING / waha_not_configured)
  -- vetoed:    is_blocked — veto permanente de negócio (irrevogável)
  -- failed:    'failed' (sem telefone / erro WAHA) — retry = tentativa lógica nova
  status text not null default 'requested'
    check (status in ('requested','accepted','queued','vetoed','failed')),
  crm_message_id uuid,                 -- messages.id (mesmo banco; vem na resposta do handler de envio)
  last_error text,                     -- normalizado/truncado no código — nunca corpo de mensagem (PII)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 1 linha por mensagem do turno — a base do "intenção exactly-once".
  unique (job_id, seq)
);

-- O throttle/spinning da cadeia before_send consulta envios recentes por org.
create index if not exists idx_send_ledger_recent on send_ledger (organization_id, created_at desc);

-- ============================================================================
-- Imutabilidade compartilhada das tabelas *_versions: conteúdo publicado é
-- imutável — mudança = versão nova; rollback = mover o ponteiro. DELETE fica de
-- fora de propósito (o cascade de organizations precisa passar; versão apontada
-- é protegida pelo FK do ponteiro correspondente).
-- ============================================================================
create or replace function fn_agent_versions_immutable() returns trigger
language plpgsql as $fn$
begin
  raise exception '% é imutável: mudança = versão nova; rollback = mover o ponteiro (%)',
    tg_table_name, replace(tg_table_name, '_versions', '_pointers');
end;
$fn$;

-- ============================================================================
-- 0004 — playbook em camadas versionado + carga por ponteiro. 1 linha por CAMADA
-- (platform|tenant|campaign); o runtime carrega por ponteiro no início de cada
-- run: trocar versão/rollback = mover ponteiro, sem restart. Camada platform é
-- global (organization_id NULL); tenant/campaign pertencem a uma org.
-- ============================================================================
create table if not exists playbook_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade, -- NULL = plataforma (global)
  layer text not null check (layer in ('platform', 'tenant', 'campaign')),
  -- Markdown com seções nomeadas (## ...), máx. 200 linhas por camada — validado no insert.
  content text not null,
  created_at timestamptz not null default now(),
  -- platform é global; tenant/campaign SEMPRE têm dono — o schema força a coerência
  check ((layer = 'platform') = (organization_id is null))
);

drop trigger if exists trg_playbook_versions_immutable on playbook_versions;
create trigger trg_playbook_versions_immutable
  before update on playbook_versions
  for each row execute function fn_agent_versions_immutable();

-- Ponteiro → versão ativa por escopo. SEM cascade no version_id: versão apontada
-- não pode sumir debaixo do ponteiro.
create table if not exists playbook_pointers (
  organization_id uuid references organizations(id) on delete cascade, -- NULL = plataforma (global)
  layer text not null check (layer in ('platform', 'tenant', 'campaign')),
  version_id uuid not null references playbook_versions(id),
  updated_at timestamptz not null default now(),
  check ((layer = 'platform') = (organization_id is null))
);

-- Unicidade do escopo (PK não serve: organization_id é NULL na plataforma).
create unique index if not exists uniq_playbook_pointers_org
  on playbook_pointers (organization_id, layer) where organization_id is not null;
create unique index if not exists uniq_playbook_pointers_platform
  on playbook_pointers (layer) where organization_id is null;

-- ============================================================================
-- 0005 + 0012 — espelho de saúde da sessão WAHA + circuito de saúde do número.
-- status_changed_at só avança quando o status MUDA (métrica "tempo no estado").
-- Os holds de status e de saúde coexistem — job retido sob QUALQUER hold.
-- ============================================================================
create table if not exists channel_session_health (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  status text not null,
  status_changed_at timestamptz not null default now(),
  -- Status já escalado (agent_inbox_items kind='qr_rescan') no EPISÓDIO corrente —
  -- dedup do "exatamente 1×". Volta a null quando a sessão volta a WORKING.
  escalated_status text,
  -- Circuito de saúde (0012): default false — linhas criadas pelo watchdog NÃO
  -- nascem health-held; o "nasce em hold" (fail-safe de go-live) é decidido pelo
  -- tick de saúde quando health_released_at is null, nunca pelo default.
  health_hold_active boolean not null default false,
  health_hold_reason text,          -- 'go_live' | 'block_rate' | 'response_rate'
  health_held_at timestamptz,       -- início do episódio de hold (base do cool-down)
  -- Liberação explícita inicial (go-live). NULL = número novo, nunca liberado →
  -- nasce em hold (fail-safe). Uma vez setado, permanece.
  health_released_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, channel_session_id)
);

-- Cursor durável de consumo do event_log do CRM por consumidor do harness (o
-- watchdog é o 1º). Tabela de PLATAFORMA (sem org): RLS habilitada sem policy —
-- só o service role (worker) lê/escreve.
create table if not exists watchdog_cursors (
  consumer text primary key,
  last_created_at timestamptz not null default 'epoch',
  last_event_id uuid not null default '00000000-0000-0000-0000-000000000000',
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- 0006 — toda chamada de modelo (custo, cache, atribuição); agregado mensal =
-- enforcement do budget. Credenciais BYOK são do CRM (ai_provider_credentials) —
-- org_llm_credentials do Vendaval NÃO foi portada.
-- ============================================================================
create table if not exists llm_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  job_id uuid references job_queue(id) on delete set null,
  variant_id uuid,                       -- experiment_variants (flywheel); nasce p/ atribuição
  purpose text not null default 'agent_turn',  -- 'agent_turn' | 'classifier' | 'compaction' | 'connection_test'
  provider text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,   -- métrica de 1ª classe
  cache_write_tokens int not null default 0,
  cost_cents numeric,                    -- null = preço desconhecido — nunca inventar 0
  latency_ms int,
  created_at timestamptz not null default now()
);
create index if not exists idx_llm_calls_org_time on llm_calls (organization_id, created_at);

-- ============================================================================
-- 0007 — artefato durável do loop do agente: cada run fecha escrevendo um
-- checkpoint; o run seguinte do MESMO contato abre lendo o mais recente —
-- sessões descartáveis, artefatos duráveis. Conteúdo validado por Zod no handler.
-- ============================================================================
create table if not exists lead_checkpoints (
  id uuid primary key default gen_random_uuid(),
  -- ordem de escrita estrita (created_at pode empatar) — abertura lê por seq.
  seq bigint generated always as identity,
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  job_id uuid references job_queue(id) on delete set null, -- o run É o job
  commitments jsonb not null default '[]',      -- string[] — compromissos assumidos no turno
  objections jsonb not null default '[]',       -- string[] — objeções levantadas
  next_action text,
  rolling_summary text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_lead_checkpoints_latest
  on lead_checkpoints (organization_id, contact_id, seq desc);

-- ============================================================================
-- 0008 — estado do funil por contato. O modelo MARCA avanços via tool; quem
-- valida a transição é a máquina de estados NO CÓDIGO — o CHECK é backstop.
-- ============================================================================
create table if not exists lead_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  stage text not null default 'new' check (stage in
    ('new','contacted','qualifying','qualified','negotiating','won','lost')),
  -- qualificação whitelisted (BANT) — Zod .strict() rejeita outras chaves antes daqui.
  qualification jsonb not null default '{}',
  next_action text,
  updated_at timestamptz not null default now(),
  unique (organization_id, contact_id)
);

-- Histórico append-only de transições — auditoria/diffabilidade do funil.
create table if not exists lead_state_transitions (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  job_id uuid references job_queue(id) on delete set null,
  from_stage text not null,
  to_stage text not null,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_lead_state_transitions_contact
  on lead_state_transitions (organization_id, contact_id, seq desc);

-- ============================================================================
-- 0009 — métricas de 1ª classe persistidas. Labels SÓ com ids/contagens — PII
-- jamais entra. organization_id NULL = plataforma.
-- ============================================================================
create table if not exists metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade, -- null = plataforma
  name text not null,
  labels jsonb not null default '{}',
  value double precision not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_metrics_name_time on metrics (name, created_at desc);
create index if not exists idx_metrics_org_name_time on metrics (organization_id, name, created_at desc);

-- ============================================================================
-- 0010 + 0011 + 0012 — knobs anti-ban por número/sessão + ledger de pacing.
-- Coluna NULL = default conservador no código (knobs, nunca constantes). O cap
-- diário ABSOLUTO não mora aqui: fonte única é channel_sessions.daily_message_limit.
-- ============================================================================
create table if not exists channel_knobs (
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  throttle_ms integer,                -- intervalo mínimo entre envios do número
  jitter_max_ms integer,              -- teto do jitter randômico somado ao throttle
  window_start_hour smallint,         -- janela [start, end) na hora local da org
  window_end_hour smallint,
  allow_sunday boolean,               -- domingo evitado por default
  timezone text,                      -- IANA tz da org (a janela é avaliada nela)
  -- degraus [{"minAgeDays":N,"cap":M|null}, ...]; CHECK (array NÃO-VAZIO) +
  -- validação de shape no load — NULL cai no default; `[]` é rejeitado.
  warmup_daily_caps jsonb
    constraint channel_knobs_warmup_caps_is_array
    check (
      warmup_daily_caps is null
      or (jsonb_typeof(warmup_daily_caps) = 'array' and jsonb_array_length(warmup_daily_caps) > 0)
    ),
  -- knobs de spinning / saúde (0011/0012): CHECK só garante "é objeto"; campo a
  -- campo é validado no load. NULL ou shape inválido → defaults conservadores.
  spinning_knobs jsonb
    constraint channel_knobs_spinning_is_object
    check (spinning_knobs is null or jsonb_typeof(spinning_knobs) = 'object'),
  health_knobs jsonb
    constraint channel_knobs_health_is_object
    check (health_knobs is null or jsonb_typeof(health_knobs) = 'object'),
  number_activated_at timestamptz not null default now(), -- idade do número p/ warm-up
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, channel_session_id)
);

-- Ledger de envios efetivados por número — estado durável do throttle e dos caps
-- diários (na tz da org).
create table if not exists pacing_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  sent_at timestamptz not null default now()
);
create index if not exists idx_pacing_ledger_session
  on pacing_ledger (organization_id, channel_session_id, sent_at desc);

-- 0011 — janela deslizante de copies enviadas (gate anti-template-idêntico):
-- copy NORMALIZADA das últimas outbound por NÚMERO (across contatos).
create table if not exists outbound_copies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  normalized_text text not null,      -- copy normalizada (lower/trim/whitespace) p/ similaridade
  normalized_hash text not null,      -- sha256 do normalizado p/ igualdade exata
  sent_at timestamptz not null default now()
);
create index if not exists idx_outbound_copies_session
  on outbound_copies (organization_id, channel_session_id, sent_at desc);

-- ============================================================================
-- 0013 — cron persistente POR CONTATO. Irmão da fila: a fila processa AGORA, o
-- cron AGENDA e, no disparo, ENFILEIRA um job em job_queue. Sobrevive a restart
-- porque TODO o estado mora aqui.
-- ============================================================================
create table if not exists cron_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  kind text not null check (kind in ('at','every','cron')),
  --   'at'   → one-shot: next_run_at guarda o instante; dispara e desabilita.
  --   'every'→ recorrência fixa: interval_ms é o período (ms).
  --   'cron' → expressão 5-campos avaliada em tz (IANA).
  interval_ms bigint check (interval_ms is null or interval_ms > 0),
  cron_expr text,
  tz text not null default 'UTC',
  -- o que enfileirar quando disparar; coerência kind⇔contato é do CHECK de
  -- job_queue no enqueue — cron mal-configurado falha PERMANENTE (23514), nunca
  -- silenciosamente.
  job_kind text not null default 'followup_turn'
    check (job_kind in ('inbound_turn','followup_turn','watchdog','flywheel')),
  payload jsonb not null default '{}',
  -- próximo disparo — JÁ com o offset de stagger determinístico (anti-rajada).
  next_run_at timestamptz not null,
  enabled boolean not null default true,
  -- retry do disparo CORRENTE: transiente incrementa + adia (backoff); esgotar
  -- max_attempts desabilita + agent_inbox_items.
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  last_error text,                        -- normalizado/truncado — nunca PII
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'every' or interval_ms is not null),
  check (kind <> 'cron' or cron_expr is not null)
);
create index if not exists idx_cron_jobs_due on cron_jobs (next_run_at)
  where enabled = true;

-- ============================================================================
-- 0014 — templates de re-entrada versionados + ponteiro. Uma versão guarda N
-- VARIANTES pt-br de spinning; a re-entrada determinística envia a variante
-- DIRETO pela cadeia de guardrails, sem LLM — custo $0.
-- ============================================================================
create table if not exists reentry_template_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  variants text[] not null check (array_length(variants, 1) >= 1),
  created_at timestamptz not null default now()
);

drop trigger if exists trg_reentry_template_versions_immutable on reentry_template_versions;
create trigger trg_reentry_template_versions_immutable
  before update on reentry_template_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists reentry_template_pointers (
  organization_id uuid primary key references organizations(id) on delete cascade,
  version_id uuid not null references reentry_template_versions(id),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- 0015 + 0016 — memória durável por contato. O ÍNDICE (headlines) é injetado no
-- sufixo do prompt com orçamento fixo; o CORPO vem sob demanda. Hard cap imposto
-- na ESCRITA (recusa nota que estouraria) — sem truncamento silencioso.
-- Nota de um contato NUNCA aparece em run de outro (query sempre filtra
-- organization_id + contact_id de fonte confiável).
-- ============================================================================
create table if not exists lead_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  headline text not null check (length(headline) > 0), -- a LINHA do índice
  body text not null check (length(body) > 0),         -- corpo sob demanda
  -- 0016: vetor derivado p/ recall híbrido. jsonb (array de floats), não pgvector:
  -- a DIMENSÃO é do provedor (BYOK agnóstico) e o conjunto por contato é pequeno
  -- (hard cap) ⇒ cosseno exato em app, sem índice ANN. Populado preguiçosamente;
  -- notas são write-once ⇒ o embedding cacheado nunca fica stale.
  embedding jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lead_notes_contact
  on lead_notes (organization_id, contact_id, created_at);

-- ============================================================================
-- 0017 — playbooks SITUACIONAIS como skills versionadas com disclosure
-- progressivo: só name+description (o ÍNDICE) reside no prompt; o body carrega
-- SÓ quando o matcher if-then DETERMINÍSTICO dispara. platform = global
-- (organization_id NULL, ex.: "STOP ambíguo"/compliance).
-- ============================================================================
create table if not exists skill_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade, -- NULL = plataforma (global)
  name text not null check (length(name) > 0),
  description text not null check (length(description) > 0),
  body text not null check (length(body) > 0), -- markdown ≤200 linhas; carrega SÓ no match
  -- { "any_keywords": string[], "probe_keywords"?: string[] } — shape validado no código.
  matcher jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

drop trigger if exists trg_skill_versions_immutable on skill_versions;
create trigger trg_skill_versions_immutable
  before update on skill_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists skill_pointers (
  organization_id uuid references organizations(id) on delete cascade, -- NULL = plataforma (global)
  name text not null check (length(name) > 0),
  version_id uuid not null references skill_versions(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists uniq_skill_pointers_org
  on skill_pointers (organization_id, name) where organization_id is not null;
create unique index if not exists uniq_skill_pointers_platform
  on skill_pointers (name) where organization_id is null;

-- ============================================================================
-- 0018 — tabela de preços/promessas versionada por ponteiro (anti-"vendo por
-- R$1"): o gate before_send carrega por ponteiro sob o lock de cada tentativa.
-- ============================================================================
create table if not exists promise_table_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- { minPriceCents?, maxDiscountPercent?, maxInstallments? } — shape validado no
  -- insert. Campo ausente = dimensão não fiscalizada.
  values jsonb not null,
  created_at timestamptz not null default now()
);

drop trigger if exists trg_promise_table_versions_immutable on promise_table_versions;
create trigger trg_promise_table_versions_immutable
  before update on promise_table_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists promise_table_pointers (
  organization_id uuid not null references organizations(id) on delete cascade,
  version_id uuid not null references promise_table_versions(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists uniq_promise_table_pointers_org
  on promise_table_pointers (organization_id);

-- ============================================================================
-- 0019 — template de disclosure "assistente virtual" versionado por ponteiro
-- (disclosure by design — CDC hoje / PL 2338 amanhã). Injetado na 1ª mensagem
-- (modo inject) ou exigido do modelo (modo veto).
-- ============================================================================
create table if not exists disclosure_template_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  body text not null, -- texto pt-br do disclosure
  created_at timestamptz not null default now()
);

drop trigger if exists trg_disclosure_template_versions_immutable on disclosure_template_versions;
create trigger trg_disclosure_template_versions_immutable
  before update on disclosure_template_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists disclosure_template_pointers (
  organization_id uuid not null references organizations(id) on delete cascade,
  version_id uuid not null references disclosure_template_versions(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists uniq_disclosure_template_pointers_org
  on disclosure_template_pointers (organization_id);

-- ============================================================================
-- 0021 — trace de auditoria da cadeia before_send por tentativa: array de gates
-- avaliados + gate/código do veto (null = passou). Escrita autônoma (fora da tx
-- serializada) — a auditoria do veto SOBREVIVE ao rollback. PII fora: só
-- gate/verdict/code/detail — o CORPO da mensagem NUNCA entra aqui.
-- ============================================================================
create table if not exists before_send_traces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null references job_queue(id) on delete cascade, -- RUN = job_queue.id
  contact_id uuid references contacts(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  -- GateTraceEntry[]: [{ gate, verdict, code?, detail? }, ...] — sem PII.
  trace jsonb not null,
  vetoed_gate text,
  vetoed_code text,
  created_at timestamptz not null default now()
);
create index if not exists idx_before_send_traces_run
  on before_send_traces (organization_id, job_id, created_at);

-- ============================================================================
-- 0023 — vereditos dos judges em produção, batch offline (NUNCA inline por
-- mensagem). Idempotente/resumível: unique (dataset, trace_id, dimension) +
-- on conflict do nothing. PII fora do DB: só metadata/proveniência anonimizada.
-- ============================================================================
create table if not exists flywheel_judge_verdicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  dataset text not null,               -- namespace da proveniência (replay)
  trace_id text not null,
  dimension text not null,
  verdict text not null check (verdict in ('yes', 'no', 'unknown')),
  option_order text not null,          -- auditoria da mitigação de position bias
  judge_family text not null,
  model text not null,
  -- ORIGEM do trace: proveniência do dataset (replay) ou playbook_version (live).
  provenance jsonb not null default '{}',
  run_id uuid not null,                -- agrupa uma RODADA de batch
  judged_at timestamptz not null default now()
);
create unique index if not exists uq_flywheel_judge_verdicts_key
  on flywheel_judge_verdicts (dataset, trace_id, dimension);
create index if not exists idx_flywheel_judge_verdicts_run
  on flywheel_judge_verdicts (organization_id, run_id);
create index if not exists idx_flywheel_judge_verdicts_dataset
  on flywheel_judge_verdicts (dataset, dimension);

-- ============================================================================
-- 0024 — CANDIDATOS de melhoria propostos pelo distiller isolado. NUNCA aplica:
-- aplicar é o merge sob gate humano. Este é o ÚNICO store de escrita do distiller
-- (anti "curator-takeover"). Cada proposta REFERENCIA a evidência que a motivou.
-- ============================================================================
create table if not exists flywheel_distiller_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  run_id uuid not null,
  dataset text not null,
  type text not null check (type in ('playbook_bullet', 'golden_case', 'reentry_trigger')),
  target text not null,                -- camada de playbook / arquivo golden / família de gatilho
  content text not null check (length(content) > 0), -- texto proposto, pt-br, sem PII
  evidence jsonb not null,             -- trace_ids + run_ids + taxa/amostra
  proposed_at timestamptz not null default now()
);
create index if not exists idx_flywheel_distiller_proposals_run
  on flywheel_distiller_proposals (organization_id, run_id);
create index if not exists idx_flywheel_distiller_proposals_dataset
  on flywheel_distiller_proposals (dataset, type);

-- ============================================================================
-- 0025 — MANUTENÇÃO do judge: rotaciona casos frescos julgados em produção para
-- um POOL de alinhamento (candidatos a novo lote de labels humanos no drift).
-- A unique é o DEDUP da rotação. (A extensão de kind 'judge_unaligned' já está
-- embutida no CHECK de agent_inbox_items acima.)
-- ============================================================================
create table if not exists judge_alignment_pool (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  dataset text not null,
  trace_id text not null,
  dimension text not null,
  added_at timestamptz not null default now()
);
create unique index if not exists uq_judge_alignment_pool_key
  on judge_alignment_pool (dataset, trace_id, dimension);
create index if not exists idx_judge_alignment_pool_dim
  on judge_alignment_pool (organization_id, dimension);

-- ============================================================================
-- 0026 — knobs de re-entrada (timing de follow-up + segmentação) versionados +
-- ponteiro. O 1º alvo concreto do flywheel: timing não é constante nem env —
-- é config versionada por org, otimizável e rollbackável pelo ponteiro.
-- ============================================================================
create table if not exists reentry_knob_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- { follow_up_window_hours: number>0, enabled_segments: string[] } — shape
  -- revalidado no insert.
  knobs jsonb not null,
  created_at timestamptz not null default now()
);

drop trigger if exists trg_reentry_knob_versions_immutable on reentry_knob_versions;
create trigger trg_reentry_knob_versions_immutable
  before update on reentry_knob_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists reentry_knob_pointers (
  organization_id uuid primary key references organizations(id) on delete cascade,
  version_id uuid not null references reentry_knob_versions(id),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- RLS — padrão do repo: tenant_isolation_<tabela>_all via fn_user_org_ids() +
-- revoke de anon. Nas tabelas com organization_id nullable (agent_inbox_items,
-- playbook_versions/pointers, skill_versions/pointers, metrics) a MESMA policy
-- serve: `null in (...)` nunca é true ⇒ linhas de plataforma são visíveis só ao
-- service role (que bypassa RLS).
-- ============================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'agent_inbox_items', 'job_queue', 'send_ledger',
    'playbook_versions', 'playbook_pointers',
    'channel_session_health', 'llm_calls',
    'lead_checkpoints', 'lead_state', 'lead_state_transitions',
    'metrics', 'channel_knobs', 'pacing_ledger', 'outbound_copies',
    'cron_jobs',
    'reentry_template_versions', 'reentry_template_pointers',
    'lead_notes', 'skill_versions', 'skill_pointers',
    'promise_table_versions', 'promise_table_pointers',
    'disclosure_template_versions', 'disclosure_template_pointers',
    'before_send_traces',
    'flywheel_judge_verdicts', 'flywheel_distiller_proposals',
    'judge_alignment_pool',
    'reentry_knob_versions', 'reentry_knob_pointers'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_%s_all on public.%I', t, t);
    execute format(
      'create policy tenant_isolation_%s_all on public.%I for all
         using (organization_id in (select * from public.fn_user_org_ids()))
         with check (organization_id in (select * from public.fn_user_org_ids()))',
      t, t
    );
    execute format('revoke all on public.%I from anon', t);
  end loop;
end
$$;

-- watchdog_cursors não tem organization_id (infra de plataforma): RLS habilitada
-- SEM policy ⇒ só o service role acessa.
alter table watchdog_cursors enable row level security;
revoke all on watchdog_cursors from anon;
