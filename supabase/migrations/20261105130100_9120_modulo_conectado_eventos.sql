-- manifest: **Módulo conectado, F5 — os eventos que o módulo busca (spec 33, F5 e decisão 4).** Duas tabelas só de servidor (RLS ligada, NENHUMA policy, privilégio só a `service_role`): `extension_module_events` (`id` identity, `organization_id` com cascade, `kind` fechado em `contact_anonymized|module_disabled|organization_suspended`, `subject_id`, `installation_id`, `occurred_at`; CHECK de coerência: `contact_anonymized` exige `subject_id` e `module_disabled` exige `installation_id`; índice `(organization_id, id)`; índice único parcial `(organization_id, subject_id)` para `contact_anonymized`, então o mesmo contato nunca gera dois eventos) e `extension_module_cursors` (`(installation_id, organization_id)` → último evento lido e quando). Quatro gatilhos escrevem eventos (gatilho nunca faz HTTP; as funções de gatilho são `security definer` porque quem muda o fato pode ser qualquer papel): contato anonimizado (`false → true` em `contacts.is_anonymized`); vínculo organização × módulo `connected` que deixa de estar ligado (UPDATE de `enabled` ou DELETE da linha); instalação `connected` que passa de ativa a desligada ou removida (um evento por vínculo ainda ligado; não duplica com o gatilho do vínculo em nenhuma ordem); organização que passa a `suspended` ou `redacted`. Três funções `security invoker`, `search_path` vazio, EXECUTE só para `service_role`: `fn_extensions_events_allowed` (regra D2: vínculo ligado com instalação ativa, OU `module_disabled` do par nos últimos 30 dias, para a LGPD não ficar presa), `fn_extensions_events_read` (só eventos da organização, `module_disabled` só do par, `p_limit` cortado em 100, `{events,last_id,has_more}`; recusa se o par não é autorizado) e `fn_extensions_events_ack` (upsert do cursor, nunca regride, nunca passa do último evento visível). Sem expurgo nesta fase (D5). Espelho idempotente no apêndice do `supabase/baseline.sql`, depois da 9119 e antes da VARREDURA anon (0116). Prova em `tests/invariants/extensoes-eventos.test.ts`.
-- ============================================================================
-- 9120 — MÓDULO CONECTADO, F5: os eventos que o módulo busca.
--
-- Plano: docs/superpowers/plans/2026-11-05-modulo-conectado-p10-f5-eventos.md, Tarefa 1.
-- O módulo conectado precisa saber, buscando por cursor, de três fatos que o obrigam a agir: contato
-- anonimizado, módulo desativado na organização e organização suspensa. O host NÃO empurra (gatilho nunca
-- faz HTTP): o gatilho escreve uma linha aqui e a rota (Tarefa 2) entrega por cursor.
--
-- Isolamento (o produto vende o tenant): todo evento leva `organization_id`; a leitura filtra SEMPRE pela
-- organização que veio da LINHA do vínculo, nunca de quem pergunta; `module_disabled` só é visto pelo par
-- (organização, instalação) a que pertence; o corpo do evento tem só identificadores.
-- Função nova em `public` nasce exposta (ALTER DEFAULT PRIVILEGES do baseline dá EXECUTE a `anon`, e o
-- Postgres dá a PUBLIC): as origens são revogadas abaixo. Idempotente.
-- ============================================================================

create table if not exists public.extension_module_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('contact_anonymized', 'module_disabled', 'organization_suspended')),
  -- Sem FK: o contato pode ser apagado depois e o fato (o id foi anonimizado) continua valendo para o módulo.
  subject_id uuid,
  installation_id uuid references public.extension_installations(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  constraint extension_module_events_coerencia check (
    (kind <> 'contact_anonymized' or subject_id is not null)
    and (kind <> 'module_disabled' or installation_id is not null)
  )
);

create index if not exists extension_module_events_org_id on public.extension_module_events(organization_id, id);
-- O mesmo contato anonimizado duas vezes (ou por dois caminhos) gera um evento só.
create unique index if not exists extension_module_events_contato_unico
  on public.extension_module_events(organization_id, subject_id) where kind = 'contact_anonymized';

create table if not exists public.extension_module_cursors (
  installation_id uuid not null references public.extension_installations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  last_event_id bigint not null default 0,
  last_read_at timestamptz not null default now(),
  primary key (installation_id, organization_id)
);

alter table public.extension_module_events enable row level security;
alter table public.extension_module_cursors enable row level security;
revoke all on public.extension_module_events, public.extension_module_cursors
  from public, anon, authenticated, service_role;
grant select on public.extension_module_events to service_role;
grant select, insert, update on public.extension_module_cursors to service_role;

-- (a) Contato anonimizado: a mesma virada `false → true` que `trg_lgpd_secoes_de_modulo` já usa, pelos DOIS
-- caminhos de anonimização (a cascata e `fn_lgpd_anonymize_contact`).
create or replace function public.fn_extensions_evento_contato_anonimizado()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.extension_module_events(organization_id, kind, subject_id)
    values (new.organization_id, 'contact_anonymized', new.id)
    on conflict (organization_id, subject_id) where kind = 'contact_anonymized' do nothing;
  return null;
end $$;

-- (b) Vínculo organização × módulo que deixa de estar ligado: UPDATE de `enabled` (true → false) ou DELETE de
-- linha ligada. Só módulo `connected` (o declarativo não tem quem busque). Se a instalação já está desligada ou
-- removida, o evento já saiu pelo gatilho (c): não duplica. No DELETE em cascata da organização a linha da
-- organização já não existe e o evento não nasce (a FK o recusaria; o módulo some com a organização).
create or replace function public.fn_extensions_evento_vinculo_desligado()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_emite boolean;
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return null;
  end if;
  select (a.manifest->>'profile' = 'connected' and i.disabled_at is null and i.removed_at is null) into v_emite
    from public.extension_installations i join public.extension_artifacts a on a.id = i.artifact_id
    where i.id = old.installation_id;
  if coalesce(v_emite, false) then
    insert into public.extension_module_events(organization_id, kind, installation_id)
      values (old.organization_id, 'module_disabled', old.installation_id);
  end if;
  return null;
end $$;

-- (c) Instalação `connected` que passa de ativa a desligada ou removida: um evento por vínculo ainda ligado.
-- Só a PASSAGEM de ativa a inativa emite (desligar e depois remover é um fato só).
create or replace function public.fn_extensions_evento_instalacao_desligada()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.extension_artifacts a where a.id = new.artifact_id and a.manifest->>'profile' = 'connected') then
    insert into public.extension_module_events(organization_id, kind, installation_id)
      select e.organization_id, 'module_disabled', new.id
        from public.organization_extensions e
        where e.installation_id = new.id and e.enabled;
  end if;
  return null;
end $$;

-- (d) Organização suspensa ou anonimizada (D4: `redacted` também; a LGPD apaga a organização e o módulo precisa saber).
create or replace function public.fn_extensions_evento_organizacao_suspensa()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.extension_module_events(organization_id, kind) values (new.id, 'organization_suspended');
  return null;
end $$;

revoke execute on function public.fn_extensions_evento_contato_anonimizado() from public, anon, authenticated;
revoke execute on function public.fn_extensions_evento_vinculo_desligado() from public, anon, authenticated;
revoke execute on function public.fn_extensions_evento_instalacao_desligada() from public, anon, authenticated;
revoke execute on function public.fn_extensions_evento_organizacao_suspensa() from public, anon, authenticated;

drop trigger if exists trg_extensions_evento_contato_anonimizado on public.contacts;
create trigger trg_extensions_evento_contato_anonimizado
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized and not old.is_anonymized)
  execute function public.fn_extensions_evento_contato_anonimizado();

drop trigger if exists trg_extensions_evento_vinculo_desligado_upd on public.organization_extensions;
create trigger trg_extensions_evento_vinculo_desligado_upd
  after update of enabled on public.organization_extensions
  for each row
  when (old.enabled and not new.enabled)
  execute function public.fn_extensions_evento_vinculo_desligado();

drop trigger if exists trg_extensions_evento_vinculo_desligado_del on public.organization_extensions;
create trigger trg_extensions_evento_vinculo_desligado_del
  after delete on public.organization_extensions
  for each row
  when (old.enabled)
  execute function public.fn_extensions_evento_vinculo_desligado();

drop trigger if exists trg_extensions_evento_instalacao_desligada on public.extension_installations;
create trigger trg_extensions_evento_instalacao_desligada
  after update of disabled_at, removed_at on public.extension_installations
  for each row
  when (old.disabled_at is null and old.removed_at is null and (new.disabled_at is not null or new.removed_at is not null))
  execute function public.fn_extensions_evento_instalacao_desligada();

drop trigger if exists trg_extensions_evento_organizacao_suspensa on public.organizations;
create trigger trg_extensions_evento_organizacao_suspensa
  after update of status on public.organizations
  for each row
  when (new.status in ('suspended', 'redacted') and old.status is distinct from new.status)
  execute function public.fn_extensions_evento_organizacao_suspensa();

-- Quem pode LER os eventos da organização como este módulo (regra D2): o vínculo está ligado e a instalação
-- está ativa, OU o par foi desativado há menos de 30 dias (a LGPD não fica presa: um módulo desligado ainda
-- apaga os dados dos contatos anonimizados). Depois de 30 dias, recusa. Organização suspensa continua lendo.
create or replace function public.fn_extensions_events_allowed(p_organization uuid, p_installation uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select case when p_organization is null or p_installation is null then false else
    exists (
      select 1 from public.organization_extensions e
        join public.extension_installations i on i.id = e.installation_id
        where e.organization_id = p_organization and e.installation_id = p_installation
          and e.enabled and i.disabled_at is null and i.removed_at is null
    )
    or exists (
      select 1 from public.extension_module_events v
        where v.organization_id = p_organization and v.installation_id = p_installation
          and v.kind = 'module_disabled' and v.occurred_at > now() - interval '30 days'
    )
  end;
$$;

create or replace function public.fn_extensions_events_read(p_organization uuid, p_installation uuid, p_after bigint, p_limit integer)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_limit integer; v_events jsonb; v_last bigint; v_more boolean;
begin
  if p_organization is null or p_installation is null or p_after is null or p_after < 0
    or p_limit is null or p_limit < 1 then
    raise exception using errcode='P0001', message='extension_invalid_input';
  end if;
  if not public.fn_extensions_events_allowed(p_organization, p_installation) then
    raise exception using errcode='P0001', message='extension_events_forbidden';
  end if;
  v_limit := least(p_limit, 100);
  with q as (
    select v.id, v.kind, v.subject_id, v.installation_id, v.occurred_at
      from public.extension_module_events v
      where v.organization_id = p_organization and v.id > p_after
        and (v.kind <> 'module_disabled' or v.installation_id = p_installation)
      order by v.id
      limit v_limit + 1
  ), pagina as (
    select * from q order by id limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'subject_id', p.subject_id,
           'installation_id', p.installation_id, 'occurred_at', p.occurred_at) order by p.id), '[]'::jsonb),
         coalesce(max(p.id), p_after),
         (select count(*) from q) > v_limit
    into v_events, v_last, v_more
    from pagina p;
  return jsonb_build_object('events', v_events, 'last_id', v_last, 'has_more', v_more);
end $$;

-- O módulo reconhece o que leu. O cursor nunca regride e nunca passa do último evento que este par enxerga.
create or replace function public.fn_extensions_events_ack(p_organization uuid, p_installation uuid, p_event_id bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_max bigint; v_cursor bigint;
begin
  if p_organization is null or p_installation is null or p_event_id is null or p_event_id < 0 then
    raise exception using errcode='P0001', message='extension_invalid_input';
  end if;
  if not public.fn_extensions_events_allowed(p_organization, p_installation) then
    raise exception using errcode='P0001', message='extension_events_forbidden';
  end if;
  select coalesce(max(v.id), 0) into v_max from public.extension_module_events v
    where v.organization_id = p_organization and (v.kind <> 'module_disabled' or v.installation_id = p_installation);
  insert into public.extension_module_cursors as c(installation_id, organization_id, last_event_id, last_read_at)
    values (p_installation, p_organization, least(p_event_id, v_max), now())
    on conflict (installation_id, organization_id) do update
      set last_event_id = greatest(c.last_event_id, excluded.last_event_id),
          last_read_at = now()
    returning last_event_id into v_cursor;
  return jsonb_build_object('last_event_id', v_cursor);
end $$;

revoke execute on function public.fn_extensions_events_allowed(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.fn_extensions_events_read(uuid,uuid,bigint,integer) from public, anon, authenticated;
revoke execute on function public.fn_extensions_events_ack(uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.fn_extensions_events_allowed(uuid,uuid) to service_role;
grant execute on function public.fn_extensions_events_read(uuid,uuid,bigint,integer) to service_role;
grant execute on function public.fn_extensions_events_ack(uuid,uuid,bigint) to service_role;

notify pgrst, 'reload schema';
