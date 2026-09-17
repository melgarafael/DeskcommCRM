create table if not exists public.advomax_ai_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  external_request_id text not null,
  purpose text not null,
  provider text not null,
  model text not null,
  estimated_cost_cents numeric,
  status text not null default 'reserved' check (status in ('reserved', 'finalized', 'failed')),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  unique (organization_id, external_request_id)
);

create index if not exists idx_advomax_ai_reservations_active
  on public.advomax_ai_budget_reservations (organization_id, expires_at)
  where status = 'reserved';

alter table public.advomax_ai_budget_reservations enable row level security;
revoke all on table public.advomax_ai_budget_reservations from public, anon, authenticated;
grant select, insert, update on table public.advomax_ai_budget_reservations to service_role;

create or replace function public.fn_reservar_orcamento_advomax_ia(
  p_org uuid,
  p_external_request_id text,
  p_purpose text,
  p_provider text,
  p_model text,
  p_estimated_cost_cents numeric
) returns table(allowed boolean, idempotent boolean, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_budget public.ai_budgets%rowtype;
  v_spent numeric;
  v_reserved numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 0));

  if exists (
    select 1 from public.advomax_ai_budget_reservations
     where organization_id = p_org and external_request_id = p_external_request_id
       and (purpose, provider, model) is distinct from (p_purpose, p_provider, p_model)
  ) then
    return query select false, false, 'idempotency_conflict'::text;
    return;
  elsif exists (
    select 1 from public.advomax_ai_budget_reservations
     where organization_id = p_org and external_request_id = p_external_request_id
  ) then
    return query select true, true, 'already_reserved'::text;
    return;
  end if;

  select * into v_budget from public.ai_budgets where organization_id = p_org;
  select coalesce(sum(cost_cents), 0) into v_spent
    from public.llm_calls
   where organization_id = p_org and created_at >= date_trunc('month', now());
  select coalesce(sum(estimated_cost_cents), 0) into v_reserved
    from public.advomax_ai_budget_reservations
   where organization_id = p_org and status = 'reserved' and expires_at > now();

  if v_budget.enforcement_mode = 'bloquear'
     and v_budget.enforcement_effective_at <= now()
     and coalesce(v_spent, 0) + coalesce(v_reserved, 0) + coalesce(p_estimated_cost_cents, 0) >= v_budget.monthly_limit_cents
     and exists (
       select 1 from public.agent_inbox_items
        where organization_id = p_org and kind = 'budget_warning'
          and created_at >= date_trunc('month', now())
     ) then
    return query select false, false, 'monthly_limit_reached'::text;
    return;
  end if;

  insert into public.advomax_ai_budget_reservations
    (organization_id, external_request_id, purpose, provider, model, estimated_cost_cents)
  values (p_org, p_external_request_id, p_purpose, p_provider, p_model, p_estimated_cost_cents);
  return query select true, false, 'reserved'::text;
end;
$$;

revoke execute on function public.fn_reservar_orcamento_advomax_ia(uuid,text,text,text,text,numeric)
  from public, anon, authenticated;
grant execute on function public.fn_reservar_orcamento_advomax_ia(uuid,text,text,text,text,numeric)
  to service_role;

create or replace function public.fn_finalizar_advomax_ia(
  p_org uuid, p_external_request_id text, p_purpose text, p_provider text, p_model text,
  p_input_tokens int, p_output_tokens int, p_cache_read_tokens int, p_cache_write_tokens int,
  p_latency_ms int, p_cost_cents numeric
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_inserted boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 0));
  if not exists (select 1 from public.advomax_ai_budget_reservations where organization_id = p_org and external_request_id = p_external_request_id and purpose = p_purpose and provider = p_provider and model = p_model) then
    raise exception 'advomax_ai_reservation_not_found' using errcode = 'P0001';
  end if;
  insert into public.llm_calls (organization_id, external_request_id, purpose, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, cost_cents, status)
  values (p_org, p_external_request_id, p_purpose, p_provider, p_model, p_input_tokens, p_output_tokens, p_cache_read_tokens, p_cache_write_tokens, p_latency_ms, p_cost_cents, 'ok')
  on conflict (organization_id, external_request_id) where external_request_id is not null do nothing;
  get diagnostics v_inserted = row_count;
  update public.advomax_ai_budget_reservations set status = 'finalized', finalized_at = coalesce(finalized_at, now()) where organization_id = p_org and external_request_id = p_external_request_id;
  return v_inserted;
end; $$;
revoke execute on function public.fn_finalizar_advomax_ia(uuid,text,text,text,text,int,int,int,int,int,numeric) from public, anon, authenticated;
grant execute on function public.fn_finalizar_advomax_ia(uuid,text,text,text,text,int,int,int,int,int,numeric) to service_role;

comment on table public.advomax_ai_budget_reservations is
  'Reservas server-only que fecham a corrida entre o gate do CRM e a chamada nativa de IA no Advomax Gestão. Não contém prompt, resposta ou credencial.';
