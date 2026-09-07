-- Suporte temporário por sessão Supabase; não cria membership nem troca identidade.
-- O banco decide validade/modo. Sessão vencida continua identificável até saída.
create table if not exists public.platform_support_sessions (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 actor_user_id uuid not null references auth.users(id) on delete cascade,
 auth_session_id uuid not null,
 access_mode text not null check (access_mode in ('full','support_readonly')),
 previous_organization_id uuid references public.organizations(id) on delete set null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 ended_at timestamptz
);
-- Referência histórica ao Auth: CASCADE apagaria o bloqueio ao revogar a sessão;
-- RESTRICT impediria logout. O início valida auth.sessions sob lock.
alter table public.platform_support_sessions drop constraint if exists platform_support_sessions_auth_session_id_fkey;
create unique index if not exists platform_support_sessions_open_session
 on public.platform_support_sessions(auth_session_id) where ended_at is null;
alter table public.platform_support_sessions enable row level security;
revoke all on public.platform_support_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.platform_support_sessions to service_role;

create or replace function public.fn_support_context()
returns jsonb language sql stable security definer set search_path = public as $f$
 select jsonb_build_object('id', s.id, 'organization_id', s.organization_id,
 'actor_user_id', s.actor_user_id, 'auth_session_id', s.auth_session_id,
 'previous_organization_id', s.previous_organization_id, 'expires_at', s.expires_at,
 'name', o.display_name, 'locale', o.locale,
 'access_mode', case when s.access_mode = 'support_readonly' or p.scope <> 'full'
 then 'support_readonly' else 'full' end,
 'status', case when s.expires_at <= now() then 'expired'
 when p.user_id is null or a.id is null or (a.not_after is not null and a.not_after <= now())
 or o.status <> 'active' then 'revoked'
 when (p.mfa_required or exists(select 1 from auth.mfa_factors f where f.user_id=s.actor_user_id and f.status='verified'))
 and coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then 'revoked'
 else 'active' end)
 from public.platform_support_sessions s
 join public.organizations o on o.id=s.organization_id
 left join public.platform_admins p on p.user_id=s.actor_user_id and p.revoked_at is null
 left join auth.sessions a on a.id=s.auth_session_id and a.user_id=s.actor_user_id
 where s.actor_user_id=auth.uid()
 and s.auth_session_id=nullif(auth.jwt()->>'session_id','')::uuid and s.ended_at is null
 limit 1;
$f$;
revoke all on function public.fn_support_context() from public, anon;
grant execute on function public.fn_support_context() to authenticated, service_role;

create or replace function public.fn_support_write_allowed(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $f$
 select coalesce((select case when (s->>'organization_id')::uuid is distinct from p_org then true
 else s->>'status'='active' and s->>'access_mode'='full' end
 from (select public.fn_support_context() s) c where s is not null),true);
$f$;
revoke all on function public.fn_support_write_allowed(uuid) from public, anon;
grant execute on function public.fn_support_write_allowed(uuid) to authenticated, service_role;

create or replace function public.fn_user_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $f$
 select organization_id from public.user_organizations where user_id=auth.uid() and revoked_at is null
 union select (s->>'organization_id')::uuid from (select public.fn_support_context() s) c where s->>'status'='active';
$f$;
create or replace function public.fn_user_role_in_org(p_org uuid)
returns text language sql stable security definer set search_path = public as $f$
 select case when s->>'status'='active' and (s->>'organization_id')::uuid=p_org
 then case when s->>'access_mode'='full' then 'admin' else 'viewer' end
 else (select role from public.user_organizations where user_id=auth.uid() and organization_id=p_org and revoked_at is null limit 1) end
 from (select public.fn_support_context() s) c;
$f$;

-- Somente backend autenticado chama o início/fim. O corpo reconfirma sessão,
-- autoridade e MFA reais, e limita TTL mesmo que quem chama peça mais.
create or replace function public.fn_start_support(p_actor uuid, p_session uuid, p_org uuid, p_previous uuid, p_mode text default 'full', p_ttl integer default 3600)
returns uuid language plpgsql security definer set search_path = public as $f$
declare v_id uuid; v_scope text;
begin
 perform 1 from auth.sessions where id=p_session and user_id=p_actor and (not_after is null or not_after>now()) for update;
 if not found then raise exception 'support_session_invalid'; end if;
 select scope into v_scope from public.platform_admins p where user_id=p_actor and revoked_at is null
 and (not (p.mfa_required or exists(select 1 from auth.mfa_factors f where f.user_id=p_actor and f.status='verified'))
 or exists(select 1 from auth.sessions a where a.id=p_session and a.aal='aal2'));
 if not found then raise exception 'support_authority_required'; end if;
 if p_mode not in ('full','support_readonly') or p_ttl is null or p_ttl<1 then raise exception 'support_invalid_input'; end if;
 if not exists(select 1 from organizations where id=p_org and status='active') then raise exception 'support_target_unavailable'; end if;
 if exists(select 1 from platform_support_sessions where auth_session_id=p_session and ended_at is null) then raise exception 'support_exit_required'; end if;
 if p_previous is not null and not exists(select 1 from user_organizations where user_id=p_actor and organization_id=p_previous and revoked_at is null) then raise exception 'support_previous_invalid'; end if;
 insert into platform_support_sessions(organization_id,actor_user_id,auth_session_id,access_mode,previous_organization_id,expires_at)
 values(p_org,p_actor,p_session,case when v_scope='full' then p_mode else 'support_readonly' end,p_previous,now()+make_interval(secs=>least(p_ttl,3600))) returning id into v_id;
 return v_id;
end $f$;
create or replace function public.fn_end_support(p_actor uuid,p_session uuid)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare v_row public.platform_support_sessions;
begin
 -- Sair depende somente da posse da sessão, nunca da autoridade/TTL.
 update public.platform_support_sessions set ended_at=now()
 where actor_user_id=p_actor and auth_session_id=p_session and ended_at is null returning * into v_row;
 return to_jsonb(v_row);
end $f$;
revoke all on function public.fn_start_support(uuid,uuid,uuid,uuid,text,integer), public.fn_end_support(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_start_support(uuid,uuid,uuid,uuid,text,integer), public.fn_end_support(uuid,uuid) to service_role;

-- Enumera o catálogo aplicado; não pressupõe quantas tabelas o produto terá.
-- Restritiva derrota as permissivas OR plataforma, inclusive membership admin B.
do $f$
declare r record; v_col text;
begin
 for r in select c.oid,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r' and c.relrowsecurity
 and (exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='organization_id' and not a.attisdropped) or c.relname='organizations')
 loop
 v_col:=case when r.relname='organizations' then 'id' else 'organization_id' end;
 if not (has_table_privilege('authenticated',r.oid,'insert') or has_table_privilege('authenticated',r.oid,'update') or has_table_privilege('authenticated',r.oid,'delete')) then
   execute format('drop policy if exists support_write_insert on public.%I',r.relname);
   execute format('drop policy if exists support_write_update on public.%I',r.relname);
   execute format('drop policy if exists support_write_delete on public.%I',r.relname);
   continue; -- tabela server-only mantém ZERO policies, contrato mais restritivo
 end if;
 execute format('drop policy if exists support_write_insert on public.%I',r.relname);
 execute format('create policy support_write_insert on public.%I as restrictive for insert to authenticated with check (public.fn_support_write_allowed(%I))',r.relname,v_col);
 execute format('drop policy if exists support_write_update on public.%I',r.relname);
 execute format('create policy support_write_update on public.%I as restrictive for update to authenticated using (public.fn_support_write_allowed(%I)) with check (public.fn_support_write_allowed(%I))',r.relname,v_col,v_col);
 execute format('drop policy if exists support_write_delete on public.%I',r.relname);
 execute format('create policy support_write_delete on public.%I as restrictive for delete to authenticated using (public.fn_support_write_allowed(%I))',r.relname,v_col);
 end loop;
end $f$;

CREATE OR REPLACE FUNCTION public.emit_event(p_event_type text, p_entity_kind text, p_entity_id uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_metadata jsonb DEFAULT '{}'::jsonb, p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_id uuid;
  v_event_id uuid;
begin
  v_org_id := coalesce(p_organization_id, (public.fn_support_context()->>'organization_id')::uuid);
  if v_org_id is null then
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  if auth.uid() is not null
     and not public.fn_role_at_least(v_org_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active member of the organization';
  end if;

  if not public.fn_support_write_allowed(v_org_id) then raise exception 'support_readonly' using errcode='42501'; end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb),
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $function$

;

CREATE OR REPLACE FUNCTION public.fn_conversation_assign(p_organization_id uuid, p_conversation_id uuid, p_to_user_id uuid, p_reason text, p_expected_assignee uuid DEFAULT NULL::uuid, p_enforce_expected boolean DEFAULT false)
 RETURNS SETOF conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         -- Desnormalizado JUNTO com o dono, na mesma transação: nunca existe
         -- uma janela em que id e nome discordam. NULL junto com o id quando
         -- a atribuição é removida (release) — nunca sobra um nome órfão de
         -- dono nenhum. Lido de auth.users porque quem chama esta função
         -- (RPC) não necessariamente tem acesso ao Admin API — a definer
         -- resolve por dentro.
         assigned_to_user_name = case
           when p_to_user_id is null then null
           else (select raw_user_meta_data ->> 'full_name' from auth.users where id = p_to_user_id)
         end,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.fn_mesclar_contatos(p_organization_id uuid, p_contato_principal uuid, p_contatos_secundarios uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_principal public.contacts%rowtype;
  v_esperado integer;
  v_achado integer;
  v_alvo record;
  v_linha record;
  v_movidas integer;
  v_pulados integer;
  v_repontado jsonb := '{}'::jsonb;
  v_nao_repontado jsonb := '{}'::jsonb;
  v_nome text;
  v_apelido text;
  v_nascimento date;
  v_email text;
  v_telefone text;
  v_lid text;
  v_tags text[];
  v_leads integer := 0;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  -- 1 · Autorização. Fundir é destrutivo na prática: `manager`, o mesmo piso das
  --     policies de `merge_queue`. Sessão de service role (auth.uid() nulo) não
  --     passa por aqui — quem resolve a org nesse caminho é a rota, de fonte
  --     confiável, nunca do body.
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;

  if p_contato_principal is null
     or p_contatos_secundarios is null
     or cardinality(p_contatos_secundarios) = 0
     or p_contato_principal = any(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'selecao_de_mesclagem_invalida';
  end if;

  select count(distinct id)::integer into v_esperado
    from unnest(p_contatos_secundarios) as ids(id);
  if v_esperado <> cardinality(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'secundario_repetido';
  end if;

  -- 2 · O principal existe, é desta org, está vivo — e trava até o fim.
  select * into v_principal from public.contacts
   where id = p_contato_principal
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'contato_principal_indisponivel';
  end if;

  -- 3 · Os secundários também. `is_anonymized = false` não é zelo: L-04 é
  --     irreversível, e reencaixar a linha anonimizada num contato ativo a
  --     traria de volta ao atendimento pela porta dos fundos.
  perform 1 from public.contacts
   where id = any(p_contatos_secundarios)
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  get diagnostics v_achado = row_count;
  if v_achado <> v_esperado then
    raise exception using errcode = 'P0002', message = 'contato_secundario_indisponivel';
  end if;

  -- 4 · A LÁPIDE VEM ANTES de tudo. É ela que solta telefone/e-mail/CPF dos
  --     índices únicos parciais para o vencedor poder herdá-los no passo 6.
  update public.contacts
     set is_merged_into = p_contato_principal,
         merged_at = now(),
         updated_at = now()
   where organization_id = p_organization_id
     and id = any(p_contatos_secundarios);

  -- Cadeia: quem já tinha sido mesclado NUM dos secundários passa a apontar para
  -- o vencedor. Sem isto, `is_merged_into` vira uma corrente que a leitura teria
  -- de percorrer, e ninguém percorre.
  update public.contacts
     set is_merged_into = p_contato_principal
   where organization_id = p_organization_id
     and is_merged_into = any(p_contatos_secundarios);

  -- 5 · Reponta TODO ponteiro para os perdedores. A lista sai do catálogo; o
  --     polimórfico entra à mão porque catálogo nenhum o conhece.
  for v_alvo in
    select n.nspname as esquema, c.relname as tabela, a.attname as coluna, ''::text as filtro
      from pg_catalog.pg_constraint co
      join pg_catalog.pg_class c on c.oid = co.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = co.conrelid and a.attnum = co.conkey[1]
     where co.contype = 'f'
       and co.confrelid = 'public.contacts'::regclass
       and co.conrelid <> 'public.contacts'::regclass
       and array_length(co.conkey, 1) = 1
       and c.relkind = 'r'
       and n.nspname = 'public'
    union all
    select 'public', 'crm_lead_links', 'target_id', ' and target_kind = ''contact'''
     where to_regclass('public.crm_lead_links') is not null
    order by 2, 3
  loop
    v_pulados := 0;
    begin
      execute format(
        'update %I.%I set %I = $1 where %I = any($2)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.coluna, v_alvo.filtro
      ) using p_contato_principal, p_contatos_secundarios;
      get diagnostics v_movidas = row_count;
    exception when unique_violation or exclusion_violation then
      -- Colisão REAL e esperada: `uniq_job_queue_one_running_per_contact` deixa
      -- um job 'running' por contato, e os dois lados podem ter um. Em vez de
      -- abortar a fusão inteira por causa de estado efêmero de runtime, reponta
      -- linha a linha e conta quem ficou. Quem fica NÃO vira FK órfã — continua
      -- apontando para a lápide, que existe.
      v_movidas := 0;
      for v_linha in execute format(
        'select ctid as tid from %I.%I where %I = any($1)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.filtro
      ) using p_contatos_secundarios
      loop
        begin
          execute format(
            'update %I.%I set %I = $1 where ctid = $2',
            v_alvo.esquema, v_alvo.tabela, v_alvo.coluna
          ) using p_contato_principal, v_linha.tid;
          v_movidas := v_movidas + 1;
        exception when unique_violation or exclusion_violation then
          v_pulados := v_pulados + 1;
        end;
      end loop;
    end;

    if v_movidas > 0 then
      v_repontado := v_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_movidas);
    end if;
    if v_pulados > 0 then
      v_nao_repontado := v_nao_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_pulados);
    end if;
  end loop;

  -- 6 · O principal MANDA; o que ele não tem, vem dos perdedores. Nunca o
  --     contrário: sobrescrever o que o atendente digitou seria fusão com
  --     surpresa, e fusão não tem desfazer.
  select c.name into v_nome from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.name is not null
   order by c.created_at, c.id limit 1;
  select c.display_name into v_apelido from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.display_name is not null
   order by c.created_at, c.id limit 1;
  select c.birthdate into v_nascimento from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.birthdate is not null
   order by c.created_at, c.id limit 1;
  select c.email into v_email from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.email is not null
   order by c.created_at, c.id limit 1;
  select c.phone_number into v_telefone from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.phone_number is not null
   order by c.created_at, c.id limit 1;
  -- `wa_identity`/`wa_lid` são GERADAS: o que se herda é a origem delas. Sem
  -- isto o WhatsApp do perdedor fica órfão — `fn_upsert_wa_contact` filtra
  -- `is_merged_into is null`, não acharia mais ninguém e criaria um contato
  -- novo na mensagem seguinte, refazendo a duplicata que acabou de ser desfeita.
  select c.source_metadata->>'waha_lid' into v_lid from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.source_metadata->>'waha_lid' is not null
   order by c.created_at, c.id limit 1;

  -- Guardas de unicidade. A lápide já tirou os perdedores dos índices parciais,
  -- então o que sobrar aqui é conflito com um TERCEIRO contato vivo — e nesse
  -- caso o vencedor simplesmente não herda o campo. Falhar a fusão inteira por
  -- causa de um e-mail seria perder o repontamento que já valeu a pena.
  if v_email is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.email_normalized = lower(btrim(v_email))
  ) then v_email := null; end if;
  if v_telefone is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.phone_number = v_telefone
  ) then v_telefone := null; end if;
  if v_lid is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.wa_lid = v_lid
  ) then v_lid := null; end if;

  select coalesce(array_agg(distinct t), '{}'::text[]) into v_tags
    from (
      select unnest(c.tags) as t from public.contacts c
       where c.organization_id = p_organization_id
         and (c.id = p_contato_principal or c.id = any(p_contatos_secundarios))
    ) as todas;

  -- CPF e `consent` NÃO são herdados, de propósito. CPF é um PAR
  -- (`cpf_encrypted` + `cpf_hash`) preso por check constraint e criptografado
  -- com a chave da instalação — mover metade quebra a linha. `consent` é
  -- registro legal do que AQUELA pessoa autorizou; herdar um "granted_at" de
  -- outro cadastro fabricaria consentimento. Falha fechada nos dois.
  update public.contacts set
    name = coalesce(name, v_nome),
    display_name = coalesce(display_name, v_apelido),
    birthdate = coalesce(birthdate, v_nascimento),
    email = coalesce(email, v_email),
    phone_number = coalesce(phone_number, v_telefone),
    tags = v_tags,
    last_activity_at = greatest(
      last_activity_at,
      (select max(c.last_activity_at) from public.contacts c
        where c.id = any(p_contatos_secundarios))
    ),
    source_metadata = (
      case when source_metadata->>'waha_lid' is null and v_lid is not null
        then source_metadata || jsonb_build_object('waha_lid', v_lid)
        else source_metadata end
    )
      - case when coalesce(phone_number, v_telefone) is not null
             then 'telefone_em_conflito' else '' end
      || jsonb_build_object(
           'mesclado_de',
           coalesce(source_metadata->'mesclado_de', '[]'::jsonb)
             || to_jsonb(p_contatos_secundarios),
           'mesclado_em', to_jsonb(now())
         ),
    updated_at = now()
  where id = p_contato_principal and organization_id = p_organization_id;

  -- 7 · A fusão aparece na timeline de cada negócio que o vencedor passou a ter.
  --     `crm_lead_activities.lead_id` é NOT NULL — contato sem negócio nenhum
  --     não tem onde escrever, e para esse caso quem guarda o rastro é o
  --     `api_audit_log` que a rota emite, sempre.
  insert into public.crm_lead_activities
    (organization_id, lead_id, contact_id, source_module, source_id, type,
     payload, metadata, performed_at, performed_by_user_id)
  select p_organization_id, l.id, p_contato_principal, 'crm', p_contato_principal,
         'contacts_merged',
         jsonb_build_object(
           'contatos_mesclados', to_jsonb(p_contatos_secundarios),
           'repontado', v_repontado,
           'nao_repontado', v_nao_repontado
         ),
         '{}'::jsonb, now(), auth.uid()
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.contact_id = p_contato_principal;
  get diagnostics v_leads = row_count;

  return jsonb_build_object(
    'contato_id', p_contato_principal,
    'contatos_mesclados', to_jsonb(p_contatos_secundarios),
    'repontado', v_repontado,
    'nao_repontado', v_nao_repontado,
    'atividades_emitidas', v_leads
  );
end;
$function$

;

-- Storage usa organização no primeiro segmento. Segmentos de plataforma não
-- recebem concessão nova; esta cerca só restringe os paths do alvo.
create or replace function public.fn_support_storage_write_allowed(p_name text)
returns boolean language sql stable security definer set search_path = public as $f$
 select case when split_part(p_name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 then public.fn_support_write_allowed(split_part(p_name,'/',1)::uuid) else true end;
$f$;
revoke all on function public.fn_support_storage_write_allowed(text) from public,anon;
grant execute on function public.fn_support_storage_write_allowed(text) to authenticated,service_role;
do $f$ begin
 if to_regclass('storage.objects') is not null then
 execute 'drop policy if exists support_write_insert on storage.objects';
 execute 'create policy support_write_insert on storage.objects as restrictive for insert to authenticated with check (public.fn_support_storage_write_allowed(name))';
 execute 'drop policy if exists support_write_update on storage.objects';
 execute 'create policy support_write_update on storage.objects as restrictive for update to authenticated using (public.fn_support_storage_write_allowed(name)) with check (public.fn_support_storage_write_allowed(name))';
 execute 'drop policy if exists support_write_delete on storage.objects';
 execute 'create policy support_write_delete on storage.objects as restrictive for delete to authenticated using (public.fn_support_storage_write_allowed(name))';
 end if;
end $f$;
notify pgrst, 'reload schema';

-- Callback OAuth não recebe JWT Strict. O state assinado liga sessão e ator.
-- Legado sem sessão falha conservadoramente só se houver suporte restrito no alvo.
create or replace function public.fn_support_callback_write_allowed(p_org uuid,p_actor uuid default null,p_session uuid default null)
returns boolean language sql stable security definer set search_path=public as $f$
 select not exists(
 select 1 from platform_support_sessions s
 left join platform_admins p on p.user_id=s.actor_user_id and p.revoked_at is null
 left join auth.sessions a on a.id=s.auth_session_id and a.user_id=s.actor_user_id
 join organizations o on o.id=s.organization_id
 where s.organization_id=p_org and s.ended_at is null
 and (p_actor is null or s.actor_user_id=p_actor)
 and (p_session is null or s.auth_session_id=p_session)
 and (s.access_mode<>'full' or p.scope<>'full' or p.user_id is null or s.expires_at<=now()
 or a.id is null or (a.not_after is not null and a.not_after<=now()) or o.status<>'active'
 or ((p.mfa_required or exists(select 1 from auth.mfa_factors f where f.user_id=s.actor_user_id and f.status='verified')) and coalesce(a.aal::text,'aal1')<>'aal2')));
$f$;
revoke all on function public.fn_support_callback_write_allowed(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_support_callback_write_allowed(uuid,uuid,uuid) to service_role;
