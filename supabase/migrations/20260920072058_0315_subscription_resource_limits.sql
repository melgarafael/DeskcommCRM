-- Published plan capacities. Tenant roles cannot edit the commercial catalogue.
create table if not exists public.subscription_plan_limits (
  plan_id text primary key,
  seats integer not null check (seats > 0),
  channels integer not null check (channels > 0),
  agents integer not null check (agents > 0)
);
alter table public.subscription_plan_limits enable row level security;
revoke all on public.subscription_plan_limits from public, anon, authenticated;
grant select on public.subscription_plan_limits to service_role;
insert into public.subscription_plan_limits(plan_id,seats,channels,agents) values
 ('essencial',2,1,2),('crescer',5,3,5),('escala',15,8,15)
on conflict(plan_id) do update set seats=excluded.seats,channels=excluded.channels,agents=excluded.agents;

-- A row write serializes reservations, including under repeatable-read isolation.
-- Do not change updated_at: it also anchors unresolved checkout retries.
alter table public.org_subscriptions add column if not exists quota_revision bigint not null default 0;

create or replace function public.fn_subscription_resource_limit()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  target_org uuid := new.organization_id;
  counted_new boolean;
  counted_old boolean := false;
  sub public.org_subscriptions%rowtype;
  capacity integer;
  used_slots bigint;
  resource_label text;
begin
  if tg_table_name='user_organizations' then
    counted_new := new.revoked_at is null;
    if tg_op='UPDATE' then counted_old := old.revoked_at is null; end if;
  elsif tg_table_name in ('ai_agents','channel_sessions') then
    counted_new := new.archived_at is null;
    if tg_op='UPDATE' then counted_old := old.archived_at is null; end if;
  else raise exception 'unsupported_subscription_resource';
  end if;
  -- Editing an existing resource and releasing capacity must remain possible,
  -- including after downgrade, overdue payment or cancellation.
  if not counted_new then return new; end if;
  if tg_op='UPDATE' and counted_old and old.organization_id=target_org then return new; end if;

  update public.org_subscriptions set quota_revision=quota_revision+1
   where organization_id=target_org and provider_subscription_id is not null
   returning * into sub;
  if not found then return new; end if; -- legacy or unconfirmed checkout: no commercial conversion

  if sub.status not in ('active','trialing') or sub.current_period_end is null or sub.current_period_end<=now() then
    raise exception 'Regularize sua assinatura para adicionar novos recursos. Seus recursos atuais foram preservados.' using errcode='P4020';
  end if;
  if tg_table_name='ai_agents' then
    select agents into capacity from public.subscription_plan_limits where plan_id=sub.plan_id;
    select count(*) into used_slots from public.ai_agents where organization_id=target_org and archived_at is null;
    resource_label := 'agentes';
  elsif tg_table_name='channel_sessions' then
    select channels into capacity from public.subscription_plan_limits where plan_id=sub.plan_id;
    select count(*) into used_slots from public.channel_sessions where organization_id=target_org and archived_at is null;
    resource_label := 'canais';
  else
    select seats into capacity from public.subscription_plan_limits where plan_id=sub.plan_id;
    select count(*) into used_slots from public.user_organizations where organization_id=target_org and revoked_at is null;
    resource_label := 'pessoas';
  end if;
  if capacity is null or used_slots>=capacity then
    raise exception 'Seu plano atingiu o limite de %. Gerencie sua assinatura para adicionar mais.',resource_label using errcode='P4020';
  end if;
  return new;
end;
$$;
revoke all on function public.fn_subscription_resource_limit() from public, anon, authenticated;

-- Disconnected channels and drafts reserve capacity until explicitly archived.
-- Membership records reserve a seat until revoked, including accepted_at=NULL.
-- Standalone email invitations do not count before a membership is created.
drop trigger if exists subscription_agents_limit on public.ai_agents;
create trigger subscription_agents_limit before insert or update of organization_id,archived_at on public.ai_agents
 for each row execute function public.fn_subscription_resource_limit();
drop trigger if exists subscription_channels_limit on public.channel_sessions;
create trigger subscription_channels_limit before insert or update of organization_id,archived_at on public.channel_sessions
 for each row execute function public.fn_subscription_resource_limit();
drop trigger if exists subscription_seats_limit on public.user_organizations;
create trigger subscription_seats_limit before insert or update of organization_id,revoked_at on public.user_organizations
 for each row execute function public.fn_subscription_resource_limit();
