-- manifest: traço do turno do agente — uma linha por execução, chave `job_id` (issue #2869).

-- ═══ O que esta tabela responde, e por que ela existe ═════════════════════════
--
-- O turno real do agente é auditável hoje em pedaços que moram longe um do
-- outro: `llm_calls` guarda cada chamada de modelo, `skill_activations` guarda
-- quais skills entraram, `event_log` guarda a cadeia de eventos. Nenhuma linha
-- responde "o que aconteceu NESTE turno": quais ferramentas o modelo chamou (e
-- qual falhou), qual janela de histórico foi carregada, quais fontes de
-- conhecimento estavam ligadas e como o turno terminou. Um turno que respondeu
-- errado só se explica lendo o código.
--
-- ═══ Por que tabela nova, e não `ai_agent_runs` ═══════════════════════════════
--
-- `ai_agent_runs` nasceu com a forma disso (0023) e o motor vivo NUNCA escreveu
-- nela: o único escritor é a prévia (`is_dry_run = true`), e por isso a aba
-- Execuções passou a ler `llm_calls` (medido: 0 linhas em produção com 130
-- chamadas `agent_turn`). Reaproveitá-la significaria decidir, de passagem, que
-- ela volta a ser a fonte do turno real — decisão do mantenedor, não nossa.
-- Esta tabela é ADITIVA: a tela de Execuções continua lendo o que já lê.
--
-- ═══ Por que SEM trigger de auditoria ════════════════════════════════════════
--
-- Toda outra tabela do módulo de IA audita cada linha. Aqui não, de propósito:
-- é uma escrita por TURNO, e o conteúdo do traço já é o registro do que
-- aconteceu. Auditar a auditoria dobraria o volume de `audit_log` sem responder
-- nenhuma pergunta nova. Se a política mudar, é um `create trigger` de uma linha.
--
-- ═══ O que esta fatia ainda NÃO grava ════════════════════════════════════════
--
-- O snapshot/hash da composição do prompt, os trechos de conhecimento
-- efetivamente recuperados, a janela de histórico REALMENTE carregada (a coluna
-- `historico_mensagens` existe para a fatia que medir isso, e nasce `null` em
-- vez de receber a janela PEDIDA, que é outra coisa) e a comparação entre a
-- resposta crua do modelo e o texto enviado ficam para as fatias seguintes. O
-- que esta já separa é prévia de turno real (`is_dry_run`).

create table if not exists public.agent_turn_traces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Turno real: `job_id` (o job da fila É o run). Prévia: `preview_run_id`.
  -- Exatamente um dos dois — o CHECK abaixo é o que impede a linha órfã.
  job_id uuid,
  preview_run_id text,
  conversation_id uuid,
  contact_id uuid,
  agent_id uuid,
  agent_version_id uuid,
  is_dry_run boolean not null default false,
  status text not null check (status in ('completed', 'failed', 'aborted')),
  abort_reason text,
  error_code text,
  error_message text,
  provider text,
  model text,
  messages_sent integer not null default 0 check (messages_sent >= 0),
  historico_mensagens integer check (historico_mensagens is null or historico_mensagens >= 0),
  -- Agregados do job, somados na hora de gravar (não há segunda escrita).
  tokens_in integer not null default 0 check (tokens_in >= 0),
  tokens_out integer not null default 0 check (tokens_out >= 0),
  cost_cents numeric not null default 0,
  latency_ms integer not null default 0 check (latency_ms >= 0),
  -- Skills ativadas no turno (`skill_activations` do mesmo job).
  skills jsonb not null default '[]'::jsonb,
  -- Ferramentas chamadas: nome, estado (ok|falhou|bloqueada), erro e duração.
  ferramentas jsonb not null default '[]'::jsonb,
  ferramentas_truncadas boolean not null default false,
  -- Fontes de conhecimento ligadas ao agente, com versão e hash.
  kb_sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_turn_traces_chave check (
    (job_id is not null and preview_run_id is null)
    or (job_id is null and preview_run_id is not null)
  )
);

comment on table public.agent_turn_traces is
  'Uma linha por execução do agente (issue #2869): chave `job_id` no turno real, `preview_run_id` na prévia. Agrega tokens/custo/latência de `llm_calls` e as skills de `skill_activations` do mesmo job, e guarda o que só existe no turno: as ferramentas chamadas (nome, estado, erro, duração), a janela de histórico e as fontes de conhecimento ligadas. Escrita melhor-esforço pelo motor — falhar aqui nunca derruba o atendimento.';

-- A chave do turno real. Parcial de propósito: a prévia não tem job, e uma
-- coluna nula não colide no Postgres — sem o `where`, o upsert do turno real
-- não teria em que se apoiar (e o `on conflict` da gravação é o que torna a
-- repetição de um turno idempotente em vez de duplicar a linha).
create unique index if not exists agent_turn_traces_job_idx
  on public.agent_turn_traces (job_id) where job_id is not null;

create index if not exists agent_turn_traces_org_created_idx
  on public.agent_turn_traces (organization_id, created_at desc);

create index if not exists agent_turn_traces_preview_idx
  on public.agent_turn_traces (preview_run_id) where preview_run_id is not null;

-- O agregado do traço lê `skill_activations` pelo `job_id` a cada turno, e a
-- tabela só tinha índice por organização e por skill (0078). Sem isto, cada
-- turno paga uma varredura da tabela inteira para descobrir o que ele mesmo
-- acabou de gravar.
create index if not exists idx_skill_activations_job
  on public.skill_activations (job_id) where job_id is not null;

-- RLS: o traço é da organização e ninguém mais o lê. A leitura é do painel
-- (sessão do usuário, `authenticated`), por uma policy só de `select`. A
-- escrita é só do worker, que passa por fora do RLS: por isso `authenticated`
-- perde o grant de escrita (o molde de `automation_rodizio_atribuicoes`, 0692),
-- e `anon` não recebe nada em hipótese alguma: um traço carrega o texto do erro
-- e os ids das fontes de conhecimento.
alter table public.agent_turn_traces enable row level security;

drop policy if exists tenant_isolation_agent_turn_traces_all on public.agent_turn_traces;
drop policy if exists tenant_isolation_agent_turn_traces_select on public.agent_turn_traces;
create policy tenant_isolation_agent_turn_traces_select on public.agent_turn_traces
  for select using (organization_id in (select public.fn_user_org_ids()));

revoke all on public.agent_turn_traces from anon, authenticated;
grant select on public.agent_turn_traces to authenticated;
grant all on public.agent_turn_traces to service_role;
