-- Uma decisão por mensagem do roteador, sem conteúdo da conversa. Mantém a
-- distinção entre comparação integral e reserva acionada sob demanda.
alter table public.jev_observacoes add column if not exists intencao_jev text;
alter table public.jev_observacoes add column if not exists intencao_atual text;

create table if not exists public.jev_router_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  router_id uuid not null,
  conversation_id uuid,
  message_id uuid,
  job_id uuid,
  modo text not null check (modo in ('tradicional_comparacao', 'jev_comparacao', 'jev_sob_demanda')),
  context_message_count integer not null check (context_message_count between 0 and 16),
  origem text not null check (origem in ('tradicional', 'jev', 'reserva')),
  motivo_reserva text check (motivo_reserva in ('falha_jev', 'baixa_confianca', 'sem_intencao', 'intencao_invalida')),
  intent_jev text,
  intent_tradicional text,
  intent_final text,
  agent_id_final uuid,
  confianca_final numeric,
  modelo_jev text,
  custo_jev_cents numeric,
  custo_tradicional_cents numeric,
  custo_incompleto boolean not null default false,
  tempo_total_ms integer not null,
  revisao text check (revisao in ('correto', 'incorreto')),
  agent_id_esperado uuid,
  revisado_por uuid,
  revisado_em timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists jev_router_decisions_org_message_idx
  on public.jev_router_decisions (organization_id, router_id, message_id)
  where message_id is not null;
create index if not exists jev_router_decisions_org_created_idx
  on public.jev_router_decisions (organization_id, created_at desc);

alter table public.jev_router_decisions enable row level security;
drop policy if exists tenant_isolation_jev_router_decisions_select on public.jev_router_decisions;
create policy tenant_isolation_jev_router_decisions_select on public.jev_router_decisions
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.jev_router_decisions from public, anon, authenticated;
grant select on public.jev_router_decisions to authenticated;
grant all on public.jev_router_decisions to service_role;

-- O mesmo horizonte das observações do Jev: 90 dias, piso de 30, com lote
-- compartilhado. O cron existente já chama esta função diariamente.
create or replace function public.fn_expurgar_observacoes_do_jev(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 90), 30);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_observacoes int;
  v_decisoes int;
begin
  with vencidas as (
    select id from public.jev_observacoes
     where created_at < now() - make_interval(days => v_dias)
     order by created_at limit v_limite
  )
  delete from public.jev_observacoes o using vencidas v where o.id = v.id;
  get diagnostics v_observacoes = row_count;
  with vencidas as (
    select id from public.jev_router_decisions
     where created_at < now() - make_interval(days => v_dias)
     order by created_at limit (v_limite - v_observacoes)
  )
  delete from public.jev_router_decisions d using vencidas v where d.id = v.id;
  get diagnostics v_decisoes = row_count;
  return v_observacoes + v_decisoes;
end;
$$;
revoke all on function public.fn_expurgar_observacoes_do_jev(int,int) from public;
revoke execute on function public.fn_expurgar_observacoes_do_jev(int,int) from anon, authenticated;
grant execute on function public.fn_expurgar_observacoes_do_jev(int,int) to service_role;

notify pgrst, 'reload schema';
