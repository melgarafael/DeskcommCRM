-- manifest: Lista de espera como módulo opcional (#3414, doc 208 = A): `fn_lista_de_espera_provisionar()` cria `calendar_waitlist` só onde o módulo é instalado; `fn_lista_de_espera_ofertar` segura a vaga e marca a inscrição numa transação; o escritor canônico aceita `segurar_pendente` fora de sessão. Nenhuma instalação muda sozinha.
--
-- 9235 — a lista de espera nasce como módulo opcional (ADR-0002).
--
-- A fila de encaixe é de @webtecnica (#3465). O doc 208 decidiu o destino: módulo
-- desligado até a organização instalar e configurar, com o núcleo fornecendo só o
-- escritor seguro. Por isso a migration cria FUNÇÕES e tabela nenhuma; a tabela
-- nasce em `fn_modulo_instalar('lista_de_espera', …)`.

-- ─── 1 · o escritor canônico aprende a SEGURAR ─────────────────────────────
-- Uma linha muda em cada função: `segurar_pendente` faz a reserva nascer `pending`
-- num serviço sem aprovação da equipe. Sem ela o escritor gravaria `confirmed` para quem
-- ainda não respondeu à oferta. Só vale fora de sessão (`auth.uid() is null`):
-- a tela não pede isto, e a aprovação humana do serviço que a exige não muda.
create or replace function public.fn_calendar_service_book(p_org uuid,p_actor jsonb,p_input jsonb,p_execution jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t public.calendar_event_types;a public.calendar_appointments;fact jsonb;occurrence uuid;contact uuid:=(p_input->>'contact_id')::uuid;
  type_id uuid:=(p_input->>'event_type_id')::uuid;start_at timestamptz:=(p_input->>'starts_at')::timestamptz;
  participant text;participant_name text:=nullif(trim(p_input->>'participant_name'),'');command_key text:=p_input->>'operation_key';
begin
  perform public.fn_calendar_service_assert_actor(p_org,p_actor,'agent');
  if contact is null or command_key is null or length(command_key)>500 or not exists(select 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized)
    then raise exception 'service_contact_not_found' using errcode='P0002';end if;
  perform public.fn_service_lock(p_org,contact);
  perform public.fn_calendar_service_lock(p_org);
  -- Anonimização pode ter aguardado a mesma trava enquanto o pedido esperava.
  if not exists(select 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized)
    then raise exception 'service_contact_not_found' using errcode='P0002';end if;
  if p_input->>'conversation_id' is not null and not exists(select 1 from public.conversations where organization_id=p_org
    and id=(p_input->>'conversation_id')::uuid and contact_id=contact and not is_group)
    then raise exception 'service_conversation_not_found' using errcode='P0002';end if;
  if p_actor->>'type'='ai_agent' and (p_actor->>'api_token_id' is null or p_actor->>'native_job' is not null or p_execution is not null)
    and (not public.fn_calendar_service_execution_current(p_org,contact,p_execution)
      or (p_actor->>'native_job' is not null and p_execution->'job'->>'id' is distinct from p_actor->>'native_job'))
    then raise exception 'service_execution_stale' using errcode='42501';end if;
  participant:=contact::text||':'||coalesce(lower(regexp_replace(participant_name,'\s+',' ','g')),'primary');
  -- Retry de comando também confere o conteúdo; não devolve uma operação alheia.
  select * into a from public.calendar_appointments where organization_id=p_org and service_operation_key=command_key;
  if found then
    if a.service_operation_request is distinct from jsonb_build_object('event_type_id',type_id,'contact_id',contact,'starts_at',start_at,'participant_key',participant)
      ||jsonb_strip_nulls(jsonb_build_object('space_id',(p_input->>'space_id')::uuid,'party_size',nullif(coalesce((p_input->>'party_size')::integer,1),1)))
      then raise exception 'service_idempotency_conflict' using errcode='PT409';end if;
    return to_jsonb(a)||jsonb_build_object('deduplicated',true);
  end if;
  select * into t from public.calendar_event_types where organization_id=p_org and id=type_id;
  if not found then raise exception 'service_not_found' using errcode='P0002';end if;
  -- A pessoa já reservada é encontrada antes de consumir vaga ou exigir outro profissional.
  select * into a from public.calendar_appointments where organization_id=p_org and event_type_id=type_id and starts_at=start_at
    and participant_key=participant and status in ('pending','confirmed');
  if found then return to_jsonb(a)||jsonb_build_object('deduplicated',true);end if;
  if p_input?'expected_revision' and t.service_revision is distinct from (p_input->>'expected_revision')::bigint then raise exception 'service_stale' using errcode='PT409';end if;
  fact:=public.fn_calendar_service_check(p_org,type_id,start_at,(p_input->>'owner_user_id')::uuid,null,now(),
    (p_input->>'space_id')::uuid,(p_input->>'party_size')::integer);
  if not coalesce((fact->>'available')::boolean,false) then raise exception '%',fact->>'reason' using errcode='PT409';end if;
  if p_actor->>'type'='user' and fact->>'owner_user_id' is not null and fact->>'owner_user_id' is distinct from p_actor->>'id'
    and not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=(p_actor->>'id')::uuid
      and revoked_at is null and role in ('manager','admin')) and not public.fn_colegas_podem_mexer_na_agenda(p_org)
    then raise exception 'appointment_do_colega' using errcode='42501';end if;
  occurrence:=public.fn_calendar_service_occurrence(p_org,type_id,fact);
  insert into public.calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,time_zone,status,owner_user_id,contact_id,conversation_id,
    description,notes,location_kind,location_details,guest_email,meeting_delivery,created_by_kind,created_by_user_id,source,service_occurrence_id,participant_key,participant_name,
    service_booking_mode,service_capacity_rule,service_capacity_limit,service_rule_revision,service_destination_calendar_id,service_publication_mode,service_requires_confirmation,service_operation_key,service_operation_request,
    service_space_id,service_party_size)
    values(p_org,type_id,coalesce(nullif(p_input->>'title',''),t.name||case when participant_name is null then '' else ' · '||participant_name end),start_at,(fact->>'ends_at')::timestamptz,t.service_timezone,
      case when t.requires_confirmation or (auth.uid() is null and p_input->>'segurar_pendente'='true') then 'pending' else 'confirmed' end,(fact->>'owner_user_id')::uuid,contact,(p_input->>'conversation_id')::uuid,
      nullif(trim(p_input->>'description'),''),nullif(p_input->>'notes',''),t.location_kind,
      case when p_input?'location_details' then nullif(trim(p_input->>'location_details'),'') else t.location_details end,
      nullif(trim(p_input->>'guest_email'),''),coalesce(p_input->'meeting_delivery',jsonb_build_object('state','none')),
      case when p_actor->>'type'='user' then 'user' when p_actor->>'type'='ai_agent' then 'ai' else 'system' end,
      case when p_actor->>'type'='user' then (p_actor->>'id')::uuid else null end,
      case when p_actor->>'type'='user' then 'ui' else 'mcp' end,occurrence,participant,participant_name,
      t.booking_mode,fact->>'capacity_rule',(fact->>'capacity_limit')::integer,t.service_revision,(fact->>'destination_calendar_id')::uuid,t.service_publication_mode,t.requires_confirmation,command_key,
      jsonb_build_object('event_type_id',type_id,'contact_id',contact,'starts_at',start_at,'participant_key',participant)
      ||jsonb_strip_nulls(jsonb_build_object('space_id',(p_input->>'space_id')::uuid,'party_size',nullif(coalesce((p_input->>'party_size')::integer,1),1))),
      (fact->>'space_id')::uuid,coalesce((fact->>'party_size')::integer,1))
    returning * into a;
  return to_jsonb(a)||jsonb_build_object('deduplicated',false,'service_facts',fact);
end $$;
revoke all on function public.fn_calendar_service_book(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_book(uuid,jsonb,jsonb,jsonb) to service_role;

-- O gatilho reescrevia o status vindo do escritor: a mesma condição vale aqui.
create or replace function public.fn_calendar_service_appointment_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare fact jsonb;checked boolean;type_row public.calendar_event_types;
begin
  if tg_op='DELETE' then return old;end if;
  if tg_op='INSERT' and new.service_occurrence_id is null and not new.service_block
    and exists(select 1 from public.calendar_event_types where organization_id=new.organization_id and id=new.event_type_id and service_enabled)
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='INSERT' and auth.uid() is not null and (new.service_block or (new.service_occurrence_id is null and (new.service_destination_calendar_id is not null or new.service_publication_mode is not null)))
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='UPDATE' and auth.uid() is not null and row(new.participant_key,new.participant_name,new.service_destination_calendar_id,new.service_publication_mode,new.service_requires_confirmation,new.service_operation_key,new.service_operation_request,new.service_block,new.service_space_id,new.service_party_size)
    is distinct from row(old.participant_key,old.participant_name,old.service_destination_calendar_id,old.service_publication_mode,old.service_requires_confirmation,old.service_operation_key,old.service_operation_request,old.service_block,old.service_space_id,old.service_party_size)
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='UPDATE' and auth.uid() is not null and ((old.service_occurrence_id is null and new.service_occurrence_id is not null)
    or (old.service_occurrence_id is not null and row(new.contact_id,new.event_type_id) is distinct from row(old.contact_id,old.event_type_id))
    or (row(new.starts_at,new.ends_at,new.owner_user_id,new.service_occurrence_id) is not distinct from row(old.starts_at,old.ends_at,old.owner_user_id,old.service_occurrence_id)
      and row(new.service_booking_mode,new.service_capacity_rule,new.service_capacity_limit,new.service_rule_revision) is distinct from row(old.service_booking_mode,old.service_capacity_rule,old.service_capacity_limit,old.service_rule_revision)))
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='UPDATE' and row(new.starts_at,new.ends_at,new.owner_user_id,new.status,new.service_occurrence_id,new.contact_id,new.event_type_id,new.service_destination_calendar_id,new.service_space_id,new.service_party_size)
    is not distinct from row(old.starts_at,old.ends_at,old.owner_user_id,old.status,old.service_occurrence_id,old.contact_id,old.event_type_id,old.service_destination_calendar_id,old.service_space_id,old.service_party_size) then return new;end if;
  if tg_op='INSERT' and new.service_occurrence_id is not null and new.contact_id is not null then perform public.fn_service_lock(new.organization_id,new.contact_id);end if;
  perform public.fn_calendar_service_lock(new.organization_id);
  if tg_op='INSERT' and new.service_occurrence_id is not null then
    if new.contact_id is null or new.service_operation_key is null or not exists(select 1 from public.contacts where organization_id=new.organization_id and id=new.contact_id and not is_anonymized)
      or new.status not in ('pending','confirmed') then raise exception 'service_creation_invalid' using errcode='22023';end if;
    if auth.uid() is not null then
      perform public.fn_calendar_service_assert_actor(new.organization_id,jsonb_build_object('type','user','id',auth.uid()),'agent');
      new.created_by_kind:='user';new.created_by_user_id:=auth.uid();new.source:='ui';
      new.meeting_delivery:=jsonb_build_object('state','none');
    end if;
    if new.conversation_id is not null and not exists(select 1 from public.conversations where organization_id=new.organization_id and id=new.conversation_id and contact_id=new.contact_id and not is_group)
      then raise exception 'service_conversation_not_found' using errcode='P0002';end if;
    new.participant_key:=new.contact_id::text||':'||coalesce(lower(regexp_replace(nullif(trim(new.participant_name),''),'\s+',' ','g')),'primary');
    -- O lugar e as pessoas entram no pedido: a mesma chave com outra mesa é conflito, não a reserva antiga devolvida.
    new.service_operation_request:=jsonb_build_object('event_type_id',new.event_type_id,'contact_id',new.contact_id,'starts_at',new.starts_at,'participant_key',new.participant_key)
      ||jsonb_strip_nulls(jsonb_build_object('space_id',new.service_space_id,'party_size',nullif(new.service_party_size,1)));
  end if;
  if new.status not in ('pending','confirmed') or new.service_block then return new;end if;
  checked:=new.service_occurrence_id is not null;
  if checked then
    if not exists(select 1 from public.calendar_service_occurrences o where o.organization_id=new.organization_id and o.id=new.service_occurrence_id
      and o.event_type_id=new.event_type_id and o.starts_at=new.starts_at and o.ends_at=new.ends_at)
      then raise exception 'service_occurrence_mismatch' using errcode='23503';end if;
    -- Confirmação não reabre uma reserva já ocupante; mudança de horário, de lugar, de pessoas ou reativação revalida.
    if tg_op='INSERT' or row(new.starts_at,new.ends_at,new.owner_user_id,new.service_occurrence_id) is distinct from row(old.starts_at,old.ends_at,old.owner_user_id,old.service_occurrence_id)
      or row(new.service_space_id,new.service_party_size) is distinct from row(old.service_space_id,old.service_party_size)
      or old.status not in ('pending','confirmed') then
      fact:=public.fn_calendar_service_check(new.organization_id,new.event_type_id,new.starts_at,new.owner_user_id,new.id,now(),new.service_space_id,new.service_party_size);
      if not coalesce((fact->>'available')::boolean,false) then raise exception '%',fact->>'reason' using errcode='PT409';end if;
      if (fact->>'ends_at')::timestamptz is distinct from new.ends_at then raise exception 'service_duration_mismatch' using errcode='PT409';end if;
      new.service_booking_mode:=fact->>'booking_mode';new.service_capacity_rule:=fact->>'capacity_rule';
      new.service_capacity_limit:=(fact->>'capacity_limit')::integer;new.service_rule_revision:=(fact->>'service_revision')::bigint;
      new.service_space_id:=(fact->>'space_id')::uuid;new.service_party_size:=coalesce((fact->>'party_size')::integer,1);
      new.service_occurrence_id:=public.fn_calendar_service_occurrence(new.organization_id,new.event_type_id,fact);
      if tg_op='INSERT' then
        select * into type_row from public.calendar_event_types where organization_id=new.organization_id and id=new.event_type_id;
        new.service_destination_calendar_id:=(fact->>'destination_calendar_id')::uuid;
        new.service_publication_mode:=type_row.service_publication_mode;new.service_requires_confirmation:=type_row.requires_confirmation;
        new.status:=case when type_row.requires_confirmation or (auth.uid() is null and new.status='pending') then 'pending' else 'confirmed' end;
      end if;
    end if;
  end if;
  if new.owner_user_id is not null and exists(select 1 from public.calendar_appointments a where a.organization_id=new.organization_id and a.id<>new.id
    and a.owner_user_id=new.owner_user_id and a.status in ('pending','confirmed') and a.starts_at<new.ends_at and a.ends_at>new.starts_at
    and not (new.service_occurrence_id is not null and a.service_occurrence_id=new.service_occurrence_id
      and new.service_booking_mode in ('collective_limited','collective_unlimited'))
    and (checked or a.service_occurrence_id is not null)) then raise exception 'professional_unavailable' using errcode='PT409';end if;
  return new;
end $$;
revoke all on function public.fn_calendar_service_appointment_guard() from public,anon,authenticated;

-- ─── 2 · a conferência dos vínculos ────────────────────────────────────────
-- `contacts`, `calendar_event_types` e `calendar_appointments` não têm chave
-- (organization_id, id), e uma provisionadora não pode acrescentá-la ao núcleo.
-- Por isso a conferência é gatilho na tabela do módulo: uma linha nunca aponta
-- para a organização vizinha, venha de onde vier a escrita.
create or replace function public.fn_lista_de_espera_conferir_vinculos()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception 'lista_de_espera_organizacao_imutavel' using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id)
     and not exists (select 1 from public.contacts
                      where organization_id = new.organization_id and id = new.contact_id) then
    raise exception 'lista_de_espera_vinculo_invalido' using errcode = '23503';
  end if;
  if (tg_op = 'INSERT' or new.event_type_id is distinct from old.event_type_id)
     and not exists (select 1 from public.calendar_event_types
                      where organization_id = new.organization_id and id = new.event_type_id) then
    raise exception 'lista_de_espera_vinculo_invalido' using errcode = '23503';
  end if;
  if new.owner_user_id is not null
     and (tg_op = 'INSERT' or new.owner_user_id is distinct from old.owner_user_id)
     and not exists (select 1 from public.user_organizations
                      where organization_id = new.organization_id and user_id = new.owner_user_id
                        and revoked_at is null) then
    raise exception 'lista_de_espera_vinculo_invalido' using errcode = '23503';
  end if;
  if new.created_by_user_id is not null
     and (tg_op = 'INSERT' or new.created_by_user_id is distinct from old.created_by_user_id)
     and not exists (select 1 from public.user_organizations
                      where organization_id = new.organization_id and user_id = new.created_by_user_id) then
    raise exception 'lista_de_espera_vinculo_invalido' using errcode = '23503';
  end if;
  if new.oferta_appointment_id is not null
     and (tg_op = 'INSERT' or new.oferta_appointment_id is distinct from old.oferta_appointment_id)
     and not exists (select 1 from public.calendar_appointments
                      where organization_id = new.organization_id and id = new.oferta_appointment_id) then
    raise exception 'lista_de_espera_vinculo_invalido' using errcode = '23503';
  end if;
  return new;
end $f$;
revoke execute on function public.fn_lista_de_espera_conferir_vinculos() from public, anon, authenticated, service_role;

-- ─── 3 · a seção de LGPD ───────────────────────────────────────────────────
-- A anonimização alcança a tabela pelo gatilho `trg_lgpd_secoes_de_modulo`, sem
-- gatilho novo em `contacts`. `observacoes` some, e `fora_da_fila_em` recebe o
-- instante: é ele que tira a pessoa da fila, porque a seção escreve agora em
-- coluna de data e não troca `status`.
create or replace function public.fn_lista_de_espera_declarar_secoes_lgpd()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  if to_regclass('public.calendar_waitlist') is null then
    return;
  end if;
  insert into public.modulo_secoes_lgpd
      (modulo, tabela, ligacao, colunas, colunas_rotulo, colunas_redigidas, colunas_agora)
    values (
      'lista_de_espera',
      'calendar_waitlist',
      'organization_id = $1 and contact_id = $2',
      array['observacoes'],
      '{}'::text[],
      '{}'::text[],
      array['fora_da_fila_em', 'updated_at']
    )
    on conflict (modulo, tabela) do update
      set ligacao = excluded.ligacao,
          colunas = excluded.colunas,
          colunas_rotulo = excluded.colunas_rotulo,
          colunas_redigidas = excluded.colunas_redigidas,
          colunas_agora = excluded.colunas_agora;
end $f$;
revoke execute on function public.fn_lista_de_espera_declarar_secoes_lgpd() from public, anon, authenticated;
grant execute on function public.fn_lista_de_espera_declarar_secoes_lgpd() to service_role;

-- ─── 4 · a provisionadora (ADR-0002, D2) ───────────────────────────────────
-- Sem parâmetro, idempotente, só `service_role`. Escrita da tabela só pelo
-- servidor: `authenticated` lê a fila da própria organização e não grava nada,
-- e cada rota confere a organização antes de chamar o banco.
create or replace function public.fn_lista_de_espera_provisionar()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  create table if not exists public.calendar_waitlist (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,

    -- Quem espera e por qual serviço. Apagar o contato ou o tipo apaga a inscrição.
    contact_id uuid not null references public.contacts(id) on delete cascade,
    event_type_id uuid not null references public.calendar_event_types(id) on delete cascade,

    -- `set null` = "qualquer profissional".
    owner_user_id uuid references auth.users(id) on delete set null,

    -- `{dow: 0..6, start: "HH:MM", end: "HH:MM"}`. Vazio = qualquer horário.
    janelas jsonb not null default '[]'::jsonb,
    antecedencia_minima_horas smallint not null default 0,
    valido_ate timestamptz,
    urgencia smallint not null default 0,

    -- A base da inscrição: quando a pessoa aceitou ser avisada e por onde.
    consentimento_em timestamptz not null,
    consentimento_origem text not null,

    status text not null default 'waiting',

    -- A vaga segurada, e o FIM DO BURACO que abriu: o compromisso segurado tem a
    -- duração do serviço oferecido, e a vaga que passa ao próximo é o buraco.
    oferta_appointment_id uuid references public.calendar_appointments(id) on delete set null,
    oferta_expira_em timestamptz,
    oferta_vaga_fim timestamptz,
    ofertada_em timestamptz,

    -- O início da última vaga que esta pessoa recusou ou deixou vencer. A vaga
    -- passa de mão em mão, e sem isto voltaria a quem já disse não a ela.
    vaga_recusada_inicio timestamptz,

    -- Preenchida pela anonimização (seção de LGPD): a pessoa sai da fila.
    fora_da_fila_em timestamptz,

    observacoes text,

    created_by_kind text not null default 'user',
    created_by_user_id uuid references auth.users(id) on delete set null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint calendar_waitlist_status_check check (status in (
      'waiting','offered','booked','expired','cancelled'
    )),
    constraint calendar_waitlist_created_by_kind_check check (created_by_kind in (
      'user','ai','system','contact'
    )),
    constraint calendar_waitlist_consentimento_origem_check check (consentimento_origem in (
      'tela','agente','contato'
    )),
    constraint calendar_waitlist_janelas_e_lista check (jsonb_typeof(janelas) = 'array'),
    constraint calendar_waitlist_antecedencia_sensata
      check (antecedencia_minima_horas between 0 and 720),
    constraint calendar_waitlist_urgencia_sensata check (urgencia between -5 and 5),
    -- O compromisso não entra nesta conferência: apagá-lo zera a coluna pela FK,
    -- e a varredura de prazo devolve a inscrição à fila.
    constraint calendar_waitlist_oferta_coerente check (
      (status <> 'offered')
      or (oferta_expira_em is not null and oferta_vaga_fim is not null)
    )
  );

  create index if not exists calendar_waitlist_fila_idx
    on public.calendar_waitlist (organization_id, urgencia desc, created_at)
    where status = 'waiting' and fora_da_fila_em is null;
  create unique index if not exists calendar_waitlist_viva_por_contato_servico_idx
    on public.calendar_waitlist (organization_id, contact_id, event_type_id)
    where status in ('waiting', 'offered');
  create index if not exists calendar_waitlist_ofertas_a_vencer_idx
    on public.calendar_waitlist (oferta_expira_em)
    where status = 'offered';
  create index if not exists calendar_waitlist_oferta_appointment_idx
    on public.calendar_waitlist (oferta_appointment_id)
    where oferta_appointment_id is not null;

  alter table public.calendar_waitlist enable row level security;
  drop policy if exists calendar_waitlist_select on public.calendar_waitlist;
  create policy calendar_waitlist_select
    on public.calendar_waitlist
    for select using (
      public.fn_is_platform_admin()
      or organization_id in (select public.fn_user_org_ids())
    );
  revoke all on table public.calendar_waitlist from anon, authenticated, service_role;
  grant select on table public.calendar_waitlist to authenticated;
  grant select, insert, update, delete on table public.calendar_waitlist to service_role;

  drop trigger if exists trg_lista_de_espera_conferir_vinculos on public.calendar_waitlist;
  create trigger trg_lista_de_espera_conferir_vinculos
    before insert or update on public.calendar_waitlist
    for each row execute function public.fn_lista_de_espera_conferir_vinculos();

  comment on table public.calendar_waitlist is
    'Lista de espera (módulo opcional, ADR-0002): quem aceitou ser avisado de um encaixe, por serviço. A vaga oferecida é um compromisso `pending`, e esta linha guarda o prazo.';

  perform public.fn_proteger_modulo_provisionado();
  perform public.fn_lista_de_espera_declarar_secoes_lgpd();
end
$f$;
revoke execute on function public.fn_lista_de_espera_provisionar() from public, anon, authenticated;
grant execute on function public.fn_lista_de_espera_provisionar() to service_role;

-- ─── 5 · a oferta numa transação só ────────────────────────────────────────
-- Segurar a vaga e marcar a inscrição acontecem juntos: não existe compromisso
-- segurado sem dono. Serviço passa pelo escritor canônico; tipo comum confere a
-- sobreposição do profissional sob a mesma trava da agenda antes de gravar. A
-- origem fica a do escritor (`mcp`, autor `system`): `calendar_appointments` não
-- ganha vocabulário de módulo opcional.
--
-- `record` e não `%rowtype`: esta função existe mesmo onde a tabela não existe
-- (ADR-0002, D7).
create or replace function public.fn_lista_de_espera_ofertar(
  p_org uuid, p_espera uuid, p_inicio timestamptz, p_fim timestamptz, p_fuso text,
  p_owner uuid, p_vaga_fim timestamptz, p_expira timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  w record;
  c record;
  t record;
  r jsonb;
  v_contato uuid;
  v_compromisso uuid;
  v_titulo text;
  v_nota text := 'Vaga segurada para a lista de espera. Confirme a resposta da pessoa, ou desmarque para chamar a próxima.';
begin
  select contact_id into v_contato from public.calendar_waitlist
   where organization_id = p_org and id = p_espera;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'inscricao_mudou');
  end if;

  -- A ordem de travas do escritor canônico: contato, depois agenda.
  perform public.fn_service_lock(p_org, v_contato);
  perform public.fn_calendar_service_lock(p_org);

  select status, event_type_id, fora_da_fila_em into w from public.calendar_waitlist
   where organization_id = p_org and id = p_espera for update;
  if w.status is distinct from 'waiting' or w.fora_da_fila_em is not null then
    return jsonb_build_object('ok', false, 'motivo', 'inscricao_mudou');
  end if;

  select is_blocked, is_anonymized into c from public.contacts
   where organization_id = p_org and id = v_contato;
  if not found or c.is_blocked or c.is_anonymized then
    return jsonb_build_object('ok', false, 'motivo', 'contato_indisponivel');
  end if;

  select id, name, is_active, service_enabled, location_kind, location_details into t
    from public.calendar_event_types
   where organization_id = p_org and id = w.event_type_id;
  if not found or not t.is_active then
    return jsonb_build_object('ok', false, 'motivo', 'servico_indisponivel');
  end if;
  v_titulo := t.name || ' — encaixe da lista de espera';

  if t.service_enabled then
    begin
      r := public.fn_calendar_service_book(
        p_org,
        jsonb_build_object('type', 'api_token'),
        jsonb_build_object(
          'contact_id', v_contato, 'event_type_id', t.id, 'starts_at', p_inicio,
          'owner_user_id', p_owner, 'title', v_titulo, 'notes', v_nota,
          'operation_key', 'waitlist:' || gen_random_uuid()::text,
          'segurar_pendente', true
        )
      );
    exception when sqlstate 'PT409' then
      return jsonb_build_object('ok', false, 'motivo', 'servico_indisponivel');
    end;
    -- Reserva que já era dela nesse instante não é oferta nova.
    if coalesce((r->>'deduplicated')::boolean, false) then
      return jsonb_build_object('ok', false, 'motivo', 'inscricao_mudou');
    end if;
    v_compromisso := (r->>'id')::uuid;
  else
    if p_owner is null then
      return jsonb_build_object('ok', false, 'motivo', 'servico_indisponivel');
    end if;
    if exists (
      select 1 from public.calendar_appointments a
       where a.organization_id = p_org and a.owner_user_id = p_owner
         and a.status in ('pending', 'confirmed')
         and a.starts_at < p_fim and a.ends_at > p_inicio
    ) then
      return jsonb_build_object('ok', false, 'motivo', 'vaga_ja_ocupada');
    end if;
    begin
      insert into public.calendar_appointments (
        organization_id, event_type_id, title, starts_at, ends_at, time_zone, status,
        owner_user_id, contact_id, location_kind, location_details, notes,
        created_by_kind, source
      ) values (
        p_org, t.id, v_titulo, p_inicio, p_fim, p_fuso, 'pending',
        p_owner, v_contato, t.location_kind, t.location_details, v_nota,
        'system', 'mcp'
      ) returning id into v_compromisso;
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'motivo', 'vaga_ja_ocupada');
    end;
  end if;

  update public.calendar_waitlist
     set status = 'offered', oferta_appointment_id = v_compromisso, oferta_expira_em = p_expira,
         oferta_vaga_fim = p_vaga_fim, ofertada_em = now(), updated_at = now()
   where organization_id = p_org and id = p_espera;

  return jsonb_build_object('ok', true, 'compromisso_id', v_compromisso);
end $f$;
revoke execute on function public.fn_lista_de_espera_ofertar(uuid, uuid, timestamptz, timestamptz, text, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.fn_lista_de_espera_ofertar(uuid, uuid, timestamptz, timestamptz, text, uuid, timestamptz, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
