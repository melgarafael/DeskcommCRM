-- ============================================================================
-- 2026-09-26 — 0421: AS OBSERVAÇÕES DO JEV (onda 2 do Jev, bloco 2.1)
--
-- Toda tarefa nova do Jev nasce OBSERVANDO: ele opina, o mecanismo de hoje
-- decide, e a tela mostra quanto os dois concordaram antes de alguém deixá-lo
-- decidir. A primeira é a manipulação (`jailbreak_detect`), no turno do agente.
-- Esta tabela é onde a concordância mora, uma linha por resposta do Jev.
--
-- Por que uma tabela, e não `llm_calls` nem `messages.metadata`: `llm_calls` não
-- tem coluna para rótulo nem probabilidade, e uma chamada com várias perguntas
-- é UMA linha lá para N tarefas; o clima em `messages.metadata` já é lido sem
-- índice. Aqui não há texto de cliente — só rótulos, probabilidades e ponteiros.
--
-- Idempotente: `create ... if not exists`, policy por `drop if exists` +
-- `create`, função `create or replace`, grants reemitidos. Função nova em
-- `public`: revogada das DUAS origens (`public` e `anon`) e de `authenticated`,
-- executável só pelo `service_role` (item 9 da doutrina de migrations).
-- ============================================================================

create table if not exists public.jev_observacoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- `TAREFAS_DO_JEV` (lib/ai/decisao/tarefas.ts). Vocabulário ABERTO, sem CHECK:
  -- cada tarefa nova seria uma migration só para caber aqui.
  tarefa text not null,
  -- O estado da tarefa quando o Jev respondeu. Desligada não pergunta nada.
  estado text not null
    constraint jev_observacoes_estado_check check (estado in ('observando', 'decidindo')),
  -- Ponteiros, SEM FK de propósito: uma FK para messages/contacts travaria a
  -- anonimização ou apagaria a observação junto do histórico, e a linha não
  -- guarda nada da pessoa para redigir.
  conversation_id uuid,
  message_id uuid,
  job_id uuid,
  rotulo_jev text,
  probabilidade_jev numeric,
  confianca_jev numeric,
  -- O que o mecanismo de hoje decidiu. NULL = ele não decidiu (falhou): sem par.
  rotulo_atual text,
  -- NULL quando falta um dos lados — "sem par" não é discordância.
  concordou boolean generated always as (
    case when rotulo_jev is null or rotulo_atual is null then null
         else rotulo_jev = rotulo_atual end
  ) stored,
  modelo text,
  latencia_ms integer,
  created_at timestamptz not null default now()
);

comment on table public.jev_observacoes is
  'O Jev ao lado do mecanismo de hoje, tarefa a tarefa: o rótulo de cada um e se concordaram. Sem texto de cliente. Escrita só pelo servidor (lib/ai/decisao); lida pelo cartão do Jev (GET /api/v1/ai/jev). Expurgada por fn_expurgar_observacoes_do_jev (cron data-retention).';

-- A leitura do cartão: uma organização, uma tarefa, os últimos 30 dias.
create index if not exists jev_observacoes_org_tarefa_criada_idx
  on public.jev_observacoes (organization_id, tarefa, created_at desc);
-- A poda: a ponta mais velha, de todas as organizações.
create index if not exists jev_observacoes_criada_idx
  on public.jev_observacoes (created_at);
-- Uma resposta por tarefa e mensagem: o retry do job pergunta de novo sobre a
-- mesma, e a segunda contaria em dobro na concordância. Sem deduplicar antes:
-- a tabela nasce nesta migration, sem linha nenhuma.
create unique index if not exists jev_observacoes_uma_por_mensagem_idx
  on public.jev_observacoes (organization_id, tarefa, message_id)
  where message_id is not null;

-- Leitura por qualquer membro da organização (é concordância, não dado de
-- pessoa); escrita só do servidor, que passa por cima da RLS. Sem policy ALL:
-- `authenticated` não tem por que escrever aqui.
alter table public.jev_observacoes enable row level security;
drop policy if exists tenant_isolation_jev_observacoes_select on public.jev_observacoes;
create policy tenant_isolation_jev_observacoes_select on public.jev_observacoes
  for select using (organization_id in (select public.fn_user_org_ids()));

-- O ALTER DEFAULT PRIVILEGES do baseline dá GRANT ALL em TABLES a `anon`: toda
-- tabela nova nasce exposta e revoga por conta própria.
revoke all on public.jev_observacoes from anon, authenticated;
grant select on public.jev_observacoes to authenticated;
grant all on public.jev_observacoes to service_role;

-- O prazo: padrão 90 dias (JEV_OBSERVACOES_RETENTION_DAYS), piso 30 — a janela
-- da concordância no cartão. Abaixo dela o cartão diria "30 dias" contando
-- menos. O piso mora NO CORPO, para valer contra qualquer chamador.
create or replace function public.fn_expurgar_observacoes_do_jev(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 90), 30);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select o.id from public.jev_observacoes o
     where o.created_at < now() - make_interval(days => v_dias)
     order by o.created_at
     limit v_limite
  )
  delete from public.jev_observacoes o using vencidas v where o.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
revoke all    on function public.fn_expurgar_observacoes_do_jev(int,int) from public;
revoke execute on function public.fn_expurgar_observacoes_do_jev(int,int) from anon;
revoke execute on function public.fn_expurgar_observacoes_do_jev(int,int) from authenticated;
grant  execute on function public.fn_expurgar_observacoes_do_jev(int,int) to service_role;
