-- 0223 — Uma resolução imutável da origem por evento/destino, compartilhada entre
-- automação e gatilho de etapa e entre retries. Não certifica legado.
-- DIRC: recibo por destino do evento; sem payload operacional/memória nova. Retenção
-- acompanha event_log; somente UUIDs/revisões, sem cópia de PII.
create table if not exists public.event_service_origins (
 event_id uuid not null references public.event_log(id) on delete cascade,
 channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 service_boundary jsonb not null,
 primary key(event_id,channel_session_id)
);
alter table public.event_service_origins enable row level security;
revoke all on public.event_service_origins from public,anon,authenticated,service_role;
grant select on public.event_service_origins to service_role;

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
  -- message.received nasce somente do INSERT inbound interno. Um chamador
  -- público não pode reapresentar uma mensagem existente como evento novo.
  if auth.uid() is not null and p_event_type = 'message.received' then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  -- Estes campos autorizam efeitos operacionais; não são payload público.
  if auth.uid() is not null and (
    coalesce(p_payload,'{}'::jsonb) ?| array['service_origin','service_boundary']
    or coalesce(p_metadata,'{}'::jsonb) ?| array['service_origin','service_boundary']
  ) then raise exception 'reserved_service_origin' using errcode='42501'; end if;
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
end $function$;

-- Um único snapshot SQL: inclui a ausência de conversa em cada sessão permitida.
create or replace function public.fn_service_observe_command(p_org uuid,p_contact uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 with destinations as (
 select s.id sid,c.id cid,c.last_message_at,c.created_at conversation_created,s.created_at session_created,s.status,
 jsonb_build_object('channel_session_id',s.id,'observed',case when c.id is null then
   jsonb_build_object('organization_id',p_org,'contact_id',p_contact,'absent',true)
 else jsonb_build_object('organization_id',c.organization_id,'contact_id',c.contact_id,'conversation_id',c.id,
   'service_revision',c.service_revision,'demanda_id',d.id,'demanda_revision',d.revision,
   'status',c.status,'demanda_fechada_em',d.fechada_em,'service_started_at',c.service_started_at) end) snapshot
 from public.channel_sessions s
 left join public.conversations c on c.organization_id=s.organization_id and c.channel_session_id=s.id and c.contact_id=p_contact and not c.is_group
 left join public.demandas d on d.organization_id=c.organization_id and d.contact_id=c.contact_id and d.id=c.current_demanda_id
 where s.organization_id=p_org and s.archived_at is null
 and exists(select 1 from public.contacts where organization_id=p_org and id=p_contact and not is_anonymized and is_merged_into is null)
 )
 select jsonb_build_object('organization_id',p_org,'contact_id',p_contact,
 'default_session_id',(select sid from destinations order by (cid is not null) desc,last_message_at desc nulls last,conversation_created desc nulls last,(status='WORKING') desc,session_created limit 1),
 'destinations',coalesce((select jsonb_agg(snapshot) from destinations),'[]'::jsonb));
$$;
revoke all on function public.fn_service_observe_command(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_observe_command(uuid,uuid) to service_role;

create or replace function public.fn_service_event_origin(p_org uuid,p_event uuid,p_contact uuid,p_session uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.event_log; origin jsonb; boundary jsonb; current_boundary jsonb; entity_contact uuid; cid uuid; sid uuid; observed jsonb; root_event uuid:=p_event; visited uuid[]:=array[]::uuid[];
begin
 -- O drain faz claim otimista em outra transação; não conserva row lock.
 -- Não travar event_log: advisory contato antecede os locks de conversa/FKs.
 perform public.fn_service_lock(p_org,p_contact);
 loop
 if root_event = any(visited) or cardinality(visited)>=32 then raise exception 'service_origin_cycle' using errcode='40001'; end if;
 visited:=array_append(visited,root_event);
 boundary:=null;
 entity_contact:=null;
 select * into e from public.event_log where organization_id=p_org and id=root_event;
 if not found then raise exception 'service_event_not_found' using errcode='P0002'; end if;
 if e.event_type in ('lead.created','lead.stage_changed','lead.tag_added') and e.entity_kind='crm_lead' then
   select contact_id into entity_contact from public.crm_leads where organization_id=p_org and id=e.entity_id;
 elsif e.event_type='contact.tag_added' and e.entity_kind='contact' then
   select id into entity_contact from public.contacts where organization_id=p_org and id=e.entity_id;
 elsif e.event_type='message.received' and e.entity_kind='message' then
   select contact_id,jsonb_build_object('organization_id',organization_id,'contact_id',contact_id,
     'conversation_id',conversation_id,'service_revision',service_revision,'demanda_id',demanda_id,'demanda_revision',demanda_revision)
     into entity_contact,boundary from public.messages where organization_id=p_org and id=e.entity_id and direction='inbound';
 else raise exception 'service_event_origin_unsupported' using errcode='40001'; end if;
 if entity_contact is distinct from p_contact or not exists(select 1 from public.contacts where organization_id=p_org and id=p_contact and not is_anonymized and is_merged_into is null) then
   raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 origin:=e.payload->'service_origin';
 if origin->>'kind'='event' then
   if origin->>'organization_id' is distinct from p_org::text or origin->>'contact_id' is distinct from p_contact::text then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   root_event:=(origin->>'event_id')::uuid;
   if root_event is null then raise exception 'service_stale' using errcode='40001'; end if;
   continue;
 end if;
 exit;
 end loop;
 if boundary is not null or origin->>'kind'='continuation' then
   boundary:=coalesce(boundary,origin->'boundary');
   select channel_session_id into sid from public.conversations where organization_id=p_org and contact_id=p_contact and id=(boundary->>'conversation_id')::uuid;
   if p_session is not null and p_session is distinct from sid then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 elsif origin->>'kind'='command' then
   observed:=origin->'observed';
   if observed->>'organization_id' is distinct from p_org::text or observed->>'contact_id' is distinct from p_contact::text then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   if jsonb_typeof(observed->'destinations')='array' then
     sid:=coalesce(p_session,(observed->>'default_session_id')::uuid);
     select item->'observed' into observed from jsonb_array_elements(observed->'destinations') item where item->>'channel_session_id'=sid::text;
   else
     -- Compatibilidade com snapshot anterior: prova somente sua conversa, nunca ausência de outro canal.
     select channel_session_id into sid from public.conversations where organization_id=p_org and contact_id=p_contact and id=(observed->>'conversation_id')::uuid;
     if p_session is not null and p_session is distinct from sid then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
   end if;
 else raise exception 'service_stale' using errcode='40001'; end if;
 if sid is null then raise exception 'service_stale' using errcode='40001'; end if;
 if not exists(select 1 from public.channel_sessions where id=sid and organization_id=p_org and archived_at is null) then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 if boundary is null and observed is null then raise exception 'service_stale' using errcode='40001'; end if;
 select service_boundary into current_boundary from public.event_service_origins where organization_id=p_org and event_id=root_event and channel_session_id=sid;
 if found then boundary:=current_boundary;
 elsif boundary is null then
   -- PARA UM EVENTO, `absent` E PROCEDENCIA — NAO REIVINDICACAO DE ESTADO.
   --
   -- O CAS de `fn_service_begin` existe para que dois ATORES com a mesma
   -- observacao "ausente" nao ajam os dois: o segundo tem de perder, e o
   -- invariante de `fn_service_begin` guarda isso. Um evento e outra coisa: o
   -- retrato `absent` diz "quando este evento foi EMITIDO nao havia
   -- atendimento", e a resolucao de cada evento ja e idempotente pelo memo
   -- `event_service_origins` logo acima — nao ha corrida a arbitrar aqui.
   --
   -- Sem esta distincao o caminho ORDINARIO morria: um lead criado e depois
   -- movido de etapa gera DOIS eventos, cada um com seu retrato `absent`;
   -- resolver o primeiro cria a conversa e o segundo levantava 40001 — que
   -- `serviceForEvent` engole como `stale_origin`, entao o follow-up de etapa
   -- simplesmente nao nascia, sem erro em lugar nenhum.
   --
   -- Zerar `observed` so quando a conversa JA existe mantem o CAS de pe para o
   -- retrato que descreve uma fronteira concreta (esse continua sendo conferido
   -- contra a vigente) e para todo chamador direto de `fn_service_begin`.
   if observed->>'absent' = 'true' and exists(
        select 1 from public.conversations
         where organization_id=p_org and contact_id=p_contact
           and channel_session_id=sid and not is_group) then
     observed:=null;
   end if;
   boundary:=public.fn_service_begin(p_org,p_contact,sid,observed) - 'status' - 'demanda_fechada_em' - 'service_started_at';
 end if;
 if boundary->>'organization_id' is distinct from p_org::text or boundary->>'contact_id' is distinct from p_contact::text then
   raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 cid:=(boundary->>'conversation_id')::uuid;
 if p_session is not null and not exists(select 1 from public.conversations where organization_id=p_org and id=cid and contact_id=p_contact and channel_session_id=p_session) then
   raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 current_boundary:=public.fn_service_boundary(p_org,cid);
 if current_boundary is null or current_boundary->>'status' in ('closed','resolved','archived')
   or current_boundary->>'demanda_fechada_em' is not null
   or (current_boundary - 'status' - 'demanda_fechada_em' - 'service_started_at') is distinct from boundary then
   raise exception 'service_stale' using errcode='40001'; end if;
 insert into public.event_service_origins(event_id,channel_session_id,organization_id,service_boundary) values(root_event,sid,p_org,boundary)
 on conflict(event_id,channel_session_id) do nothing;
 return boundary;
end; $$;
revoke all on function public.fn_service_event_origin(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_event_origin(uuid,uuid,uuid,uuid) to service_role;
