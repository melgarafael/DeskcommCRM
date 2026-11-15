-- manifest: **Integração com o sistema de clínicas Amigo vira MÓDULO OPCIONAL `amigo` (#4227, etapa 2 de 2 do doc 356; contribuição de @jadsonlsouza).** Nenhuma tabela nasce aqui: as cinco tabelas (`amigo_connections`, `amigo_credentials`, `amigo_patient_links`, `amigo_appointment_links`, `amigo_operations`) nascem só em `fn_amigo_provisionar()`, quando o administrador da instalação instala o módulo em Administração › Módulos (ADR-0002). RLS ligada, leitura direta só para gestão da própria organização, escrita só pelo servidor. A credencial fica cifrada em tabela sem nenhum grant de sessão. Configurar e desconectar passam por funções `security definer` que só o servidor executa e que conferem o papel `admin` na transação. Anonimizar um contato desfaz o vínculo contato ↔ paciente e redige o espelho das consultas e os recibos daquele paciente (gatilho `trg_amigo_redigir_titular`). Sem o módulo instalado, nada disto existe e nada roda.
--
-- O que NÃO está aqui, de propósito: as colunas de autoridade da agenda e as
-- guardas que reservam essas colunas ao servidor (migration 9392, etapa 1). O
-- PR original copiava `fn_google_appointment`, uma guarda de projeção que
-- bloqueava a sessão inteira e uma troca de texto em `fn_appointment_stamp`; a
-- etapa 1 resolveu as três por outro caminho, e este arquivo não toca nelas.
--
-- Por que o vínculo de lead é FK simples e o de contato é composto: `contacts`
-- já tem `uq_contacts_org_id` e `calendar_appointments` tem
-- `calendar_service_appointment_org_id_idx`; `crm_leads` não tem chave
-- (organization_id, id), e criá-la aqui seria a provisionadora mexendo no
-- núcleo (ADR-0002 D4, `tests/invariants/provisionadora-de-modulo.test.ts`).
-- O domínio confere que o lead é do contato da mesma organização antes de
-- gravar (`linkAmigoPatient`).

create or replace function public.fn_amigo_check_timezone() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  if new.timezone <> '' then
    begin
      perform pg_catalog.timezone(new.timezone, pg_catalog.now());
    exception when invalid_parameter_value then
      raise exception using errcode = '23514', message = 'amigo_invalid_timezone';
    end;
  end if;
  return new;
end;
$fn$;
revoke execute on function public.fn_amigo_check_timezone() from public, anon, authenticated, service_role;

create or replace function public.fn_amigo_provisionar()
returns void language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  create table if not exists public.amigo_connections (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    active boolean not null default false,
    token_last4 text check (token_last4 is null or length(token_last4) between 1 and 4),
    validated_at timestamptz,
    default_place_id integer check (default_place_id > 0),
    -- Vazio até ser confirmado. Um padrão inferido não ativa a clínica.
    timezone text not null default '',
    allow_same_day boolean,
    months_ahead integer check (months_ahead in (3, 6)),
    reminders_enabled boolean not null default false,
    agent_operations jsonb,
    last_sync_at timestamptz,
    -- Quando o robô TENTOU pela última vez, com sucesso ou não: é a ordem da fila
    -- do cron. Ordenar por `last_sync_at` deixava a conexão que falha sempre na
    -- frente e as outras organizações sem vez.
    last_attempt_at timestamptz,
    last_error text,
    created_at timestamptz not null default clock_timestamp(),
    unique (organization_id, id),
    constraint amigo_connections_activation_check check (
      not active or (token_last4 is not null and validated_at is not null
                     and default_place_id is not null and timezone <> '')
    )
  );
  create unique index if not exists amigo_connections_one_active_uq
    on public.amigo_connections (organization_id) where active;
  create index if not exists amigo_connections_latest_idx
    on public.amigo_connections (organization_id, created_at desc, id desc);

  create table if not exists public.amigo_credentials (
    connection_id uuid primary key,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    ciphertext text not null check (length(ciphertext) > 0),
    foreign key (organization_id, connection_id)
      references public.amigo_connections (organization_id, id) on delete cascade
  );

  create table if not exists public.amigo_patient_links (
    organization_id uuid not null references public.organizations(id) on delete cascade,
    connection_id uuid not null,
    patient_id integer not null check (patient_id > 0),
    contact_id uuid not null,
    lead_id uuid references public.crm_leads(id) on delete set null,
    primary key (organization_id, connection_id, patient_id),
    foreign key (organization_id, connection_id)
      references public.amigo_connections (organization_id, id) on delete cascade,
    foreign key (organization_id, contact_id)
      references public.contacts (organization_id, id) on delete cascade
  );
  create index if not exists amigo_patient_links_contact_idx
    on public.amigo_patient_links (organization_id, contact_id);
  create index if not exists amigo_patient_links_lead_idx
    on public.amigo_patient_links (lead_id);

  create table if not exists public.amigo_appointment_links (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    connection_id uuid not null,
    attendance_id integer not null check (attendance_id > 0),
    appointment_id uuid,
    patient_id integer check (patient_id > 0),
    remote_status text,
    remote_data jsonb not null default '{}'::jsonb,
    effects_fingerprint text,
    synced_at timestamptz not null default now(),
    unique (organization_id, connection_id, attendance_id),
    foreign key (organization_id, connection_id)
      references public.amigo_connections (organization_id, id) on delete cascade,
    -- Apagar o compromisso local solta o espelho, não o vínculo com a consulta remota.
    foreign key (organization_id, appointment_id)
      references public.calendar_appointments (organization_id, id) on delete set null (appointment_id)
  );
  create index if not exists amigo_appointment_links_appointment_idx
    on public.amigo_appointment_links (organization_id, appointment_id);

  create table if not exists public.amigo_operations (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    connection_id uuid not null,
    key text not null check (length(key) > 0),
    request_hash text not null,
    operation text not null,
    state text not null default 'prepared'
      check (state in ('prepared', 'sent', 'confirmed', 'rejected', 'uncertain')),
    result jsonb,
    request_context jsonb not null default '{}'::jsonb,
    target_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (organization_id, connection_id, key),
    foreign key (organization_id, connection_id)
      references public.amigo_connections (organization_id, id) on delete cascade
  );
  -- Uma operação em voo por alvo: resultado incerto segura o alvo até a reconciliação.
  create unique index if not exists amigo_operations_inflight_target_uq
    on public.amigo_operations (organization_id, connection_id, target_id)
    where state in ('prepared', 'sent', 'uncertain');

  alter table public.amigo_connections enable row level security;
  alter table public.amigo_credentials enable row level security;
  alter table public.amigo_patient_links enable row level security;
  alter table public.amigo_appointment_links enable row level security;
  alter table public.amigo_operations enable row level security;

  -- Tira inclusive o TRUNCATE do default ACL. Só o servidor escreve; a sessão lê,
  -- e só a gestão da própria organização. A credencial nem a sessão lê.
  -- `create policy <nome>` e `on public.<tabela>` em LINHAS SEPARADAS, de
  -- propósito, como em cadências: o update.sh até a v1.63.0 lê do TEXTO do
  -- baseline toda `create policy … on public.…` de uma linha e cobra que exista no
  -- banco — e estas só existem onde o módulo foi instalado (#1909). Juntar as duas
  -- linhas trava a atualização dessas instalações.
  revoke all on public.amigo_connections, public.amigo_credentials, public.amigo_patient_links,
    public.amigo_appointment_links, public.amigo_operations from public, anon, authenticated, service_role;
  grant select, insert, update, delete on public.amigo_connections, public.amigo_credentials,
    public.amigo_patient_links, public.amigo_appointment_links, public.amigo_operations to service_role;
  grant select on public.amigo_connections, public.amigo_patient_links,
    public.amigo_appointment_links, public.amigo_operations to authenticated;

  drop policy if exists amigo_connections_select on public.amigo_connections;
  create policy amigo_connections_select
    on public.amigo_connections
    for select to authenticated using (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'));
  drop policy if exists amigo_patient_links_select on public.amigo_patient_links;
  create policy amigo_patient_links_select
    on public.amigo_patient_links
    for select to authenticated using (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'));
  drop policy if exists amigo_appointment_links_select on public.amigo_appointment_links;
  create policy amigo_appointment_links_select
    on public.amigo_appointment_links
    for select to authenticated using (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'));
  drop policy if exists amigo_operations_select on public.amigo_operations;
  create policy amigo_operations_select
    on public.amigo_operations
    for select to authenticated using (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'));

  drop trigger if exists amigo_connection_timezone on public.amigo_connections;
  create trigger amigo_connection_timezone before insert or update of timezone on public.amigo_connections
    for each row execute function public.fn_amigo_check_timezone();

  perform public.fn_proteger_modulo_provisionado();
end;
$f$;
revoke execute on function public.fn_amigo_provisionar() from public, anon, authenticated;
grant execute on function public.fn_amigo_provisionar() to service_role;

-- Configuração serializada; confere o papel admin de novo DENTRO da transação.
-- p_org e p_actor vêm da sessão autenticada no servidor, nunca do corpo.
create or replace function public.fn_amigo_save_config(
  p_org uuid, p_actor uuid, p_input jsonb, p_ciphertext text default null, p_connection uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_connection uuid;
  v_saved jsonb;
begin
  if to_regclass('public.amigo_connections') is null
     or not exists (select 1 from public.modulos_instalados where modulo = 'amigo' and estado = 'ativo') then
    raise exception using errcode = '22023', message = 'amigo_module_off';
  end if;
  if not exists (select 1 from public.user_organizations
                  where organization_id = p_org and user_id = p_actor and role = 'admin'
                    and revoked_at is null and accepted_at is not null) then
    raise exception using errcode = '42501', message = 'amigo_admin_required';
  end if;
  perform 1 from public.organizations where id = p_org for update;
  if not found then raise exception using errcode = '23503', message = 'amigo_org_missing'; end if;
  if p_input - array['active','token_last4','default_place_id','timezone','allow_same_day',
                     'months_ahead','reminders_enabled','agent_operations']::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'amigo_invalid_config';
  end if;
  if p_ciphertext is not null then
    if length(p_ciphertext) = 0 or coalesce(p_input->>'token_last4', '') = '' then
      raise exception using errcode = '22023', message = 'amigo_credential_missing';
    end if;
    -- Token novo pode ser de outra conta: conexão nova, inativa, e os vínculos
    -- antigos ficam como histórico da conexão anterior.
    update public.amigo_connections set active = false where organization_id = p_org and active;
    insert into public.amigo_connections (organization_id, active, token_last4, validated_at, default_place_id,
        timezone, allow_same_day, months_ahead, reminders_enabled, agent_operations)
      values (p_org, false, p_input->>'token_last4', now(), (p_input->>'default_place_id')::integer,
        coalesce(p_input->>'timezone', ''), (p_input->>'allow_same_day')::boolean,
        (p_input->>'months_ahead')::integer, coalesce((p_input->>'reminders_enabled')::boolean, false),
        p_input->'agent_operations')
      returning id into v_connection;
    insert into public.amigo_credentials (organization_id, connection_id, ciphertext)
      values (p_org, v_connection, p_ciphertext);
  else
    select id into v_connection from public.amigo_connections where organization_id = p_org
      order by created_at desc, id desc limit 1 for update;
    if v_connection is null then raise exception using errcode = '22023', message = 'amigo_not_configured'; end if;
    if v_connection is distinct from p_connection then
      raise exception using errcode = '40001', message = 'amigo_connection_changed';
    end if;
    if coalesce((p_input->>'active')::boolean, false)
       and not exists (select 1 from public.amigo_credentials where organization_id = p_org and connection_id = v_connection) then
      raise exception using errcode = '22023', message = 'amigo_credential_missing';
    end if;
    update public.amigo_connections set
      active = case when p_input ? 'active' then (p_input->>'active')::boolean else active end,
      default_place_id = case when p_input ? 'default_place_id' then (p_input->>'default_place_id')::integer else default_place_id end,
      timezone = case when p_input ? 'timezone' then p_input->>'timezone' else timezone end,
      allow_same_day = case when p_input ? 'allow_same_day' then (p_input->>'allow_same_day')::boolean else allow_same_day end,
      months_ahead = case when p_input ? 'months_ahead' then (p_input->>'months_ahead')::integer else months_ahead end,
      reminders_enabled = case when p_input ? 'reminders_enabled' then (p_input->>'reminders_enabled')::boolean else reminders_enabled end,
      agent_operations = case when p_input ? 'agent_operations' then p_input->'agent_operations' else agent_operations end
      where organization_id = p_org and id = v_connection;
  end if;
  select to_jsonb(c) - 'organization_id' into v_saved
    from public.amigo_connections c where c.organization_id = p_org and c.id = v_connection;
  return v_saved;
end;
$fn$;
revoke execute on function public.fn_amigo_save_config(uuid, uuid, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_amigo_save_config(uuid, uuid, jsonb, text, uuid) to service_role;

-- Desconectar não cancela nada no Amigo nem apaga histórico: só desativa e
-- descarta a credencial local. Quem chama já conferiu o papel admin.
create or replace function public.fn_amigo_disconnect(p_org uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if to_regclass('public.amigo_connections') is null then return; end if;
  perform 1 from public.organizations where id = p_org for update;
  update public.amigo_connections
    set active = false, token_last4 = null, validated_at = null, reminders_enabled = false
    where organization_id = p_org;
  delete from public.amigo_credentials where organization_id = p_org;
end;
$fn$;
revoke execute on function public.fn_amigo_disconnect(uuid) from public, anon, authenticated;
grant execute on function public.fn_amigo_disconnect(uuid) to service_role;

-- LGPD: anonimizar o contato desfaz o vínculo com o paciente e redige o que o
-- módulo guardou sobre ele — o espelho das consultas (nome do paciente, do
-- médico, endereço) e os recibos (a resposta do Amigo traz o cadastro). O
-- compromisso local e a atividade do negócio já estão na cascata do núcleo.
-- Não é seção de `modulo_secoes_lgpd` porque a seção só sabe anular coluna, e o
-- vínculo é a chave da linha: o certo é apagá-lo.
create or replace function public.fn_amigo_redigir_titular()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  if not (new.is_anonymized and not old.is_anonymized)
     or to_regclass('public.amigo_patient_links') is null then
    return new;
  end if;
  update public.amigo_appointment_links al
    set remote_data = '{}'::jsonb, effects_fingerprint = null
    where al.organization_id = new.organization_id
      and (exists (select 1 from public.amigo_patient_links pl
                    where pl.organization_id = al.organization_id and pl.connection_id = al.connection_id
                      and pl.patient_id = al.patient_id and pl.contact_id = new.id)
           or exists (select 1 from public.calendar_appointments a
                       where a.organization_id = al.organization_id and a.id = al.appointment_id
                         and a.contact_id = new.id));
  update public.amigo_operations o
    set result = jsonb_build_object('redacted', true), request_context = '{}'::jsonb
    where o.organization_id = new.organization_id
      and exists (select 1 from public.amigo_patient_links pl
                   where pl.organization_id = o.organization_id and pl.connection_id = o.connection_id
                     and pl.contact_id = new.id
                     and (o.request_context->>'patient_id' = pl.patient_id::text
                          or o.target_id = 'patient:' || pl.patient_id::text
                          or o.result->'data'->>'id' = pl.patient_id::text
                          or o.target_id in (select 'attendance:' || al.attendance_id::text
                                               from public.amigo_appointment_links al
                                              where al.organization_id = pl.organization_id
                                                and al.connection_id = pl.connection_id
                                                and al.patient_id = pl.patient_id)));
  delete from public.amigo_patient_links
    where organization_id = new.organization_id and contact_id = new.id;
  return new;
end;
$f$;
revoke execute on function public.fn_amigo_redigir_titular() from public, anon, authenticated, service_role;
drop trigger if exists trg_amigo_redigir_titular on public.contacts;
create trigger trg_amigo_redigir_titular after update of is_anonymized on public.contacts
  for each row execute function public.fn_amigo_redigir_titular();

do $reaplicar$ begin
  if exists (select 1 from public.modulos_instalados where modulo = 'amigo') then
    perform public.fn_amigo_provisionar();
  end if;
end $reaplicar$;

notify pgrst, 'reload schema';
