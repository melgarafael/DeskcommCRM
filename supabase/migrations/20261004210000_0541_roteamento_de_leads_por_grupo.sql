-- manifest: **Rodízio de leads por grupo (issue #2041), reescrito para o lead que nasce SEM conversa.** Quatro tabelas (`lead_routing_groups`, `lead_routing_group_members`, `lead_routing_rules`, `lead_routing_assignments`) e um gatilho `AFTER INSERT` em `crm_leads` que, quando uma regra ativa casa a origem do lead (`webhook_source` | `utm_campaign` | `pipeline`), dá o dono ao lead pelo próximo membro ativo do grupo. O dono entra por UPDATE logo depois do INSERT de propósito: `fn_emit_event_on_lead_change` sai direto em INSERT, então só o UPDATE emite `lead.assigned` (o push). "Quem foi o último" é CALCULADO do log append-only `lead_routing_assignments`, sem tabela de estado; o log guarda a posição do membro no momento, então remover o último da fila não perde o ponteiro. Opt-in por organização: sem regra cadastrada o gatilho não faz nada. O gatilho nunca derruba o INSERT do lead (erro vira `warning`). Aditiva e idempotente; apêndice no fim do `baseline.sql`.
-- 0541: rodízio de leads entre os membros de um grupo (issue #2041).
--
-- POR QUE O DESENHO DA ISSUE MUDOU. A proposta original disparava de um
-- `AFTER INSERT` em `conversations` e gravava em `conversation_assignment_events`.
-- Duas coisas medidas depois de publicá-la:
--
--   1. O lead de formulário (`POST /api/v1/webhooks/in/[token]`, Meta Lead Ads,
--      Elementor, RD Station, Respondi...) é criado por `createLeadHandler` com
--      `source = 'webhook'` e `source_metadata.webhook_source_id`, SEM conversa.
--      Um gatilho em `conversations` nunca dispara para ele — e é exatamente o
--      lead que a equipe de vendas quer repartir.
--   2. O rodízio de CONVERSA por canal já existe (`channel_routing_policies`,
--      `fn_channel_routing_claim`, `lib/routing/worker.ts`, AT-03). Um segundo
--      gatilho em `conversations` disputaria a mesma conversa com ele.
--
-- Então este é o rodízio de LEAD: complementa o de conversa, não o substitui. O
-- worker de conversa (`adotarLeadsDoContato`) só adota lead SEM dono, e o lead
-- que sai daqui já nasce com dono — os dois não se pisam.
--
-- O PUSH. `fn_emit_event_on_lead_change` começa por `if tg_op = 'INSERT' then
-- return new`. Um dono posto num BEFORE INSERT (ou no próprio INSERT) NÃO emite
-- `lead.assigned`, e sem esse evento não há push "lead atribuído a você". Por
-- isso o gatilho é AFTER INSERT e faz um UPDATE: é o UPDATE que passa pelo
-- `trg_emit_event_on_lead_change`.
--
-- "QUEM É O PRÓXIMO" É CALCULADO. `lead_routing_assignments` é o histórico
-- (append-only para quem usa a API): o último dono do grupo é a linha mais nova.
-- O próximo é o membro ativo com `(position, user_id)` imediatamente maior que
-- o do último, voltando ao primeiro quando a lista acaba. A posição fica NO LOG
-- (`member_position`) e não é buscada no membro: se o último da fila sair do
-- grupo, o ponteiro não se perde. Atribuição manual no meio não desloca o
-- rodízio — só entra no log o que o rodízio decidiu.
--
-- ELEGIBILIDADE: membro do grupo com `active`, E membro ativo da organização
-- (`user_organizations.revoked_at is null`, papel agent/manager/admin — a mesma
-- régua de `fn_conversation_assign` e da ação `assign_owner`). Pausar um corretor
-- de férias é `active = false` no grupo, sem tirá-lo dele.
--
-- CONCORRÊNCIA: `pg_advisory_xact_lock` por grupo serializa dois leads chegando
-- juntos — sem ele os dois leriam o mesmo "último" e iriam para o mesmo corretor.
-- O lock vale até o fim da transação do INSERT do lead.
--
-- NUNCA DERRUBA A CAPTAÇÃO: o corpo do gatilho tem `exception when others` que
-- vira `raise warning`. Perder o rodízio de um lead é recuperável (o lead existe,
-- sem dono, e aparece para quem vê leads sem dono); perder o lead não é.
--
-- OPT-IN: o `WHEN` do gatilho só deixa passar lead aberto e sem dono; a função
-- sai na primeira consulta quando a organização não tem regra ativa. Quem não
-- cadastrar grupo nenhum não vê diferença.
--
-- ESCOPO. Banco primeiro: não há tela para cadastrar grupo/membro/regra (a
-- escrita vai pelo PostgREST, com RLS manager+). Rodízio de CONVERSA e
-- reequilíbrio manual ficam como estão / como follow-up.

-- ---- grupos ----
create table if not exists public.lead_routing_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  pipeline_id uuid references public.crm_pipelines (id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_routing_groups_id_org_uniq unique (id, organization_id)
);

create unique index if not exists lead_routing_groups_org_name_uniq
  on public.lead_routing_groups (organization_id, lower(btrim(name)));

-- ---- membros (quem está no grupo e em que ordem) ----
create table if not exists public.lead_routing_group_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  group_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  position integer not null default 0 check (position >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint lead_routing_group_members_group_fk
    foreign key (group_id, organization_id)
    references public.lead_routing_groups (id, organization_id) on delete cascade,
  constraint lead_routing_group_members_group_user_uniq unique (group_id, user_id)
);

create index if not exists lead_routing_group_members_group_idx
  on public.lead_routing_group_members (group_id, active, position, user_id);

-- ---- regras (liga a origem do lead a um grupo) ----
create table if not exists public.lead_routing_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  group_id uuid not null,
  match_type text not null check (match_type in ('webhook_source', 'utm_campaign', 'pipeline')),
  match_value text not null check (length(btrim(match_value)) > 0),
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint lead_routing_rules_group_fk
    foreign key (group_id, organization_id)
    references public.lead_routing_groups (id, organization_id) on delete cascade,
  constraint lead_routing_rules_match_uniq unique (organization_id, match_type, match_value)
);

create index if not exists lead_routing_rules_org_active_idx
  on public.lead_routing_rules (organization_id, active, priority, created_at);

-- ---- histórico do rodízio (de onde o "próximo" é calculado) ----
create table if not exists public.lead_routing_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  group_id uuid not null,
  lead_id uuid not null references public.crm_leads (id) on delete cascade,
  user_id uuid not null,
  member_position integer not null,
  rule_id uuid references public.lead_routing_rules (id) on delete set null,
  -- clock_timestamp() e não now(): now() é o início da TRANSAÇÃO, igual para
  -- duas atribuições na mesma, e o "último" do grupo sai desta ordenação.
  created_at timestamptz not null default clock_timestamp(),
  constraint lead_routing_assignments_group_fk
    foreign key (group_id, organization_id)
    references public.lead_routing_groups (id, organization_id) on delete cascade,
  constraint lead_routing_assignments_lead_uniq unique (lead_id)
);

create index if not exists lead_routing_assignments_group_recent_idx
  on public.lead_routing_assignments (group_id, created_at desc, id desc);

-- ---- RLS: leitura para quem é da organização; escrita manager+ (config) ----
alter table public.lead_routing_groups enable row level security;
alter table public.lead_routing_group_members enable row level security;
alter table public.lead_routing_rules enable row level security;
alter table public.lead_routing_assignments enable row level security;

drop policy if exists tenant_isolation_lead_routing_groups_select on public.lead_routing_groups;
create policy tenant_isolation_lead_routing_groups_select on public.lead_routing_groups
  for select using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists lead_routing_groups_write on public.lead_routing_groups;
create policy lead_routing_groups_write on public.lead_routing_groups
  for all
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager')
         and public.fn_support_write_allowed(organization_id))
  with check (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager')
         and public.fn_support_write_allowed(organization_id));

drop policy if exists tenant_isolation_lead_routing_group_members_select on public.lead_routing_group_members;
create policy tenant_isolation_lead_routing_group_members_select on public.lead_routing_group_members
  for select using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists lead_routing_group_members_write on public.lead_routing_group_members;
create policy lead_routing_group_members_write on public.lead_routing_group_members
  for all
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager')
         and public.fn_support_write_allowed(organization_id))
  with check (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager')
         and public.fn_support_write_allowed(organization_id));

drop policy if exists tenant_isolation_lead_routing_rules_select on public.lead_routing_rules;
create policy tenant_isolation_lead_routing_rules_select on public.lead_routing_rules
  for select using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists lead_routing_rules_write on public.lead_routing_rules;
create policy lead_routing_rules_write on public.lead_routing_rules
  for all
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager')
         and public.fn_support_write_allowed(organization_id))
  with check (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager')
         and public.fn_support_write_allowed(organization_id));

-- O histórico só é escrito pelo gatilho (security definer): ninguém grava por REST.
drop policy if exists tenant_isolation_lead_routing_assignments_select on public.lead_routing_assignments;
create policy tenant_isolation_lead_routing_assignments_select on public.lead_routing_assignments
  for select using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

revoke all on public.lead_routing_groups, public.lead_routing_group_members,
              public.lead_routing_rules, public.lead_routing_assignments from anon, authenticated;
grant select, insert, update, delete on public.lead_routing_groups,
              public.lead_routing_group_members, public.lead_routing_rules to authenticated;
grant select on public.lead_routing_assignments to authenticated;
grant all on public.lead_routing_groups, public.lead_routing_group_members,
             public.lead_routing_rules, public.lead_routing_assignments to service_role;

-- ---- quem é o próximo do grupo (calculado do histórico) ----
create or replace function public.fn_lead_routing_next(p_org uuid, p_group uuid)
returns table (user_id uuid, member_position integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_last_pos integer;
  v_last_user uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('lead_routing:' || p_group::text, 2041));

  select a.member_position, a.user_id
    into v_last_pos, v_last_user
    from public.lead_routing_assignments a
   where a.group_id = p_group and a.organization_id = p_org
   order by a.created_at desc, a.id desc
   limit 1;

  return query
    select m.user_id, m.position
      from public.lead_routing_group_members m
      join public.user_organizations uo
        on uo.user_id = m.user_id
       and uo.organization_id = p_org
       and uo.revoked_at is null
       and uo.role in ('agent', 'manager', 'admin')
     where m.group_id = p_group
       and m.organization_id = p_org
       and m.active
     order by
       case
         when v_last_pos is null then 0
         when (m.position, m.user_id) > (v_last_pos, v_last_user) then 0
         else 1
       end,
       m.position,
       m.user_id
     limit 1;
end;
$function$;

-- ---- o gatilho: dá o dono ao lead novo quando uma regra casa ----
create or replace function public.fn_lead_routing_on_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rule record;
  v_next record;
  v_rows integer;
begin
  select r.id as rule_id, r.group_id
    into v_rule
    from public.lead_routing_rules r
    join public.lead_routing_groups g
      on g.id = r.group_id and g.organization_id = r.organization_id
   where r.organization_id = new.organization_id
     and r.active
     and g.active
     and (g.pipeline_id is null or g.pipeline_id = new.pipeline_id)
     and (
          (r.match_type = 'webhook_source' and r.match_value = new.source_metadata ->> 'webhook_source_id')
       or (r.match_type = 'utm_campaign'   and r.match_value = new.source_metadata ->> 'utm_campaign')
       or (r.match_type = 'pipeline'       and r.match_value = new.pipeline_id::text)
     )
   order by r.priority asc, r.created_at asc, r.id asc
   limit 1;

  if v_rule.rule_id is null then
    return null;
  end if;

  select n.user_id, n.member_position
    into v_next
    from public.fn_lead_routing_next(new.organization_id, v_rule.group_id) n;

  if v_next.user_id is null then
    return null;
  end if;

  update public.crm_leads
     set owner_user_id = v_next.user_id,
         owner_kind = 'user',
         assigned_at = now()
   where id = new.id
     and organization_id = new.organization_id
     and owner_user_id is null
     and owner_agent_id is null;
  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    insert into public.lead_routing_assignments
      (organization_id, group_id, lead_id, user_id, member_position, rule_id)
    values
      (new.organization_id, v_rule.group_id, new.id, v_next.user_id, v_next.member_position, v_rule.rule_id);
  end if;

  return null;
exception
  when others then
    raise warning 'fn_lead_routing_on_insert: lead % sem rodizio (%)', new.id, sqlerrm;
    return null;
end;
$function$;

revoke all on function public.fn_lead_routing_next(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_lead_routing_on_insert() from public, anon, authenticated;
grant execute on function public.fn_lead_routing_next(uuid, uuid) to service_role;

drop trigger if exists trg_lead_routing_on_insert on public.crm_leads;
create trigger trg_lead_routing_on_insert
  after insert on public.crm_leads
  for each row
  when (new.owner_user_id is null and new.owner_agent_id is null and new.status = 'open')
  execute function public.fn_lead_routing_on_insert();
