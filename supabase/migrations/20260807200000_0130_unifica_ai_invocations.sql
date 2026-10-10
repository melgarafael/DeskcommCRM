-- ============================================================================
-- 0130 — UMA TABELA DE TELEMETRIA DE IA, NÃO DUAS.
--
-- `ai_invocations` (workers legados) e `llm_calls` (agent-engine) contam a mesma
-- coisa em lugares diferentes. O sintoma já está documentado no código: a tela
-- de uso lia só a primeira e mostrava ZERO custo enquanto o dinheiro saía —
-- medido numa VPS, 90 chamadas e R$ 0,15 gastos com a tela em branco. O remendo
-- foi a API somar as duas, o que resolve a tela e deixa a raiz de pé: toda
-- leitura nova de telemetria precisa lembrar das duas, e a que esquecer mente.
--
-- Aqui a raiz é fechada. `llm_calls` vira a única, e `ai_invocations` fica como
-- histórico — **não é apagada**: a doutrina do repo é depreciar, não deletar, e
-- as linhas antigas ainda são a prova do que foi gasto.
--
-- ## A marca que torna o backfill idempotente
--
-- `legacy_invocation_id` guarda o id da linha de origem, com índice único. O
-- `update.sh` do self-hoster re-aplica o baseline inteiro a cada atualização;
-- sem essa marca, cada execução re-inseriria as mesmas linhas e o custo do mês
-- passado cresceria sozinho a cada update — um erro que ninguém veria acontecer
-- e que aparece como "a conta subiu" sem nenhuma chamada nova.
-- ============================================================================

-- `agent_id` NÃO existia em llm_calls, e sem ele a unificação jogaria fora a
-- atribuição de custo por agente — junto com o filtro por agente da tela de uso,
-- que é como o operador descobre qual agente está consumindo a conta. Perder uma
-- capacidade em nome de unificar seria trocar um problema por outro.
alter table public.llm_calls add column if not exists agent_id uuid
  references public.ai_agents(id) on delete set null;
create index if not exists llm_calls_agent_idx
  on public.llm_calls (organization_id, agent_id, created_at desc) where agent_id is not null;

alter table public.llm_calls add column if not exists legacy_invocation_id uuid;

create unique index if not exists llm_calls_legacy_invocation_unique
  on public.llm_calls (legacy_invocation_id) where legacy_invocation_id is not null;

comment on column public.llm_calls.legacy_invocation_id is
  'Migration 0130: id da linha de ai_invocations que originou esta. Existe para o backfill ser '
  'idempotente — o update.sh re-aplica o baseline a cada atualização, e sem esta marca o custo '
  'histórico cresceria sozinho a cada execução.';

-- O backfill. `on conflict do nothing` sobre o índice único faz a re-execução
-- ser inócua. `purpose` recebe o `invocation_kind` porque é o mesmo eixo com
-- nomes diferentes; o vocabulário de ambos já está no registro de pontos.
insert into public.llm_calls (
  organization_id, agent_id, contact_id, job_id, purpose, provider, model,
  input_tokens, output_tokens, cost_cents, latency_ms, created_at,
  status, error_code, legacy_invocation_id
)
select
  i.organization_id,
  i.agent_id,
  null,                       -- ai_invocations guarda conversation/message, não contato
  null,
  i.invocation_kind,
  -- O provider não era guardado; deriva-se do prefixo do modelo, e quando não
  -- dá para saber vai 'desconhecido' em vez de um chute que viraria estatística.
  case
    when i.model like 'anthropic/%' then 'anthropic'
    when i.model like 'openai/%'    then 'openai'
    when i.model like 'google/%'    then 'google'
    when i.model like 'claude%'     then 'anthropic'
    when i.model like 'gpt%'        then 'openai'
    when i.model like 'gemini%'     then 'google'
    else 'desconhecido'
  end,
  i.model,
  i.prompt_tokens,
  i.completion_tokens,
  i.cost_cents,
  i.latency_ms,
  i.created_at,
  case when i.error_payload is not null then 'erro' else 'ok' end,
  case when i.error_payload is not null then 'erro_legado' else null end,
  i.id
from public.ai_invocations i
where not exists (
  select 1 from public.llm_calls c where c.legacy_invocation_id = i.id
)
on conflict do nothing;

comment on table public.ai_invocations is
  'DEPRECIADA na migration 0130 — a telemetria de IA vive em llm_calls. Mantida como histórico '
  '(a doutrina do repo é depreciar, não deletar) e porque as linhas antigas são a prova do que foi '
  'gasto. Nada escreve mais aqui; leituras novas usam llm_calls.';
