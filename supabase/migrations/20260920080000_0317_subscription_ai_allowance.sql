-- Commercial credit is BRL. The conversion below is a fixed service tariff,
-- not a claim about spot FX. Each billing period snapshots its tariff and grant.
alter table public.subscription_plan_limits add column if not exists ai_credit_cents integer;
alter table public.subscription_plan_limits add column if not exists ai_usd_to_brl_rate numeric;
update public.subscription_plan_limits set
 ai_credit_cents=case plan_id when 'essencial' then 3000 when 'crescer' then 8000 when 'escala' then 18000 end,
 ai_usd_to_brl_rate=6
where plan_id in ('essencial','crescer','escala') and ai_credit_cents is null;

create table if not exists public.subscription_ai_periods (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 provider_subscription_id text not null,
 period_start timestamptz not null,
 period_end timestamptz not null,
 budget_brl_cents numeric not null check (budget_brl_cents>0 and budget_brl_cents<'Infinity'::numeric),
 usd_to_brl_rate numeric not null check (usd_to_brl_rate>0 and usd_to_brl_rate<'Infinity'::numeric),
 revision bigint not null default 0,
 created_at timestamptz not null default now(),
 unique (organization_id,provider_subscription_id,period_start),
 unique (id,organization_id),
 check (isfinite(period_start) and isfinite(period_end) and period_start<period_end)
);
create table if not exists public.subscription_ai_reservations (
 id uuid primary key,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 period_id uuid not null,
 reserved_brl_cents numeric not null check (reserved_brl_cents>0 and reserved_brl_cents<'Infinity'::numeric),
 cost_usd_cents numeric check (cost_usd_cents>=0 and cost_usd_cents<'Infinity'::numeric),
 charged_brl_cents numeric check (charged_brl_cents>=0 and charged_brl_cents<'Infinity'::numeric),
 status text not null default 'reserved' check (status in ('reserved','settled','unknown')),
 created_at timestamptz not null default now(),
 settled_at timestamptz,
 foreign key (period_id,organization_id) references public.subscription_ai_periods(id,organization_id) on delete cascade,
 check ((status='settled' and cost_usd_cents is not null and charged_brl_cents is not null and settled_at is not null)
     or (status in ('reserved','unknown') and cost_usd_cents is null and charged_brl_cents is null and settled_at is null))
);
create index if not exists subscription_ai_reservations_period on public.subscription_ai_reservations(organization_id,period_id,status);
alter table public.subscription_ai_periods enable row level security;
alter table public.subscription_ai_reservations enable row level security;
revoke all on public.subscription_ai_periods,public.subscription_ai_reservations from public,anon,authenticated;
grant all on public.subscription_ai_periods,public.subscription_ai_reservations to service_role;

create or replace function public.fn_reserve_subscription_ai(p_org uuid,p_call uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
 s public.org_subscriptions%rowtype;
 p public.subscription_ai_periods%rowtype;
 credit numeric;
 conversion numeric;
 spent numeric;
 held numeric;
 reserve_amount numeric;
begin
 -- Same serialization as resource reservations, including repeatable-read transactions.
 update public.org_subscriptions set quota_revision=quota_revision+1
 where organization_id=p_org and provider_subscription_id is not null returning * into s;
 if not found then return null; end if; -- Unconverted legacy company.
 if s.status not in ('active','trialing') or s.current_period_start is null
    or s.current_period_start>now() or s.current_period_end<=now() then
   raise exception 'Sua assinatura precisa de confirmação antes de usar a franquia de IA.' using errcode='P4021';
 end if;
 select ai_credit_cents,ai_usd_to_brl_rate into credit,conversion from public.subscription_plan_limits where plan_id=s.plan_id;
 if credit is null or conversion is null then
   raise exception 'Franquia de IA indisponível para este plano.' using errcode='P4021';
 end if;
 insert into public.subscription_ai_periods(organization_id,provider_subscription_id,period_start,period_end,budget_brl_cents,usd_to_brl_rate)
 values(p_org,s.provider_subscription_id,s.current_period_start,s.current_period_end,credit,conversion)
 on conflict(organization_id,provider_subscription_id,period_start) do nothing;
 update public.subscription_ai_periods set revision=revision+1
 where organization_id=p_org and provider_subscription_id=s.provider_subscription_id and period_start=s.current_period_start returning * into p;
 if exists(select 1 from public.subscription_ai_reservations where organization_id=p_org and period_id=p.id and status='unknown') then
   raise exception 'O consumo anterior de IA precisa ser conferido. Sua franquia foi preservada.' using errcode='P4021';
 end if;
 if exists(select 1 from public.subscription_ai_reservations where id=p_call) then
   raise exception 'Esta execução já possui uma reserva de IA.' using errcode='P4022';
 end if;
 select coalesce(sum(charged_brl_cents) filter(where status='settled'),0),
        coalesce(sum(reserved_brl_cents) filter(where status<>'settled'),0)
 into spent,held from public.subscription_ai_reservations where organization_id=p_org and period_id=p.id;
 reserve_amount:=least(100,p.budget_brl_cents-spent-held);
 if reserve_amount<=0 then
   raise exception 'A franquia de IA está esgotada ou reservada por atendimentos em andamento.' using errcode='P4021';
 end if;
 insert into public.subscription_ai_reservations(id,organization_id,period_id,reserved_brl_cents)
 values(p_call,p_org,p.id,reserve_amount);
 return p_call;
end $$;

create or replace function public.fn_settle_subscription_ai(p_org uuid,p_call uuid,p_cost_usd_cents numeric)
returns numeric language plpgsql security definer set search_path=public,pg_temp as $$
declare
 period uuid;
 p public.subscription_ai_periods%rowtype;
 r public.subscription_ai_reservations%rowtype;
 occupied numeric;
 charge numeric;
begin
 if p_cost_usd_cents is not null and (p_cost_usd_cents<0 or p_cost_usd_cents>='Infinity'::numeric) then
   raise exception 'Custo inválido.' using errcode='P4022';
 end if;
 select period_id into period from public.subscription_ai_reservations where organization_id=p_org and id=p_call;
 if not found then raise exception 'Reserva não encontrada.' using errcode='P4022'; end if;
 -- Settle against the original period even if the subscription has since renewed or canceled.
 update public.subscription_ai_periods set revision=revision+1 where id=period and organization_id=p_org returning * into p;
 select * into r from public.subscription_ai_reservations where id=p_call and organization_id=p_org for update;
 if r.status='settled' then
   if r.cost_usd_cents is distinct from p_cost_usd_cents then
     raise exception 'Custo já conciliado com outro valor.' using errcode='P4022';
   end if;
   return r.charged_brl_cents;
 end if;
 if p_cost_usd_cents is null then
   update public.subscription_ai_reservations set status='unknown' where id=p_call and organization_id=p_org;
   return null; -- Never manufacture zero or automatically release an ambiguous call.
 end if;
 select coalesce(sum(case when status='settled' then charged_brl_cents else reserved_brl_cents end),0)
 into occupied from public.subscription_ai_reservations where organization_id=p_org and period_id=period and id<>p_call;
 -- R$1 is a concurrency reservation, not an estimated provider price or extra charge.
 -- Provider cost above available credit is absorbed by the platform, never billed automatically.
 charge:=least(p_cost_usd_cents*p.usd_to_brl_rate,greatest(0,p.budget_brl_cents-occupied));
 update public.subscription_ai_reservations set status='settled',cost_usd_cents=p_cost_usd_cents,
 charged_brl_cents=charge,settled_at=now() where organization_id=p_org and id=p_call;
 return charge;
end $$;
revoke all on function public.fn_reserve_subscription_ai(uuid,uuid) from public,anon,authenticated;
revoke all on function public.fn_settle_subscription_ai(uuid,uuid,numeric) from public,anon,authenticated;
grant execute on function public.fn_reserve_subscription_ai(uuid,uuid) to service_role;
grant execute on function public.fn_settle_subscription_ai(uuid,uuid,numeric) to service_role;
