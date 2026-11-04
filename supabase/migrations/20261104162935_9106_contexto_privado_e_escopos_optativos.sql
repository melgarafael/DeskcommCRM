-- manifest: Escopos optativos, contexto comercial por atendimento e dono humano independente do executor IA, sem ativar empresas.
-- contrato preservado: 0668
-- manifest: Escopos opt-in por atendente, autorização de origem e abertura manual atômica sem alterar entrada automática.
-- Núcleo de autorização. Ausência de linha preserva o produto legado; NULL = todos, {} = nenhum.
create table if not exists public.member_access_scopes (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 pipeline_ids uuid[], channel_ids uuid[], restrict_contacts boolean not null default true,
 updated_at timestamptz not null default now(), primary key(organization_id,user_id)
);
alter table public.member_access_scopes enable row level security;
revoke all on public.member_access_scopes from public,anon;
grant select,insert,update,delete on public.member_access_scopes to authenticated,service_role;
drop policy if exists member_scopes_read on public.member_access_scopes;
create policy member_scopes_read on public.member_access_scopes for select to authenticated using
 (organization_id in(select public.fn_user_org_ids()) and (user_id=auth.uid() or public.fn_role_at_least(organization_id,'admin')));
drop policy if exists member_scopes_admin on public.member_access_scopes;
create policy member_scopes_admin on public.member_access_scopes for all to authenticated using
 (public.fn_role_at_least(organization_id,'admin')) with check(public.fn_role_at_least(organization_id,'admin'));

create or replace function public.fn_acl_scoped(p_org uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select public.fn_user_role_in_org(p_org)='agent' and exists(select 1 from public.member_access_scopes s where s.organization_id=p_org and s.user_id=auth.uid());
$$;
create or replace function public.fn_acl_pipeline(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select coalesce(public.fn_is_platform_admin() or (public.fn_user_role_in_org(p_org) is not null and
 (not public.fn_acl_scoped(p_org) or exists(select 1 from public.member_access_scopes s where s.organization_id=p_org and s.user_id=auth.uid() and (s.pipeline_ids is null or p_id=any(s.pipeline_ids))))),false);
$$;
create or replace function public.fn_acl_channel(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select coalesce(public.fn_is_platform_admin() or (public.fn_user_role_in_org(p_org) is not null and
 (not public.fn_acl_scoped(p_org) or exists(select 1 from public.member_access_scopes s where s.organization_id=p_org and s.user_id=auth.uid() and (s.channel_ids is null or p_id=any(s.channel_ids))))),false);
$$;
-- Sem recursão RLS: os helpers leem fatos básicos como dono; nunca inferem ausência pelo SELECT filtrado.
create or replace function public.fn_acl_lead(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.crm_leads l where l.organization_id=p_org and l.id=p_id and public.fn_can_view_lead(p_org,l.owner_user_id) and public.fn_acl_pipeline(p_org,l.pipeline_id));
$$;
create or replace function public.fn_acl_conversation(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.conversations c where c.organization_id=p_org and c.id=p_id and public.fn_can_view_conversation(p_org,c.assigned_to_user_id) and public.fn_acl_channel(p_org,c.channel_session_id));
$$;
create or replace function public.fn_acl_contact(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select public.fn_is_platform_admin() or
 (public.fn_user_role_in_org(p_org) is not null and (
 not public.fn_acl_scoped(p_org) or
 not exists(select 1 from public.member_access_scopes s where s.organization_id=p_org and s.user_id=auth.uid() and s.restrict_contacts) or
 exists(select 1 from public.crm_leads l where l.organization_id=p_org and l.contact_id=p_id and public.fn_can_view_lead(p_org,l.owner_user_id) and public.fn_acl_pipeline(p_org,l.pipeline_id)) or
 exists(select 1 from public.conversations c where c.organization_id=p_org and c.contact_id=p_id and public.fn_can_view_conversation(p_org,c.assigned_to_user_id) and public.fn_acl_channel(p_org,c.channel_session_id)) or
 exists(select 1 from public.contacts ct where ct.organization_id=p_org and ct.id=p_id and ct.created_by_user_id=auth.uid()
  and not exists(select 1 from public.crm_leads l where l.organization_id=p_org and l.contact_id=p_id)
  and not exists(select 1 from public.conversations c where c.organization_id=p_org and c.contact_id=p_id))));
$$;

-- Gate de relacionamento de demanda: não confundir contato visível com toda negociação desse contato.
create or replace function public.fn_acl_demanda(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select not public.fn_acl_scoped(p_org) or exists(select 1 from public.demandas d where d.organization_id=p_org and d.id=p_id and
 ((d.lead_id is not null and public.fn_acl_lead(p_org,d.lead_id)) or (d.lead_id is null and exists(select 1 from public.demanda_conversas dc where dc.organization_id=p_org and dc.demanda_id=d.id and public.fn_acl_conversation(p_org,dc.conversation_id)))));
$$;
-- Policies restritivas intersectam as permissivas legadas, inclusive contacts FOR ALL.
drop policy if exists acl_contacts_read on public.contacts;
create policy acl_contacts_read on public.contacts as restrictive for select to authenticated using(public.fn_acl_contact(organization_id,id));
drop policy if exists acl_pipelines on public.crm_pipelines;
create policy acl_pipelines on public.crm_pipelines as restrictive for all to authenticated using(public.fn_acl_pipeline(organization_id,id)) with check(public.fn_acl_pipeline(organization_id,id));
drop policy if exists acl_stages on public.crm_stages;
create policy acl_stages on public.crm_stages as restrictive for all to authenticated using(public.fn_acl_pipeline(organization_id,pipeline_id)) with check(public.fn_acl_pipeline(organization_id,pipeline_id));
drop policy if exists acl_channels on public.channel_sessions;
create policy acl_channels on public.channel_sessions as restrictive for all to authenticated using(public.fn_acl_channel(organization_id,id)) with check(public.fn_acl_channel(organization_id,id));
drop policy if exists acl_leads on public.crm_leads;
create policy acl_leads on public.crm_leads as restrictive for all to authenticated using(public.fn_acl_pipeline(organization_id,pipeline_id)) with check(public.fn_acl_pipeline(organization_id,pipeline_id));
drop policy if exists acl_conversations on public.conversations;
create policy acl_conversations on public.conversations as restrictive for select to authenticated using(public.fn_acl_channel(organization_id,channel_session_id));

-- Filhos herdam o objeto, não só organization_id. Guards de escrita também protegem RPCs INVOKER.
do $acl$ declare t text; col text; helper text;
begin
 for t,col,helper in select * from (values
 ('messages','conversation_id','fn_acl_conversation'),('conversation_notes','conversation_id','fn_acl_conversation'),
 ('conversation_drafts','conversation_id','fn_acl_conversation'),('ai_reply_drafts','conversation_id','fn_acl_conversation'),
 ('crm_lead_activities','lead_id','fn_acl_lead'),('crm_lead_links','lead_id','fn_acl_lead'),
 ('crm_proposals','lead_id','fn_acl_lead'),('demandas','id','fn_acl_demanda'),('demanda_conversas','demanda_id','fn_acl_demanda')
 ) as x(t,c,h) loop
  execute format('drop policy if exists acl_related on public.%I',t);
  execute format('create policy acl_related on public.%I as restrictive for all to authenticated using(not public.fn_acl_scoped(organization_id) or public.%I(organization_id,%I)) with check(not public.fn_acl_scoped(organization_id) or public.%I(organization_id,%I))',t,helper,col,helper,col);
 end loop;
end $acl$;

-- Não confiar em auth.uid nulo vindo de uma chamada pública; serviço e psql de instalação preservados.
create or replace function public.fn_acl_guard_core_write() returns trigger
language plpgsql security definer set search_path=public as $$
declare org uuid; actor uuid:=auth.uid(); prev jsonb; nextrow jsonb; scoped boolean;
begin
 prev:=case when tg_op='INSERT' then null else to_jsonb(old) end;
 nextrow:=case when tg_op='DELETE' then null else to_jsonb(new) end;
 org:=coalesce((prev->>'organization_id')::uuid,(nextrow->>'organization_id')::uuid);
 if actor is null then
  if current_setting('role',true) in ('anon','authenticated') then raise exception 'unauthenticated' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; else return new; end if;
 end if;
 if not public.fn_support_write_allowed(org) then raise exception 'support_readonly' using errcode='42501';end if;
 if not public.fn_role_at_least(org,'agent') then raise exception 'forbidden' using errcode='42501';end if;
 scoped:=public.fn_acl_scoped(org);
 if tg_op='UPDATE' and prev->>'organization_id' is distinct from nextrow->>'organization_id' then raise exception 'tenant_immutable' using errcode='42501';end if;
 if tg_table_name='contacts' then
  if scoped and tg_op<>'INSERT' and not public.fn_acl_contact(org,old.id) then raise exception 'contact_outside_scope' using errcode='42501';end if;
  if scoped and tg_op='INSERT' and new.created_by_user_id is distinct from actor then raise exception 'contact_creator_invalid' using errcode='42501';end if;
  if scoped and tg_op='UPDATE' and (prev->>'created_by_user_id' is distinct from nextrow->>'created_by_user_id' or prev->>'carteira_user_id' is distinct from nextrow->>'carteira_user_id') then raise exception 'contact_owner_immutable' using errcode='42501';end if;
 elsif tg_table_name='crm_leads' and scoped then
  if tg_op<>'INSERT' and not public.fn_acl_lead(org,old.id) then raise exception 'lead_outside_scope' using errcode='42501';end if;
  if tg_op<>'DELETE' and (not public.fn_acl_pipeline(org,new.pipeline_id) or (new.contact_id is not null and not public.fn_acl_contact(org,new.contact_id))) then raise exception 'lead_target_outside_scope' using errcode='42501';end if;
  if tg_op='UPDATE' and prev->>'owner_user_id' is distinct from nextrow->>'owner_user_id' then raise exception 'lead_owner_requires_manager' using errcode='42501';end if;
 elsif tg_table_name='conversations' and scoped then
  if tg_op<>'INSERT' and not public.fn_acl_conversation(org,old.id) then raise exception 'conversation_outside_scope' using errcode='42501';end if;
  if tg_op<>'DELETE' and new.assigned_to_user_id=actor and exists(select 1 from public.contacts ct where ct.organization_id=org and ct.id=new.contact_id and ct.carteira_user_id is not null and ct.carteira_user_id<>actor) then raise exception 'contact_in_other_portfolio' using errcode='42501';end if;
  if tg_op='UPDATE' and new.contact_id is distinct from old.contact_id then raise exception 'conversation_contact_immutable' using errcode='42501';end if;
  if tg_op<>'DELETE' and new.assigned_to_user_id is not null and (coalesce(public.fn_member_role_in_org(new.assigned_to_user_id,org),'none') not in ('agent','manager','admin') or exists(select 1 from public.member_access_scopes s where s.organization_id=org and s.user_id=new.assigned_to_user_id and s.channel_ids is not null and not(new.channel_session_id=any(s.channel_ids)))) then raise exception 'assignee_channel_forbidden' using errcode='42501';end if;
  if tg_op<>'DELETE' and (not public.fn_acl_channel(org,new.channel_session_id) or (tg_op='INSERT' and not public.fn_acl_contact(org,new.contact_id))) then raise exception 'conversation_target_outside_scope' using errcode='42501';end if;
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
do $acl$ declare t text;begin
 foreach t in array array['contacts','crm_leads','conversations'] loop
 execute format('drop trigger if exists acl_core_write on public.%I',t);
 execute format('create trigger acl_core_write before insert or update or delete on public.%I for each row execute function public.fn_acl_guard_core_write()',t);
 end loop;
end $acl$;

-- A atribuição é compatibilizada com a assinatura nativa atual ao final.


-- A abertura humana é uma transação própria, não uma exceção pública ao claim de UUID livre.
create or replace function public.fn_open_conversation_manual(p_org uuid,p_contact uuid,p_channel uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.conversations; actor uuid:=auth.uid(); boundary jsonb; from_user uuid;
begin
 if actor is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'forbidden' using errcode='42501';end if;
 perform public.fn_service_lock(p_org,p_contact);
 if not public.fn_acl_channel(p_org,p_channel) or not exists(select 1 from public.channel_sessions where organization_id=p_org and id=p_channel and archived_at is null and status='WORKING') then raise exception 'channel_forbidden' using errcode='42501';end if;
 if not public.fn_acl_contact(p_org,p_contact) or not exists(select 1 from public.contacts where organization_id=p_org and id=p_contact and not is_personal and not is_anonymized and is_merged_into is null) then raise exception 'contact_not_found' using errcode='42501';end if;
 if public.fn_user_role_in_org(p_org)='agent' and exists(select 1 from public.contacts where organization_id=p_org and id=p_contact and carteira_user_id is not null and carteira_user_id<>actor) then raise exception 'contact_in_other_portfolio' using errcode='42501';end if;
 select * into c from public.conversations where organization_id=p_org and contact_id=p_contact and channel_session_id=p_channel and not is_group order by last_message_at desc nulls last,created_at desc limit 1 for no key update;
 if c.id is not null then
   if c.assigned_to_user_id is distinct from actor then raise exception 'conversation_already_exists' using errcode='42501';end if;
 else
   insert into public.conversations(organization_id,contact_id,channel_session_id,status,assigned_to_user_id,assignee_kind,assigned_at,bot_silenced_until,service_started_at)
    values(p_org,p_contact,p_channel,'claimed',actor,'user',now(),'infinity',clock_timestamp()) returning * into c;
   insert into public.conversation_assignment_events(organization_id,conversation_id,from_user_id,to_user_id,changed_by,reason)
     values(p_org,c.id,null,actor,actor,'claim');
 end if;
 -- Checagens ocorreram antes de qualquer reabertura; somente conversa já própria chega aqui.
 boundary:=public.fn_service_begin(p_org,p_contact,p_channel);
 if boundary->>'conversation_id' is distinct from c.id::text then raise exception 'conversation_changed' using errcode='40001';end if;
 update public.conversations set status='claimed',assignee_kind='user',assigned_to_user_id=actor,bot_silenced_until='infinity',updated_at=now()
 where organization_id=p_org and id=c.id;
 return jsonb_build_object('conversation_id',c.id,'contact_id',p_contact);
end $$;

create or replace function public.fn_apagar_contato_com_historico(
  p_contact_id uuid,
  p_organization_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path to 'public', 'pg_temp'
as $$
begin
 if auth.uid() is not null and not public.fn_acl_contact(p_organization_id,p_contact_id) then
 raise exception 'contact_outside_scope' using errcode='42501';end if;
  -- RESTRICT da #752: o histórico sai antes da ficha, na mesma transação.
  delete from public.messages
   where contact_id = p_contact_id
     and organization_id = p_organization_id;

  delete from public.conversations
   where contact_id = p_contact_id
     and organization_id = p_organization_id;

  delete from public.contacts
   where id = p_contact_id
     and organization_id = p_organization_id;

  -- `found` é do DELETE da ficha: false = a ficha não estava acessível para quem
  -- chamou (outra organização, RLS, corrida) — a rota devolve 404 nesse caso.
  return found;
end;
$$;
revoke execute on function public.fn_acl_scoped(uuid) from public,anon;
grant execute on function public.fn_acl_scoped(uuid) to authenticated,service_role;
revoke execute on function public.fn_acl_pipeline(uuid,uuid) from public,anon;
grant execute on function public.fn_acl_pipeline(uuid,uuid) to authenticated,service_role;
revoke execute on function public.fn_acl_channel(uuid,uuid) from public,anon;
grant execute on function public.fn_acl_channel(uuid,uuid) to authenticated,service_role;
revoke execute on function public.fn_acl_lead(uuid,uuid) from public,anon;
grant execute on function public.fn_acl_lead(uuid,uuid) to authenticated,service_role;
revoke execute on function public.fn_acl_conversation(uuid,uuid) from public,anon;
grant execute on function public.fn_acl_conversation(uuid,uuid) to authenticated,service_role;
revoke execute on function public.fn_acl_contact(uuid,uuid) from public,anon;
grant execute on function public.fn_acl_contact(uuid,uuid) to authenticated,service_role;
revoke execute on function public.fn_acl_demanda(uuid,uuid) from public,anon;
grant execute on function public.fn_acl_demanda(uuid,uuid) to authenticated,service_role;
revoke execute on function public.fn_open_conversation_manual(uuid,uuid,uuid) from public,anon;
grant execute on function public.fn_open_conversation_manual(uuid,uuid,uuid) to authenticated,service_role;
revoke execute on function public.fn_acl_guard_core_write() from public,anon,authenticated;
select public.fn_aplicar_travas_de_suporte();
notify pgrst, 'reload schema';

-- Memória global/financeiro sem escopo de caso: não inferir acesso por contato compartilhado.
drop policy if exists acl_global_memory on public.lead_notes;
create policy acl_global_memory on public.lead_notes as restrictive for all to authenticated using(not public.fn_acl_scoped(organization_id)) with check(not public.fn_acl_scoped(organization_id));
drop policy if exists acl_global_orders on public.orders;
create policy acl_global_orders on public.orders as restrictive for all to authenticated using(not public.fn_acl_scoped(organization_id)) with check(not public.fn_acl_scoped(organization_id));
drop policy if exists acl_proposal_items on public.crm_proposal_items;
create policy acl_proposal_items on public.crm_proposal_items as restrictive for all to authenticated using(not public.fn_acl_scoped(organization_id) or exists(select 1 from public.crm_proposals p where p.organization_id=crm_proposal_items.organization_id and p.id=crm_proposal_items.proposal_id)) with check(not public.fn_acl_scoped(organization_id) or exists(select 1 from public.crm_proposals p where p.organization_id=crm_proposal_items.organization_id and p.id=crm_proposal_items.proposal_id));
create or replace function public.fn_acl_storage(p_bucket text,p_name text) returns boolean
language plpgsql stable security definer set search_path=public as $$
declare org uuid;
begin
 begin org:=split_part(p_name,'/',1)::uuid; exception when invalid_text_representation then return true;end;
 if not public.fn_acl_scoped(org) then return true;end if;
 if p_bucket='propostas' then return exists(select 1 from public.crm_proposals p where p.organization_id=org and p.pdf_path=p_name and public.fn_acl_lead(org,p.lead_id));end if;
 if p_bucket='internal-media' then return exists(select 1 from public.conversation_notes n where n.organization_id=org and n.media_storage_path=p_name and public.fn_acl_conversation(org,n.conversation_id));end if;
 if p_bucket='whatsapp-media' then return
 exists(select 1 from public.messages m where m.organization_id=org and m.media_storage_path=p_name and public.fn_acl_conversation(org,m.conversation_id)) or
  exists(select 1 from public.contacts c where c.organization_id=org and c.avatar_storage_path=p_name and public.fn_acl_contact(org,c.id));end if;
 return false;
end $$;
revoke execute on function public.fn_acl_storage(text,text) from public,anon;
grant execute on function public.fn_acl_storage(text,text) to authenticated,service_role;
drop policy if exists acl_storage_read on storage.objects;
create policy acl_storage_read on storage.objects as restrictive for select to authenticated using(public.fn_acl_storage(bucket_id,name));

create or replace function public.fn_set_member_access_scopes(p_org uuid,p_user uuid,p_pipelines uuid[],p_channels uuid[],p_restrict_contacts boolean default true,p_reset boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org) then raise exception 'forbidden' using errcode='42501';end if;
 if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=p_user and role='agent' and revoked_at is null and accepted_at is not null) then raise exception 'member_not_eligible' using errcode='22023';end if;
 if exists(select 1 from unnest(p_pipelines) x where x is null or not exists(select 1 from public.crm_pipelines p where p.id=x and p.organization_id=p_org)) or exists(select 1 from unnest(p_channels) x where x is null or not exists(select 1 from public.channel_sessions c where c.id=x and c.organization_id=p_org and c.archived_at is null)) then raise exception 'scope_target_invalid' using errcode='22023';end if;
 if p_reset then delete from public.member_access_scopes where organization_id=p_org and user_id=p_user;
 else insert into public.member_access_scopes(organization_id,user_id,pipeline_ids,channel_ids,restrict_contacts) values(p_org,p_user,p_pipelines,p_channels,coalesce(p_restrict_contacts,true))
 on conflict(organization_id,user_id) do update set pipeline_ids=excluded.pipeline_ids,channel_ids=excluded.channel_ids,restrict_contacts=excluded.restrict_contacts,updated_at=now();end if;
 insert into public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata) values(p_org,auth.uid(),'team.access_changed','user',p_user,jsonb_build_object('reset',p_reset,'pipeline_ids',p_pipelines,'channel_ids',p_channels,'restrict_contacts',p_restrict_contacts));
 return jsonb_build_object('saved',true,'reset',p_reset);
end $$;
revoke execute on function public.fn_set_member_access_scopes(uuid,uuid,uuid[],uuid[],boolean,boolean) from public,anon;
grant execute on function public.fn_set_member_access_scopes(uuid,uuid,uuid[],uuid[],boolean,boolean) to authenticated;

drop policy if exists acl_cases on public.agent_cases;
create policy acl_cases on public.agent_cases as restrictive for all to authenticated using(not public.fn_acl_scoped(organization_id) or public.fn_acl_conversation(organization_id,conversation_id)) with check(not public.fn_acl_scoped(organization_id) or public.fn_acl_conversation(organization_id,conversation_id));
drop policy if exists acl_case_events on public.agent_case_events;
create policy acl_case_events on public.agent_case_events as restrictive for all to authenticated using(not public.fn_acl_scoped(organization_id) or exists(select 1 from public.agent_cases c where c.organization_id=agent_case_events.organization_id and c.id=agent_case_events.case_id)) with check(not public.fn_acl_scoped(organization_id) or exists(select 1 from public.agent_cases c where c.organization_id=agent_case_events.organization_id and c.id=agent_case_events.case_id));
drop policy if exists acl_field_proposals on public.contact_field_proposals;
create policy acl_field_proposals on public.contact_field_proposals as restrictive for all to authenticated using(not public.fn_acl_scoped(organization_id) or public.fn_acl_conversation(organization_id,conversation_id)) with check(not public.fn_acl_scoped(organization_id) or public.fn_acl_conversation(organization_id,conversation_id));
drop policy if exists acl_tasks on public.crm_tasks;
create policy acl_tasks on public.crm_tasks as restrictive for all to authenticated using(not public.fn_acl_scoped(organization_id) or (assigned_to=auth.uid() and (lead_id is null or public.fn_acl_lead(organization_id,lead_id)))) with check(not public.fn_acl_scoped(organization_id) or (assigned_to=auth.uid() and (lead_id is null or public.fn_acl_lead(organization_id,lead_id))));
-- Aviso global sem relação autorizada não pode ser usado como resumo indireto de negociação.
drop policy if exists acl_inbox_items on public.agent_inbox_items;
create policy acl_inbox_items on public.agent_inbox_items as restrictive for select to authenticated using(not public.fn_acl_scoped(organization_id) or
 (ref_kind='conversation' and public.fn_acl_conversation(organization_id,ref_id)) or
 (ref_kind='lead' and public.fn_acl_lead(organization_id,ref_id)) or
 (ref_kind='proposal' and exists(select 1 from public.crm_proposals p where p.organization_id=agent_inbox_items.organization_id and p.id=agent_inbox_items.ref_id)));

-- Referências de arquivo não concedem leitura de outro caso através de uma assinatura administrativa.
create or replace function public.fn_acl_guard_media_reference() returns trigger
language plpgsql security definer set search_path=public as $$
declare p text; prefix text; suffix text;
begin
 if auth.uid() is null or not public.fn_acl_scoped(new.organization_id) then return new;end if;
 if tg_table_name='contacts' then
   if tg_op='UPDATE' and new.avatar_storage_path is not distinct from old.avatar_storage_path then return new;end if;
   if new.avatar_storage_path is not null then raise exception 'avatar_managed_by_service' using errcode='42501';end if;
   return new;
 end if;
 p:=new.media_storage_path;
 if p is null then return new;end if;
 prefix:=new.organization_id::text||'/'||new.conversation_id::text||'/';
 if left(p,length(prefix))<>prefix then raise exception 'media_outside_conversation' using errcode='42501';end if;
 suffix:=substr(p,length(prefix)+1);
 if suffix='' or position(chr(92) in suffix)>0 or exists(select 1 from unnest(string_to_array(suffix,'/')) segment where segment in ('','.','..')) then raise exception 'media_path_invalid' using errcode='42501';end if;
 return new;
end $$;
revoke execute on function public.fn_acl_guard_media_reference() from public,anon,authenticated;
do $acl$ declare t text;begin
 foreach t in array array['contacts','messages','conversation_notes'] loop
 execute format('drop trigger if exists acl_media_reference on public.%I',t);
 execute format('create trigger acl_media_reference before insert or update on public.%I for each row execute function public.fn_acl_guard_media_reference()',t);
 end loop;
end $acl$;

create or replace function public.fn_push_inscricoes_que_veem_a_conversa(
  p_org uuid,
  p_conversation uuid
) returns table (id uuid, user_id uuid, endpoint text, p256dh text, auth text)
language plpgsql volatile security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_assigned uuid;
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_claim text := current_setting('request.jwt.claim', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  select c.assigned_to_user_id into v_assigned
    from public.conversations c
   where c.id = p_conversation and c.organization_id = p_org;
  if not found then
    return;
  end if;

  -- auth.uid()/auth.jwt() leem estas três; só `claims` carrega o inscrito.
  perform set_config('request.jwt.claim', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  for v_user in
    select distinct s.user_id from public.push_subscriptions s where s.organization_id = p_org
     order by s.user_id
  loop
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user)::text, true);
    if public.fn_acl_conversation(p_org, p_conversation) then
      return query
        select s.id, s.user_id, s.endpoint, s.p256dh, s.auth
          from public.push_subscriptions s
         where s.organization_id = p_org and s.user_id = v_user;
    end if;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim', coalesce(v_claim, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end;
$$;
revoke execute on function public.fn_push_inscricoes_que_veem_a_conversa(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_push_inscricoes_que_veem_a_conversa(uuid,uuid) to service_role;

-- Um vínculo fabricado não autoriza consultar alvos de outro atendimento.
create or replace function public.fn_acl_guard_lead_link() returns trigger
language plpgsql security definer set search_path=public as $$
declare target_ok boolean:=false;
begin
 if auth.uid() is null or not public.fn_acl_scoped(new.organization_id) then return new;end if;
 if not public.fn_acl_lead(new.organization_id,new.lead_id) then raise exception 'link_lead_outside_scope' using errcode='42501';end if;
 case new.target_kind
 when 'contact' then target_ok:=public.fn_acl_contact(new.organization_id,new.target_id);
 when 'conversation' then target_ok:=public.fn_acl_conversation(new.organization_id,new.target_id);
 when 'lead' then target_ok:=public.fn_acl_lead(new.organization_id,new.target_id);
 when 'message' then select exists(select 1 from public.messages m where m.organization_id=new.organization_id and m.id=new.target_id and public.fn_acl_conversation(m.organization_id,m.conversation_id)) into target_ok;
 else target_ok:=false;
 end case;
 if not target_ok then raise exception 'link_target_outside_scope' using errcode='42501';end if;
 return new;
end $$;
revoke execute on function public.fn_acl_guard_lead_link() from public,anon,authenticated;
drop trigger if exists acl_lead_link on public.crm_lead_links;
create trigger acl_lead_link before insert or update on public.crm_lead_links for each row execute function public.fn_acl_guard_lead_link();

-- Roteiros pertencem ao caso/conversa, não a todos que podem ver o cadastro básico.
do $acl$ begin
 if to_regclass('public.followup_enrollments') is not null then
 execute 'drop policy if exists acl_followup_enrollments on public.followup_enrollments';
 execute 'create policy acl_followup_enrollments on public.followup_enrollments as restrictive for all to authenticated using(not public.fn_acl_scoped(organization_id) or (conversation_id is not null and public.fn_acl_conversation(organization_id,conversation_id))) with check(not public.fn_acl_scoped(organization_id) or (conversation_id is not null and public.fn_acl_conversation(organization_id,conversation_id)))';
 end if;
 if to_regclass('public.followup_enrollment_events') is not null then
 execute 'drop policy if exists acl_followup_events on public.followup_enrollment_events';
 execute 'create policy acl_followup_events on public.followup_enrollment_events as restrictive for all to authenticated using(not public.fn_acl_scoped(organization_id) or exists(select 1 from public.followup_enrollments e where e.organization_id=followup_enrollment_events.organization_id and e.id=followup_enrollment_events.enrollment_id)) with check(not public.fn_acl_scoped(organization_id) or exists(select 1 from public.followup_enrollments e where e.organization_id=followup_enrollment_events.organization_id and e.id=followup_enrollment_events.enrollment_id))';
 end if;
end $acl$;


-- contrato preservado: 0669
-- Opt-in explícito. Nenhuma organização/dado real é ativado pela migration.
create table if not exists public.organization_data_boundaries (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 basic_field_keys text[] not null default '{}',
 basic_tags text[] not null default '{}',
 enabled_at timestamptz not null default now(),
 enabled_by uuid references auth.users(id)
);
alter table public.organization_data_boundaries enable row level security;
drop policy if exists data_boundary_read on public.organization_data_boundaries;
create policy data_boundary_read on public.organization_data_boundaries for select to authenticated
 using(public.fn_role_at_least(organization_id,'admin'));
grant select on public.organization_data_boundaries to authenticated;
grant all on public.organization_data_boundaries to service_role;

-- Não atribuir a um caso o conteúdo legado de proveniência desconhecida.
create table if not exists public.contact_context_quarantine (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 contact_id uuid not null references public.contacts(id) on delete cascade deferrable initially deferred,
 payload jsonb not null,
 content_hash text not null,
 captured_at timestamptz not null default now(),
 unique(organization_id,contact_id,content_hash)
);
alter table public.contact_context_quarantine enable row level security;
drop policy if exists contact_quarantine_read on public.contact_context_quarantine;
create policy contact_quarantine_read on public.contact_context_quarantine for select to authenticated
 using(public.fn_role_at_least(organization_id,'manager'));
grant select on public.contact_context_quarantine to authenticated;
grant all on public.contact_context_quarantine to service_role;

create or replace function public.fn_contact_context_private(p_org uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.organization_data_boundaries where organization_id=p_org);
$$;
revoke execute on function public.fn_contact_context_private(uuid) from public,anon;
grant execute on function public.fn_contact_context_private(uuid) to authenticated,service_role;
create or replace function public.fn_contact_history_ids(p_org uuid,p_contact uuid) returns setof uuid
language sql stable security definer set search_path=public as $$
 with recursive family(id) as (select id from public.contacts where organization_id=p_org and id=p_contact
 union select c.id from public.contacts c join family f on c.is_merged_into=f.id where c.organization_id=p_org) select id from family;
$$;
revoke execute on function public.fn_contact_history_ids(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_contact_history_ids(uuid,uuid) to service_role;
create or replace function public.fn_reserved_contact_context(p_org uuid,p_contact uuid)
returns setof public.contact_context_quarantine language plpgsql stable security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'manager') then raise exception 'forbidden' using errcode='42501';end if;
 return query select q.* from public.contact_context_quarantine q where q.organization_id=p_org and q.contact_id in(select public.fn_contact_history_ids(p_org,p_contact)) order by q.captured_at,q.id;
end $$;
revoke execute on function public.fn_reserved_contact_context(uuid,uuid) from public,anon;
grant execute on function public.fn_reserved_contact_context(uuid,uuid) to authenticated;

create or replace function public.fn_guard_contact_data_boundary() returns trigger
language plpgsql security definer set search_path=public as $$
declare cfg public.organization_data_boundaries; safe jsonb; reserved jsonb;
begin
 if not pg_try_advisory_xact_lock_shared(hashtextextended('contact-privacy:'||new.organization_id::text,0)) then raise exception 'contact_privacy_configuration_in_progress' using errcode='40001';end if;
 select * into cfg from public.organization_data_boundaries where organization_id=new.organization_id;
 if not found then return new;end if;
 if new.is_anonymized then
   delete from public.contact_context_quarantine where organization_id=new.organization_id and contact_id in(select public.fn_contact_history_ids(new.organization_id,new.id));
   update public.followup_enrollments set answers='{}' where organization_id=new.organization_id and contact_id in(select public.fn_contact_history_ids(new.organization_id,new.id));
   new.custom_fields:='{}';new.tags:='{}';new.source_metadata:='{}';new.source:='private_context';
   return new;
 end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into safe
 from jsonb_each(coalesce(new.custom_fields,'{}')) where key=any(cfg.basic_field_keys);
 reserved:=jsonb_build_object('custom_fields',coalesce(new.custom_fields,'{}')-cfg.basic_field_keys,
   'tags',to_jsonb(array(select t from unnest(coalesce(new.tags,'{}')) t where not coalesce(t=any(cfg.basic_tags),false))),
   'source_metadata',coalesce(new.source_metadata,'{}'),'source',new.source);
 if reserved<>jsonb_build_object('custom_fields','{}'::jsonb,'tags','[]'::jsonb,'source_metadata','{}'::jsonb,'source',null) then
   insert into public.contact_context_quarantine(organization_id,contact_id,payload,content_hash)
   values(new.organization_id,new.id,reserved,encode(extensions.digest(reserved::text,'sha256'),'hex')) on conflict do nothing;
 end if;
 new.custom_fields:=safe;
 new.tags:=array(select t from unnest(coalesce(new.tags,'{}')) t where coalesce(t=any(cfg.basic_tags),false));
 new.source_metadata:='{}';new.source:='private_context';
 return new;
end $$;
drop trigger if exists aaa_contact_data_boundary on public.contacts;
create trigger aaa_contact_data_boundary before insert or update on public.contacts for each row execute function public.fn_guard_contact_data_boundary();
revoke execute on function public.fn_guard_contact_data_boundary() from public,anon,authenticated;

create or replace function public.fn_set_contact_data_boundary(p_org uuid,p_basic_keys text[],p_basic_tags text[],p_ack_archive boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare n integer;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org) then raise exception 'forbidden' using errcode='42501';end if;
 if p_ack_archive is distinct from true or p_basic_keys is null or p_basic_tags is null or array_position(p_basic_keys,null) is not null or array_position(p_basic_tags,null) is not null or ''=any(p_basic_keys) or ''=any(p_basic_tags) then raise exception 'explicit_boundary_required' using errcode='22023';end if;
 -- Gate por empresa. Escritas concorrentes dessa empresa falham/repetem; não trava outras empresas.
 perform pg_advisory_xact_lock(hashtextextended('contact-privacy:'||p_org::text,0));
 insert into public.organization_data_boundaries(organization_id,basic_field_keys,basic_tags,enabled_by)
 values(p_org,p_basic_keys,p_basic_tags,auth.uid()) on conflict(organization_id) do update set basic_field_keys=excluded.basic_field_keys,basic_tags=excluded.basic_tags;
 update public.contacts set custom_fields=custom_fields where organization_id=p_org and not is_anonymized;
 get diagnostics n=row_count;
 insert into public.api_audit_log(organization_id,actor_user_id,action,resource_type,metadata)
 values(p_org,auth.uid(),'team.data_boundary_changed','contacts',jsonb_build_object('contacts_checked',n,'basic_field_keys',p_basic_keys,'basic_tags',p_basic_tags));
 return jsonb_build_object('contacts_checked',n);
end $$;
revoke execute on function public.fn_set_contact_data_boundary(uuid,text[],text[],boolean) from public,anon;
grant execute on function public.fn_set_contact_data_boundary(uuid,text[],text[],boolean) to authenticated;

-- Respostas novas têm proveniência do roteiro/conversa, e a RLS nativa do enrollment.
alter table public.followup_enrollments add column if not exists answers jsonb not null default '{}';
create or replace function public.fn_store_followup_answer(p_org uuid,p_enrollment uuid,p_contact uuid,p_key text,p_value text)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is not null and not public.fn_role_at_least(p_org,'manager') then raise exception 'forbidden' using errcode='42501';end if;
 if auth.uid() is null and current_setting('role',true) in('anon','authenticated') then raise exception 'forbidden' using errcode='42501';end if;
 if public.fn_contact_context_private(p_org) then
   update public.followup_enrollments e set answers=answers||jsonb_build_object(p_key,p_value)
   where e.organization_id=p_org and e.id=p_enrollment and e.contact_id=p_contact and e.conversation_id is not null
    and exists(select 1 from public.conversations c where c.id=e.conversation_id and c.organization_id=p_org and c.contact_id=p_contact and c.service_revision=e.service_revision)
    and exists(select 1 from public.contacts ct where ct.id=p_contact and ct.organization_id=p_org and not ct.is_anonymized);
 else
   update public.contacts set custom_fields=coalesce(custom_fields,'{}')||jsonb_build_object(p_key,p_value),updated_at=now()
   where organization_id=p_org and id=p_contact and not is_anonymized;
 end if;
 return found;
end $$;
revoke execute on function public.fn_store_followup_answer(uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.fn_store_followup_answer(uuid,uuid,uuid,text,text) to authenticated,service_role;
alter table public.lead_notes add column if not exists conversation_id uuid references public.conversations(id) on delete cascade;
drop policy if exists acl_global_memory on public.lead_notes;
create policy acl_global_memory on public.lead_notes as restrictive for all to authenticated
 using(not public.fn_acl_scoped(organization_id) or (conversation_id is not null and public.fn_acl_conversation(organization_id,conversation_id)))
 with check(not public.fn_acl_scoped(organization_id) or (conversation_id is not null and public.fn_acl_conversation(organization_id,conversation_id)));
notify pgrst,'reload schema';

-- Inspiração PR2269: fila do negócio, lock transacional e recibo durável.
-- Não usar fn_conversation_assign: responsabilidade comercial não é condução.
alter table public.crm_leads add column if not exists commercial_owner_user_id uuid references auth.users(id) on delete set null;
create table if not exists public.commercial_routing_rules (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 channel_id uuid not null references public.channel_sessions(id) on delete cascade,
 pipeline_id uuid not null references public.crm_pipelines(id),
 member_ids uuid[] not null check(array_position(member_ids,null) is null),
 cursor_position bigint not null default 0,
 primary key(organization_id,channel_id)
);
create table if not exists public.conversation_business_contexts (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 conversation_id uuid not null references public.conversations(id) on delete cascade,
 service_revision bigint not null,
 lead_id uuid references public.crm_leads(id) on delete cascade,
 status text not null check(status in('assigned','pending_no_eligible','pending_ambiguous','pending_owner_scope')),
 assigned_at timestamptz,
 primary key(organization_id,conversation_id,service_revision)
);
create table if not exists public.commercial_owner_events (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,
 conversation_id uuid not null references public.conversations(id) on delete cascade, service_revision bigint not null,
 lead_id uuid references public.crm_leads(id) on delete cascade,user_id uuid references auth.users(id),reason text not null,created_at timestamptz not null default now(),
 unique(organization_id,conversation_id,service_revision,reason)
);
alter table public.commercial_owner_events enable row level security;
grant select on public.commercial_owner_events to authenticated;
grant all on public.commercial_owner_events to service_role;
alter table public.commercial_routing_rules enable row level security;
alter table public.conversation_business_contexts enable row level security;
drop policy if exists commercial_rule_admin on public.commercial_routing_rules;
create policy commercial_rule_admin on public.commercial_routing_rules for select to authenticated using(public.fn_role_at_least(organization_id,'admin'));
grant select on public.commercial_routing_rules to authenticated;
grant all on public.commercial_routing_rules,public.conversation_business_contexts to service_role;
grant select on public.conversation_business_contexts to authenticated;

create or replace function public.fn_commercial_member_eligible(p_org uuid,p_user uuid,p_pipeline uuid,p_channel uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.user_organizations m where m.organization_id=p_org and m.user_id=p_user
  and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')
  and (auth.uid() is null and current_setting('role',true) not in('anon','authenticated') or public.fn_user_role_in_org(p_org) is not null or public.fn_is_platform_admin())
  and not exists(select 1 from public.member_access_scopes s where s.organization_id=p_org and s.user_id=p_user
   and ((s.pipeline_ids is not null and not(p_pipeline=any(s.pipeline_ids))) or (s.channel_ids is not null and not(p_channel=any(s.channel_ids))))));
$$;
create or replace function public.fn_commercial_observe(p_org uuid,p_conversation uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and exists(select 1 from public.conversation_business_contexts bc
 join public.conversations c on c.organization_id=bc.organization_id and c.id=bc.conversation_id and c.service_revision=bc.service_revision
 join public.crm_leads l on l.organization_id=bc.organization_id and l.id=bc.lead_id
 where bc.organization_id=p_org and bc.conversation_id=p_conversation and bc.status='assigned'
 and l.commercial_owner_user_id=auth.uid() and public.fn_commercial_member_eligible(p_org,auth.uid(),l.pipeline_id,c.channel_session_id)
 and exists(select 1 from public.commercial_routing_rules r where r.organization_id=p_org and r.channel_id=c.channel_session_id));
$$;
create or replace function public.fn_commercial_ingress(p_org uuid,p_conversation uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare c public.conversations; cfg public.commercial_routing_rules; lead public.crm_leads;
 recipient uuid; stage uuid; n integer; eligible uuid[]; desired uuid; result_status text; created_lead boolean:=false; campaign record;
begin
 if auth.uid() is not null or current_setting('role',true) in('anon','authenticated') then raise exception 'service_only' using errcode='42501';end if;
 if not exists(select 1 from public.commercial_routing_rules where organization_id=p_org) then return jsonb_build_object('configured',false);end if;
 select * into c from public.conversations where organization_id=p_org and id=p_conversation and not is_group;
 if c.id is null then raise exception 'conversation_not_found' using errcode='22023';end if;
 if not exists(select 1 from public.commercial_routing_rules where organization_id=p_org and channel_id=c.channel_session_id) then return jsonb_build_object('configured',false);end if;
 perform public.fn_service_lock(p_org,c.contact_id);
 select * into cfg from public.commercial_routing_rules where organization_id=p_org and channel_id=c.channel_session_id for update;
 if not found then return jsonb_build_object('configured',false);end if;
 select * into c from public.conversations where organization_id=p_org and id=p_conversation for no key update;
 if exists(select 1 from public.contacts ct where ct.id=c.contact_id and ct.organization_id=p_org and (ct.is_blocked or ct.is_personal or ct.is_anonymized)) then return jsonb_build_object('configured',true,'status','contact_ineligible');end if;
 if exists(select 1 from public.conversation_business_contexts bc where bc.organization_id=p_org and bc.conversation_id=c.id and bc.service_revision=c.service_revision and bc.status='assigned') then
   return jsonb_build_object('configured',true,'status','replayed','created',false,'lead_id',(select bc.lead_id from public.conversation_business_contexts bc where bc.organization_id=p_org and bc.conversation_id=c.id and bc.service_revision=c.service_revision));end if;
 select cp.id,cp.name,cp.pipeline_id,cp.stage_id into campaign from public.campaign_recipients cr join public.campaigns cp on cp.id=cr.campaign_id and cp.organization_id=cr.organization_id
  where cr.organization_id=p_org and cr.conversation_id=c.id order by cr.sent_at desc nulls last,cr.id limit 1;
 -- Somente o funil declarado. Uma demanda de suporte no mesmo contato não captura a venda.
 select count(*) into n from public.crm_leads l where l.organization_id=p_org and l.contact_id=c.contact_id and l.pipeline_id=cfg.pipeline_id and l.status='open';
 if n>1 or (campaign.pipeline_id is not null and campaign.pipeline_id<>cfg.pipeline_id) then result_status:='pending_ambiguous';
 else
   select * into lead from public.crm_leads l where l.organization_id=p_org and l.contact_id=c.contact_id and l.pipeline_id=cfg.pipeline_id and l.status='open' for no key update;
   if lead.id is null then
     select s.id into stage from public.crm_stages s where s.organization_id=p_org and s.pipeline_id=cfg.pipeline_id and (campaign.stage_id is null or s.id=campaign.stage_id) and not s.is_archived and not s.is_won and not s.is_lost order by s.position,s.id limit 1;
     if stage is null then raise exception 'pipeline_without_open_stage' using errcode='22023';end if;
     insert into public.crm_leads(organization_id,pipeline_id,stage_id,contact_id,title,source,source_metadata,currency)
      select p_org,cfg.pipeline_id,stage,c.contact_id,coalesce(nullif(ct.display_name,''),ct.name,'Contato'), case when campaign.id is not null then 'campanha' else 'whatsapp' end,
       case when campaign.id is not null then jsonb_build_object('campaign_id',campaign.id,'campaign_name',campaign.name) else '{}'::jsonb end,coalesce(o.currency,'BRL') from public.contacts ct join public.organizations o on o.id=ct.organization_id where ct.id=c.contact_id and ct.organization_id=p_org returning * into lead;
     created_lead:=true;
     insert into public.crm_lead_activities(organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,reason,payload)
      values(p_org,lead.id,c.contact_id,'lead_created','canal.ingest',c.id,'system','entrada comercial configurada por número',jsonb_build_object('conversation_id',c.id,'service_revision',c.service_revision));
     perform public.emit_event('lead.created','crm_lead',lead.id,jsonb_build_object('pipeline_id',cfg.pipeline_id,'stage_id',stage,'conversation_id',c.id),jsonb_build_object('source','nascimento-da-conversa'),p_org);
   end if;
   desired:=coalesce(lead.commercial_owner_user_id,lead.owner_user_id,(select carteira_user_id from public.contacts where organization_id=p_org and id=c.contact_id));
   select array_agg(u order by position) into eligible from unnest(cfg.member_ids) with ordinality x(u,position)
    where public.fn_commercial_member_eligible(p_org,u,cfg.pipeline_id,c.channel_session_id);
   if desired is not null then
     if desired=any(coalesce(eligible,'{}')) then recipient:=desired;else result_status:='pending_owner_scope';end if;
   elsif coalesce(cardinality(eligible),0)>0 then
     recipient:=eligible[(cfg.cursor_position%cardinality(eligible))::integer+1];
   else result_status:='pending_no_eligible';end if;
 end if;
 if recipient is not null then
   update public.crm_leads set commercial_owner_user_id=recipient,
    owner_user_id=case when owner_user_id is null and owner_agent_id is null then recipient else owner_user_id end,
    owner_kind=case when owner_user_id is null and owner_agent_id is null then 'user' else owner_kind end
    where organization_id=p_org and id=lead.id;
   if desired is null then update public.commercial_routing_rules set cursor_position=cursor_position+1 where organization_id=p_org and channel_id=c.channel_session_id;end if;
   result_status:='assigned';
   -- Preview é índice do atendimento atual; mensagens anteriores continuam preservadas.
   update public.conversations set last_message_preview=null where organization_id=p_org and id=c.id and last_message_at<service_started_at;
 end if;
 insert into public.conversation_business_contexts(organization_id,conversation_id,service_revision,lead_id,status,assigned_at)
 values(p_org,c.id,c.service_revision,lead.id,result_status,case when recipient is not null then now() end)
 on conflict(organization_id,conversation_id,service_revision) do update set lead_id=excluded.lead_id,status=excluded.status,assigned_at=excluded.assigned_at;
 insert into public.commercial_owner_events(organization_id,conversation_id,service_revision,lead_id,user_id,reason)
 values(p_org,c.id,c.service_revision,lead.id,recipient,result_status) on conflict do nothing;
 if result_status like 'pending_%' then perform public.fn_request_channel_routing(p_org,c.id);end if;
 return jsonb_build_object('configured',true,'status',result_status,'created',created_lead,'lead_id',lead.id,'pipeline_id',lead.pipeline_id,'stage_id',lead.stage_id,'commercial_owner_user_id',recipient);
end $$;
revoke execute on function public.fn_commercial_ingress(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_commercial_ingress(uuid,uuid) to service_role;
revoke execute on function public.fn_commercial_member_eligible(uuid,uuid,uuid,uuid),public.fn_commercial_observe(uuid,uuid) from public,anon;
grant execute on function public.fn_commercial_member_eligible(uuid,uuid,uuid,uuid),public.fn_commercial_observe(uuid,uuid) to authenticated,service_role;

create or replace function public.fn_set_commercial_rule(p_org uuid,p_channel uuid,p_pipeline uuid,p_members uuid[],p_disabled boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org) then raise exception 'forbidden' using errcode='42501';end if;
 if p_disabled then delete from public.commercial_routing_rules where organization_id=p_org and channel_id=p_channel;
 else
   if not public.fn_contact_context_private(p_org) then raise exception 'data_boundary_required' using errcode='22023';end if;
   if not exists(select 1 from public.channel_sessions where organization_id=p_org and id=p_channel and archived_at is null)
    or not exists(select 1 from public.crm_pipelines where organization_id=p_org and id=p_pipeline and not is_archived)
    or p_members is null or array_position(p_members,null) is not null
    or exists(select 1 from unnest(p_members) u where not public.fn_commercial_member_eligible(p_org,u,p_pipeline,p_channel)) then raise exception 'invalid_commercial_scope' using errcode='22023';end if;
   if cardinality(p_members)<>(select count(distinct u) from unnest(p_members) u) then raise exception 'duplicate_members' using errcode='22023';end if;
   insert into public.commercial_routing_rules(organization_id,channel_id,pipeline_id,member_ids)values(p_org,p_channel,p_pipeline,p_members)
    on conflict(organization_id,channel_id) do update set pipeline_id=excluded.pipeline_id,member_ids=excluded.member_ids;
 end if;
 insert into public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata)
 values(p_org,auth.uid(),'team.commercial_routing_changed','channel_session',p_channel,jsonb_build_object('disabled',p_disabled,'pipeline_id',p_pipeline,'member_ids',p_members));
 return jsonb_build_object('saved',true);
end $$;
revoke execute on function public.fn_set_commercial_rule(uuid,uuid,uuid,uuid[],boolean) from public,anon;
grant execute on function public.fn_set_commercial_rule(uuid,uuid,uuid,uuid[],boolean) to authenticated;

-- Observação permite leitura. Escrita/Assumir continuam pelo caminho humano nativo.
create or replace function public.fn_acl_conversation(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.conversations c where c.organization_id=p_org and c.id=p_id
 and (public.fn_can_view_conversation(p_org,c.assigned_to_user_id) or public.fn_commercial_observe(p_org,c.id)) and public.fn_acl_channel(p_org,c.channel_session_id));
$$;
create or replace function public.fn_acl_lead(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.crm_leads l where l.organization_id=p_org and l.id=p_id
 and (public.fn_can_view_lead(p_org,l.owner_user_id) or (l.commercial_owner_user_id=auth.uid() and public.fn_role_at_least(p_org,'agent'))) and public.fn_acl_pipeline(p_org,l.pipeline_id)
 and (not public.fn_acl_scoped(p_org) or not exists(select 1 from public.conversation_business_contexts bc where bc.organization_id=p_org and bc.lead_id=l.id)
 or exists(select 1 from public.conversation_business_contexts bc join public.conversations c on c.organization_id=bc.organization_id and c.id=bc.conversation_id where bc.organization_id=p_org and bc.lead_id=l.id and public.fn_acl_channel(p_org,c.channel_session_id))));
$$;
drop policy if exists acl_lead_case_channel on public.crm_leads;
create policy acl_lead_case_channel on public.crm_leads as restrictive for select to authenticated using(public.fn_acl_lead(organization_id,id));
drop policy if exists commercial_lead_read on public.crm_leads;
create policy commercial_lead_read on public.crm_leads for select to authenticated using(commercial_owner_user_id=auth.uid() and public.fn_acl_lead(organization_id,id));
drop policy if exists commercial_conversation_read on public.conversations;
create policy commercial_conversation_read on public.conversations for select to authenticated using(public.fn_commercial_observe(organization_id,id));
drop policy if exists commercial_context_read on public.conversation_business_contexts;
create policy commercial_context_read on public.conversation_business_contexts for select to authenticated using(public.fn_acl_conversation(organization_id,conversation_id));
drop policy if exists commercial_event_read on public.commercial_owner_events;
create policy commercial_event_read on public.commercial_owner_events for select to authenticated using(public.fn_role_at_least(organization_id,'manager') or public.fn_commercial_observe(organization_id,conversation_id));
do $acl$ declare t text;begin
 foreach t in array array['messages','conversation_notes','conversation_drafts','ai_reply_drafts'] loop
 execute format('drop policy if exists commercial_observer_read on public.%I',t);
 execute format('create policy commercial_observer_read on public.%I for select to authenticated using(public.fn_commercial_observe(organization_id,conversation_id))',t);
 end loop;
end $acl$;

create or replace function public.is_my_conversation(c public.conversations) returns boolean
language sql stable security definer set search_path=public as $$
 select c.assigned_to_user_id=auth.uid() or public.fn_commercial_observe(c.organization_id,c.id);
$$;
revoke execute on function public.is_my_conversation(public.conversations) from public,anon;
grant execute on function public.is_my_conversation(public.conversations) to authenticated,service_role;
create or replace function public.fn_acl_contact(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select public.fn_is_platform_admin() or (public.fn_user_role_in_org(p_org) is not null and (
 not public.fn_acl_scoped(p_org) or not exists(select 1 from public.member_access_scopes s where s.organization_id=p_org and s.user_id=auth.uid() and s.restrict_contacts)
 or exists(select 1 from public.crm_leads l where l.organization_id=p_org and l.contact_id=p_id and public.fn_acl_lead(p_org,l.id))
 or exists(select 1 from public.conversations c where c.organization_id=p_org and c.contact_id=p_id and public.fn_acl_conversation(p_org,c.id))
 or exists(select 1 from public.contacts ct where ct.organization_id=p_org and ct.id=p_id and ct.created_by_user_id=auth.uid()
 and not exists(select 1 from public.crm_leads l where l.organization_id=p_org and l.contact_id=p_id)
 and not exists(select 1 from public.conversations c where c.organization_id=p_org and c.contact_id=p_id))));
$$;
create or replace function public.fn_guard_contextual_memory() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.contacts where organization_id=new.organization_id and id=new.contact_id and is_anonymized) then
 new.body:='[mensagem anonimizada]';new.headline:='[anonimizado]';new.embedding:=null;return new;end if;
 if public.fn_contact_context_private(new.organization_id) and
 (new.conversation_id is null or not exists(select 1 from public.conversations c where c.organization_id=new.organization_id and c.id=new.conversation_id and c.contact_id=new.contact_id)) then
 raise exception 'memory_requires_conversation' using errcode='42501';end if;
 return new;
end $$;
drop trigger if exists contextual_memory on public.lead_notes;
create trigger contextual_memory before insert or update on public.lead_notes for each row execute function public.fn_guard_contextual_memory();
revoke execute on function public.fn_guard_contextual_memory() from public,anon,authenticated;

create or replace function public.fn_guard_commercial_owner() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is not null and public.fn_user_role_in_org(new.organization_id)='agent' then
   if (tg_op='INSERT' and new.commercial_owner_user_id is not null) or
      (tg_op='UPDATE' and new.commercial_owner_user_id is distinct from old.commercial_owner_user_id) then
     raise exception 'commercial_owner_requires_supervisor' using errcode='42501';end if;
 end if;
 if tg_op='UPDATE' and old.commercial_owner_user_id is not null and new.owner_user_id is distinct from old.owner_user_id then
   if new.owner_user_id is not null then new.commercial_owner_user_id:=new.owner_user_id;
   elsif new.owner_kind is null then new.commercial_owner_user_id:=null;end if;
 end if;
 return new;
end $$;
drop trigger if exists commercial_owner_guard on public.crm_leads;
create trigger commercial_owner_guard before insert or update on public.crm_leads for each row execute function public.fn_guard_commercial_owner();
revoke execute on function public.fn_guard_commercial_owner() from public,anon,authenticated;

-- Leitura adicional não habilita alteração da condução de outro humano.
create or replace function public.fn_guard_commercial_takeover() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is not null and public.fn_user_role_in_org(old.organization_id)='agent' and public.fn_commercial_observe(old.organization_id,old.id)
 and old.assigned_to_user_id is not null and old.assigned_to_user_id<>auth.uid() then
   if tg_op='DELETE' then raise exception 'human_already_in_control' using errcode='42501';end if;
   if new.assigned_to_user_id is distinct from old.assigned_to_user_id or new.assignee_kind is distinct from old.assignee_kind
      or new.bot_silenced_until is distinct from old.bot_silenced_until or new.status is distinct from old.status then
     raise exception 'human_already_in_control' using errcode='42501';
   end if;
 end if;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
drop trigger if exists commercial_takeover_guard on public.conversations;
create trigger commercial_takeover_guard before update or delete on public.conversations for each row execute function public.fn_guard_commercial_takeover();
revoke execute on function public.fn_guard_commercial_takeover() from public,anon,authenticated;
drop policy if exists acl_appointments on public.calendar_appointments;
create policy acl_appointments on public.calendar_appointments as restrictive for all to authenticated
 using(not public.fn_acl_scoped(organization_id) or (owner_user_id=auth.uid() and (conversation_id is null or public.fn_acl_conversation(organization_id,conversation_id))))
 with check(not public.fn_acl_scoped(organization_id) or (owner_user_id=auth.uid() and (conversation_id is null or public.fn_acl_conversation(organization_id,conversation_id))));

-- O vínculo comercial atual não libera mensagens de outro atendimento do mesmo thread.
create or replace function public.fn_case_record_visible(p_org uuid,p_conversation uuid,p_revision bigint) returns boolean
language sql stable security definer set search_path=public as $$
 select public.fn_acl_conversation(p_org,p_conversation) and
 (not public.fn_contact_context_private(p_org) or public.fn_role_at_least(p_org,'manager') or
 exists(select 1 from public.conversations c where c.organization_id=p_org and c.id=p_conversation and c.service_revision=p_revision));
$$;
revoke execute on function public.fn_case_record_visible(uuid,uuid,bigint) from public,anon;
grant execute on function public.fn_case_record_visible(uuid,uuid,bigint) to authenticated,service_role;
alter table public.conversation_notes add column if not exists service_revision bigint;
alter table public.conversation_drafts add column if not exists service_revision bigint;
alter table public.lead_notes add column if not exists service_revision bigint;
alter table public.followup_enrollments add column if not exists service_revision bigint;
create or replace function public.fn_context_revision() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if tg_op='INSERT' then select service_revision into new.service_revision from public.conversations where organization_id=new.organization_id and id=new.conversation_id;
 elsif public.fn_contact_context_private(new.organization_id) and (new.conversation_id is distinct from old.conversation_id or new.service_revision is distinct from old.service_revision) then raise exception 'context_is_immutable' using errcode='42501';end if;
 return new;
end $$;
do $acl$ declare t text;begin
 foreach t in array array['conversation_notes','conversation_drafts','lead_notes','followup_enrollments'] loop
 execute format('drop trigger if exists contextual_revision on public.%I',t);
 execute format('create trigger contextual_revision before insert or update on public.%I for each row execute function public.fn_context_revision()',t);
 execute format('drop policy if exists private_service_record on public.%I',t);
 execute format('create policy private_service_record on public.%I as restrictive for select to authenticated using(not public.fn_contact_context_private(organization_id) or public.fn_role_at_least(organization_id,''manager'') or public.fn_case_record_visible(organization_id,conversation_id,service_revision))',t);
 end loop;
end $acl$;
revoke execute on function public.fn_context_revision() from public,anon,authenticated;
drop policy if exists private_service_record on public.messages;
create policy private_service_record on public.messages as restrictive for select to authenticated using(not public.fn_contact_context_private(organization_id) or public.fn_role_at_least(organization_id,'manager') or public.fn_case_record_visible(organization_id,conversation_id,service_revision));
drop policy if exists private_service_record on public.ai_reply_drafts;
create policy private_service_record on public.ai_reply_drafts as restrictive for select to authenticated using(not public.fn_contact_context_private(organization_id) or public.fn_role_at_least(organization_id,'manager') or public.fn_case_record_visible(organization_id,conversation_id,(service_boundary->>'service_revision')::bigint));
drop policy if exists private_global_state on public.lead_state;
create policy private_global_state on public.lead_state as restrictive for select to authenticated using(not public.fn_contact_context_private(organization_id) or public.fn_role_at_least(organization_id,'manager'));
notify pgrst,'reload schema';

-- A tela não ativa ACL de contatos antes de preparar a fronteira do cadastro.
create or replace function public.fn_set_member_access_scopes(p_org uuid,p_user uuid,p_pipelines uuid[],p_channels uuid[],p_restrict_contacts boolean default true,p_reset boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org) then raise exception 'forbidden' using errcode='42501';end if;
 if not p_reset and not public.fn_contact_context_private(p_org) then raise exception 'data_boundary_required' using errcode='22023';end if;
 if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=p_user and role='agent' and revoked_at is null and accepted_at is not null) then raise exception 'member_not_eligible' using errcode='22023';end if;
 if exists(select 1 from unnest(p_pipelines) x where x is null or not exists(select 1 from public.crm_pipelines p where p.id=x and p.organization_id=p_org)) or exists(select 1 from unnest(p_channels) x where x is null or not exists(select 1 from public.channel_sessions c where c.id=x and c.organization_id=p_org and c.archived_at is null)) then raise exception 'scope_target_invalid' using errcode='22023';end if;
 if p_reset then delete from public.member_access_scopes where organization_id=p_org and user_id=p_user;
 else insert into public.member_access_scopes(organization_id,user_id,pipeline_ids,channel_ids,restrict_contacts) values(p_org,p_user,p_pipelines,p_channels,coalesce(p_restrict_contacts,true))
 on conflict(organization_id,user_id) do update set pipeline_ids=excluded.pipeline_ids,channel_ids=excluded.channel_ids,restrict_contacts=excluded.restrict_contacts,updated_at=now();end if;
 insert into public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata) values(p_org,auth.uid(),'team.access_changed','user',p_user,jsonb_build_object('reset',p_reset,'pipeline_ids',p_pipelines,'channel_ids',p_channels,'restrict_contacts',p_restrict_contacts));
 return jsonb_build_object('saved',true,'reset',p_reset);
end $$;

create or replace function public.fn_guard_private_answers() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if not public.fn_contact_context_private(new.organization_id) then return new;end if;
 if exists(select 1 from public.contacts c where c.organization_id=new.organization_id and c.id=new.contact_id and c.is_anonymized) then new.answers:='{}';return new;end if;
 if new.answers<>'{}' and (tg_op='INSERT' or new.answers is distinct from old.answers) and not exists(select 1 from public.conversations c where c.organization_id=new.organization_id and c.id=new.conversation_id and c.contact_id=new.contact_id and c.service_revision=new.service_revision) then
 raise exception 'answer_requires_current_case' using errcode='42501';end if;
 return new;
end $$;
drop trigger if exists z_private_answers on public.followup_enrollments;
create trigger z_private_answers before insert or update on public.followup_enrollments for each row execute function public.fn_guard_private_answers();
revoke execute on function public.fn_guard_private_answers() from public,anon,authenticated;

-- O storage direto segue a mesma revisão do registro, não só o contato.
create or replace function public.fn_acl_storage(p_bucket text,p_name text) returns boolean
language plpgsql stable security definer set search_path=public as $$
declare org uuid;
begin
 begin org:=split_part(p_name,'/',1)::uuid; exception when invalid_text_representation then return true;end;
 if not public.fn_acl_scoped(org) then return true;end if;
 if p_bucket='propostas' then return exists(select 1 from public.crm_proposals p where p.organization_id=org and p.pdf_path=p_name and public.fn_acl_lead(org,p.lead_id));end if;
 if p_bucket='internal-media' then return exists(select 1 from public.conversation_notes n where n.organization_id=org and n.media_storage_path=p_name and public.fn_case_record_visible(org,n.conversation_id,n.service_revision));end if;
 if p_bucket='whatsapp-media' then return
 exists(select 1 from public.messages m where m.organization_id=org and m.media_storage_path=p_name and public.fn_case_record_visible(org,m.conversation_id,m.service_revision)) or
  exists(select 1 from public.contacts c where c.organization_id=org and c.avatar_storage_path=p_name and public.fn_acl_contact(org,c.id));end if;
 return false;
end $$;

-- Também delimitar os resumos indiretos e casos da mesma thread reutilizada.
alter table public.passagens_de_atendimento add column if not exists service_revision bigint;
alter table public.contact_field_proposals add column if not exists service_revision bigint;
do $acl$ declare t text;begin
 foreach t in array array['passagens_de_atendimento','contact_field_proposals'] loop
 execute format('drop trigger if exists contextual_revision on public.%I',t);
 execute format('create trigger contextual_revision before insert or update on public.%I for each row execute function public.fn_context_revision()',t);
 execute format('drop policy if exists private_service_record on public.%I',t);
 execute format('create policy private_service_record on public.%I as restrictive for select to authenticated using(not public.fn_contact_context_private(organization_id) or public.fn_role_at_least(organization_id,''manager'') or public.fn_case_record_visible(organization_id,conversation_id,service_revision))',t);
 end loop;
end $acl$;
drop policy if exists private_service_record on public.agent_cases;
create policy private_service_record on public.agent_cases as restrictive for select to authenticated
 using(not public.fn_contact_context_private(organization_id) or public.fn_role_at_least(organization_id,'manager') or
 public.fn_case_record_visible(organization_id,conversation_id,(context_snapshot->'service_boundary'->>'service_revision')::bigint));
drop policy if exists private_case_chat on public.agent_case_chat_messages;
create policy private_case_chat on public.agent_case_chat_messages as restrictive for select to authenticated
 using(not public.fn_contact_context_private(organization_id) or public.fn_role_at_least(organization_id,'manager') or
 exists(select 1 from public.agent_cases c where c.organization_id=agent_case_chat_messages.organization_id and c.id=agent_case_chat_messages.case_id));
create or replace function public.fn_guard_case_origin() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if public.fn_contact_context_private(new.organization_id) and (new.conversation_id is distinct from old.conversation_id or ((new.context_snapshot ? 'service_boundary') and new.context_snapshot->'service_boundary' is distinct from old.context_snapshot->'service_boundary')) then
 raise exception 'context_is_immutable' using errcode='42501';end if;
 return new;
end $$;
revoke execute on function public.fn_guard_case_origin() from public,anon,authenticated;
drop trigger if exists private_case_origin on public.agent_cases;
create trigger private_case_origin before update on public.agent_cases for each row execute function public.fn_guard_case_origin();
create or replace function public.fn_acl_demanda(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select not public.fn_acl_scoped(p_org) or exists(select 1 from public.demandas d where d.organization_id=p_org and d.id=p_id and
 ((d.lead_id is not null and public.fn_acl_lead(p_org,d.lead_id)) or (d.lead_id is null and exists(
 select 1 from public.demanda_conversas dc join public.conversations c on c.organization_id=dc.organization_id and c.id=dc.conversation_id
 where dc.organization_id=p_org and dc.demanda_id=d.id and public.fn_acl_conversation(p_org,dc.conversation_id)
 and (not public.fn_contact_context_private(p_org) or (dc.service_revision=c.service_revision and c.current_demanda_id=d.id))))));
$$;
notify pgrst,'reload schema';


-- contrato preservado: 0902
-- manifest: Vínculo explícito fonte→regra comercial para leads sem conversa, com recibo pendente e recuperação idempotente; default-off.
-- Número provisório local: conferir colisões no upstream antes de integrar/publicar.
create table if not exists public.commercial_source_bindings (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 source_id uuid not null references public.webhook_sources(id) on delete cascade,
 rule_channel_id uuid not null,
 primary key(organization_id,source_id),
 foreign key(organization_id,rule_channel_id) references public.commercial_routing_rules(organization_id,channel_id) on delete cascade
);
create table if not exists public.commercial_source_receipts (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 lead_id uuid not null references public.crm_leads(id) on delete cascade,
 source_id uuid not null references public.webhook_sources(id) on delete cascade,
 status text not null check(status in('assigned','pending_rule','pending_pipeline','pending_no_eligible','pending_owner_scope','pending_contact')),
 user_id uuid references auth.users(id),
 updated_at timestamptz not null default now(),
 primary key(organization_id,lead_id)
);
alter table public.commercial_source_bindings enable row level security;
alter table public.commercial_source_receipts enable row level security;
revoke all on public.commercial_source_bindings,public.commercial_source_receipts from public,anon,authenticated;
grant select on public.commercial_source_bindings,public.commercial_source_receipts to authenticated;
grant all on public.commercial_source_bindings,public.commercial_source_receipts to service_role;
drop policy if exists commercial_source_admin on public.commercial_source_bindings;
create policy commercial_source_admin on public.commercial_source_bindings for select to authenticated using(public.fn_role_at_least(organization_id,'admin'));
drop policy if exists commercial_source_admin on public.commercial_source_receipts;
create policy commercial_source_admin on public.commercial_source_receipts for select to authenticated using(public.fn_role_at_least(organization_id,'admin'));

create or replace function public.fn_commercial_source_ingress(p_org uuid,p_lead uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare l public.crm_leads; cfg public.commercial_routing_rules; b public.commercial_source_bindings;
 source_uuid uuid; recipient uuid; desired uuid; eligible uuid[]; outcome text; ct public.contacts;
begin
 if pg_trigger_depth()=0 and auth.uid() is not null then
  if not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org) then raise exception 'forbidden' using errcode='42501';end if;
 elsif pg_trigger_depth()=0 and current_setting('role',true) in('anon','authenticated') then raise exception 'forbidden' using errcode='42501';end if;
 -- Lock order matches conversation ingress: contact, rule, lead.
 select * into l from public.crm_leads where organization_id=p_org and id=p_lead;
 if l.id is null then raise exception 'lead_not_found' using errcode='22023';end if;
 if not public.fn_contact_context_private(p_org) or l.source<>'webhook' then return jsonb_build_object('configured',false);end if;
 begin source_uuid:=(l.source_metadata->>'webhook_source_id')::uuid;exception when invalid_text_representation then return jsonb_build_object('configured',false);end;
 select * into b from public.commercial_source_bindings where organization_id=p_org and source_id=source_uuid;
 if b.source_id is null then return jsonb_build_object('configured',false);end if;
 if l.contact_id is not null then perform public.fn_service_lock(p_org,l.contact_id);end if;
 select * into cfg from public.commercial_routing_rules where organization_id=p_org and channel_id=b.rule_channel_id for update;
 select * into l from public.crm_leads where organization_id=p_org and id=p_lead for no key update;
 if exists(select 1 from public.commercial_source_receipts where organization_id=p_org and lead_id=p_lead and status='assigned') then return jsonb_build_object('configured',true,'status','replayed');end if;
 if l.status<>'open' then return jsonb_build_object('configured',true,'status','closed');end if;
 select * into ct from public.contacts where organization_id=p_org and id=l.contact_id;
 if cfg.channel_id is null or not exists(select 1 from public.webhook_sources where organization_id=p_org and id=source_uuid and is_active)
  or not exists(select 1 from public.channel_sessions where organization_id=p_org and id=cfg.channel_id and archived_at is null) then outcome:='pending_rule';
 elsif cfg.pipeline_id<>l.pipeline_id or not exists(select 1 from public.crm_pipelines where organization_id=p_org and id=l.pipeline_id and not is_archived) then outcome:='pending_pipeline';
 elsif ct.id is null or ct.is_blocked or ct.is_personal or ct.is_anonymized then outcome:='pending_contact';
 else
  desired:=coalesce(l.commercial_owner_user_id,l.owner_user_id,ct.carteira_user_id);
  select array_agg(u order by position) into eligible from unnest(cfg.member_ids) with ordinality x(u,position)
   where public.fn_commercial_member_eligible(p_org,u,cfg.pipeline_id,cfg.channel_id);
  if desired is not null then
   if desired=any(coalesce(eligible,'{}')) then recipient:=desired;else outcome:='pending_owner_scope';end if;
  elsif coalesce(cardinality(eligible),0)>0 then recipient:=eligible[(cfg.cursor_position%cardinality(eligible))::integer+1];
  else outcome:='pending_no_eligible';end if;
 end if;
 if recipient is not null then
  -- Commercial observation only: never replace the executor (human or AI).
  update public.crm_leads set commercial_owner_user_id=recipient where organization_id=p_org and id=p_lead;
  if desired is null then update public.commercial_routing_rules set cursor_position=cursor_position+1 where organization_id=p_org and channel_id=cfg.channel_id;end if;
  outcome:='assigned';
  insert into public.crm_lead_activities(organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,reason,payload)
   values(p_org,p_lead,l.contact_id,'lead_edited','canal.ingest',source_uuid,'system','responsável comercial por fonte explícita',jsonb_build_object('commercial_owner_user_id',recipient,'webhook_source_id',source_uuid));
 end if;
 insert into public.commercial_source_receipts(organization_id,lead_id,source_id,status,user_id) values(p_org,p_lead,source_uuid,outcome,recipient)
 on conflict(organization_id,lead_id) do update set status=excluded.status,user_id=excluded.user_id,updated_at=now();
 if auth.uid() is not null then
  insert into public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata) values(p_org,auth.uid(),'team.commercial_source_retried','crm_lead',p_lead,jsonb_build_object('status',outcome));
 end if;
 return jsonb_build_object('configured',true,'status',outcome,'commercial_owner_user_id',recipient);
end $$;
revoke execute on function public.fn_commercial_source_ingress(uuid,uuid) from public,anon;
grant execute on function public.fn_commercial_source_ingress(uuid,uuid) to authenticated,service_role;

create or replace function public.fn_set_commercial_source(p_org uuid,p_source uuid,p_channel uuid,p_disabled boolean default false) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org) then raise exception 'forbidden' using errcode='42501';end if;
 if p_disabled then delete from public.commercial_source_bindings where organization_id=p_org and source_id=p_source;
 else
  if not public.fn_contact_context_private(p_org) or not exists(select 1 from public.webhook_sources s join public.commercial_routing_rules r on r.organization_id=s.organization_id and r.pipeline_id=s.default_pipeline_id where s.organization_id=p_org and s.id=p_source and s.is_active and r.channel_id=p_channel) then raise exception 'invalid_source_binding' using errcode='22023';end if;
  insert into public.commercial_source_bindings(organization_id,source_id,rule_channel_id)values(p_org,p_source,p_channel) on conflict(organization_id,source_id)do update set rule_channel_id=excluded.rule_channel_id;
 end if;
 insert into public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata)values(p_org,auth.uid(),'team.commercial_source_changed','webhook_source',p_source,jsonb_build_object('disabled',p_disabled,'rule_channel_id',p_channel));
 return jsonb_build_object('saved',true);
end $$;
revoke execute on function public.fn_set_commercial_source(uuid,uuid,uuid,boolean) from public,anon;
grant execute on function public.fn_set_commercial_source(uuid,uuid,uuid,boolean) to authenticated;

create or replace function public.fn_commercial_source_insert() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 perform public.fn_commercial_source_ingress(new.organization_id,new.id);
 return null;
exception when others then
 insert into public.commercial_source_receipts(organization_id,lead_id,source_id,status)
 select new.organization_id,new.id,b.source_id,'pending_rule' from public.commercial_source_bindings b
 where b.organization_id=new.organization_id and b.source_id::text=new.source_metadata->>'webhook_source_id'
 on conflict(organization_id,lead_id) do update set status='pending_rule',updated_at=now();
 return null;
end $$;
revoke execute on function public.fn_commercial_source_insert() from public,anon,authenticated;
drop trigger if exists commercial_source_insert on public.crm_leads;
create trigger commercial_source_insert after insert on public.crm_leads for each row when(new.source='webhook' and new.status='open') execute function public.fn_commercial_source_insert();
notify pgrst,'reload schema';


-- contrato preservado: 0903
-- manifest: Dono comercial delimita leitura privada do negócio e derivados sem trocar executor IA; gestores e default-off preservados.
-- Numeração provisória local; reconciliar upstream antes de integrar.
create or replace function public.fn_acl_lead(p_org uuid,p_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.crm_leads l where l.organization_id=p_org and l.id=p_id
 and (case when not public.fn_is_platform_admin() and public.fn_contact_context_private(p_org) and public.fn_user_role_in_org(p_org)='agent' and l.commercial_owner_user_id is not null
 then l.commercial_owner_user_id=auth.uid()
 else public.fn_can_view_lead(p_org,l.owner_user_id) or (l.commercial_owner_user_id=auth.uid() and public.fn_role_at_least(p_org,'agent')) end)
 and public.fn_acl_pipeline(p_org,l.pipeline_id)
 and (not public.fn_acl_scoped(p_org) or not exists(select 1 from public.conversation_business_contexts bc where bc.organization_id=p_org and bc.lead_id=l.id)
 or exists(select 1 from public.conversation_business_contexts bc join public.conversations c on c.organization_id=bc.organization_id and c.id=bc.conversation_id where bc.organization_id=p_org and bc.lead_id=l.id and public.fn_acl_channel(p_org,c.channel_session_id))));
$$;
revoke execute on function public.fn_acl_lead(uuid,uuid) from public,anon;
grant execute on function public.fn_acl_lead(uuid,uuid) to authenticated,service_role;
-- Existing scoped guards remain. Privacy also applies to agents without individual scopes.
do $acl$ declare t text;begin
 foreach t in array array['crm_lead_activities','crm_lead_links','crm_proposals','crm_tasks'] loop
 execute format('drop policy if exists commercial_private_insert on public.%I',t);
 execute format('create policy commercial_private_insert on public.%I as restrictive for insert to authenticated with check(not public.fn_contact_context_private(organization_id) or public.fn_user_role_in_org(organization_id)<>''agent'' or lead_id is null or public.fn_acl_lead(organization_id,lead_id))',t);
 execute format('drop policy if exists commercial_private_parent on public.%I',t);
 execute format('create policy commercial_private_parent on public.%I as restrictive for select to authenticated using(not public.fn_contact_context_private(organization_id) or public.fn_user_role_in_org(organization_id)<>''agent'' or lead_id is null or public.fn_acl_lead(organization_id,lead_id))',t);
 end loop;
end $acl$;
-- Legacy child SELECT checks executor ownership; commercial observer needs a positive path too.
do $acl$ declare t text;begin
 foreach t in array array['crm_lead_activities','crm_lead_links','crm_proposals'] loop
 execute format('drop policy if exists commercial_private_observer on public.%I',t);
 execute format('create policy commercial_private_observer on public.%I for select to authenticated using(public.fn_contact_context_private(organization_id) and public.fn_user_role_in_org(organization_id)=''agent'' and public.fn_acl_lead(organization_id,lead_id))',t);
 end loop;
end $acl$;
drop policy if exists commercial_private_proposal_parent on public.crm_proposal_items;
create policy commercial_private_proposal_parent on public.crm_proposal_items as restrictive for select to authenticated using(
 not public.fn_contact_context_private(organization_id) or public.fn_user_role_in_org(organization_id)<>'agent'
 or exists(select 1 from public.crm_proposals p where p.organization_id=crm_proposal_items.organization_id and p.id=crm_proposal_items.proposal_id));
notify pgrst,'reload schema';


-- contrato preservado: 0905
-- manifest: Impede transferência comercial indireta por atendente no opt-in privado sem escopo individual.
create or replace function public.fn_guard_commercial_owner() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is not null and public.fn_user_role_in_org(new.organization_id)='agent' then
   if (tg_op='INSERT' and new.commercial_owner_user_id is not null) or
      (tg_op='UPDATE' and new.commercial_owner_user_id is distinct from old.commercial_owner_user_id) then
     raise exception 'commercial_owner_requires_supervisor' using errcode='42501';end if;
 end if;
 if tg_op='UPDATE' and old.commercial_owner_user_id is not null and new.owner_user_id is distinct from old.owner_user_id then
   if new.owner_user_id is not null then new.commercial_owner_user_id:=new.owner_user_id;
   elsif new.owner_kind is null then new.commercial_owner_user_id:=null;end if;
 end if;
 -- Validar o responsável EFETIVO após derivação: assumir para si mantendo
 -- o mesmo comercial não é transferir o negócio para outra pessoa.
 if tg_op='UPDATE' and auth.uid() is not null
 and public.fn_user_role_in_org(new.organization_id)='agent'
 and public.fn_contact_context_private(new.organization_id)
 and new.commercial_owner_user_id is distinct from old.commercial_owner_user_id then
  raise exception 'commercial_owner_requires_supervisor' using errcode='42501';
 end if;
 return new;
end $$;
drop trigger if exists commercial_owner_guard on public.crm_leads;
create trigger commercial_owner_guard before insert or update on public.crm_leads for each row execute function public.fn_guard_commercial_owner();
revoke execute on function public.fn_guard_commercial_owner() from public,anon,authenticated;

-- Responsável comercial pode trabalhar o card sem converter o executor IA em
-- humano. A policy legada de UPDATE considera apenas owner_user_id e, sob own,
-- produzia UPDATE 0 no card que o comercial já conseguia ler. O guard acima
-- mantém a transferência de responsabilidade reservada à supervisão.
drop policy if exists commercial_lead_update on public.crm_leads;
create policy commercial_lead_update on public.crm_leads for update to authenticated
 using(public.fn_contact_context_private(organization_id)
  and public.fn_user_role_in_org(organization_id)='agent'
  and commercial_owner_user_id=auth.uid() and public.fn_acl_lead(organization_id,id)
  and public.fn_support_write_allowed(organization_id))
 with check(public.fn_contact_context_private(organization_id)
  and public.fn_user_role_in_org(organization_id)='agent'
  and commercial_owner_user_id=auth.uid() and public.fn_acl_lead(organization_id,id)
  and public.fn_support_write_allowed(organization_id));


-- contrato preservado: 9022
-- manifest: Compatibiliza co-atendimento nativo com a carteira e o canal opt-in escopo optativo, sem ampliar acesso por convite nem alterar o padrão dos demais membros.
-- A participação nativa concede uma permissão SELECT adicional. Nos membros
-- que optaram pelo recorte comercial, convite não é transferência de carteira.
drop policy if exists scoped_participacao_preserva_carteira on public.conversations;
create policy scoped_participacao_preserva_carteira
  on public.conversations as restrictive for select to authenticated
  using (not public.fn_acl_scoped(organization_id)
         or public.fn_acl_conversation(organization_id,id));


-- contrato preservado: 9023
-- manifest: Preserva o claim nativo com CAS da 9017 fora do recorte opt-in, mantendo carteira/canal escopo optativo e bloqueio de transferência indevida.
-- A função completa evita depender da ordem entre apêndices locais e oficiais.
-- A atribuição é compatibilizada com a assinatura nativa atual ao final.



-- contrato preservado: 9024
-- manifest: Avalia a visibilidade do negócio com os campos da linha no SELECT, preservando carteira/canal e permitindo INSERT RETURNING sem releitura STABLE da linha ainda invisível.
create or replace function public.fn_acl_lead_row(
 p_org uuid,p_id uuid,p_owner uuid,p_commercial_owner uuid,p_pipeline uuid
) returns boolean language sql stable security definer set search_path=public as $$
 select (case when not public.fn_is_platform_admin()
   and public.fn_contact_context_private(p_org)
   and public.fn_user_role_in_org(p_org)='agent'
   and p_commercial_owner is not null
 then p_commercial_owner=auth.uid()
 else public.fn_can_view_lead(p_org,p_owner)
   or (p_commercial_owner=auth.uid() and public.fn_role_at_least(p_org,'agent')) end)
 and public.fn_acl_pipeline(p_org,p_pipeline)
 and (not public.fn_acl_scoped(p_org)
   or not exists(select 1 from public.conversation_business_contexts bc where bc.organization_id=p_org and bc.lead_id=p_id)
   or exists(select 1 from public.conversation_business_contexts bc
      join public.conversations c on c.organization_id=bc.organization_id and c.id=bc.conversation_id
      where bc.organization_id=p_org and bc.lead_id=p_id and public.fn_acl_channel(p_org,c.channel_session_id)));
$$;
revoke all on function public.fn_acl_lead_row(uuid,uuid,uuid,uuid,uuid) from public,anon;
grant execute on function public.fn_acl_lead_row(uuid,uuid,uuid,uuid,uuid) to authenticated,service_role;
drop policy if exists acl_lead_case_channel on public.crm_leads;
create policy acl_lead_case_channel on public.crm_leads as restrictive for select to authenticated
 using(public.fn_acl_lead_row(organization_id,id,owner_user_id,commercial_owner_user_id,pipeline_id));


-- contrato preservado: 9029
-- manifest: Materializa fatos ACL por consulta e decide atributos da linha sem perder NEW/RETURNING.
-- LOCAL candidate: uncorrelated InitPlan supplies context; no persistent authorization cache.
create schema if not exists scoped_acl_row_private;
revoke all on schema scoped_acl_row_private from public,anon,authenticated;
create or replace function scoped_acl_row_private.statement_context()
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $context$
with actor as materialized(select auth.uid() uid, public.fn_is_platform_admin() platform),
roles as materialized(select o.id org,o.settings,a.uid,a.platform,public.fn_user_role_in_org(o.id) role,
 exists(select 1 from public.organization_data_boundaries d where d.organization_id=o.id) private
 from public.organizations o cross join actor a),
ctx as materialized(select r.*,s.channel_ids,s.pipeline_ids,coalesce(s.restrict_contacts,false) restrict_contacts,
 (r.role='agent' and s.user_id is not null) scoped,
 coalesce(r.settings->>'visibility_mode','own_and_unassigned') visibility,
 exists(select 1 from public.user_organizations m where m.organization_id=r.org and m.user_id=r.uid and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')) eligible
 from roles r left join public.member_access_scopes s on s.organization_id=r.org and s.user_id=r.uid),
channels as materialized(select c.id,c.organization_id from public.channel_sessions c join ctx x on x.org=c.organization_id
 where x.platform or(x.role is not null and(not x.scoped or x.channel_ids is null or c.id=any(x.channel_ids)))),
lead_base as materialized(select l.*,x.uid,x.platform,x.role,x.private,x.scoped,x.channel_ids,x.pipeline_ids,x.visibility,
 (x.platform or case when x.role is null then false when x.role in('viewer','manager','admin') then true when l.owner_user_id=x.uid then true when x.visibility='all' then true when x.visibility='own_and_unassigned' then l.owner_user_id is null else false end) view_allowed
 from public.crm_leads l join ctx x on x.org=l.organization_id),
leads as materialized(select l.id,l.organization_id,l.contact_id from lead_base l where
 (case when not l.platform and l.private and l.role='agent' and l.commercial_owner_user_id is not null then l.commercial_owner_user_id=l.uid
 else l.view_allowed or(l.commercial_owner_user_id=l.uid and l.role in('agent','manager','admin')) end)
 and(l.platform or(l.role is not null and(not l.scoped or l.pipeline_ids is null or l.pipeline_id=any(l.pipeline_ids))))
 and(not l.scoped or not exists(select 1 from public.conversation_business_contexts bc where bc.organization_id=l.organization_id and bc.lead_id=l.id)
 or exists(select 1 from public.conversation_business_contexts bc join public.conversations c on c.organization_id=bc.organization_id and c.id=bc.conversation_id where bc.organization_id=l.organization_id and bc.lead_id=l.id and(l.platform or(l.role is not null and(not l.scoped or l.channel_ids is null or c.channel_session_id=any(l.channel_ids))))))),
commercial as materialized(select distinct c.id,c.organization_id from public.conversations c join ctx x on x.org=c.organization_id
 join public.conversation_business_contexts bc on bc.organization_id=c.organization_id and bc.conversation_id=c.id and bc.service_revision=c.service_revision and bc.status='assigned'
 join public.crm_leads l on l.organization_id=bc.organization_id and l.id=bc.lead_id
 where x.uid is not null and l.commercial_owner_user_id=x.uid and x.eligible and(x.role is not null or x.platform)
 and not coalesce((x.pipeline_ids is not null and not(l.pipeline_id=any(x.pipeline_ids))) or(x.channel_ids is not null and not(c.channel_session_id=any(x.channel_ids))),false)
 and exists(select 1 from public.commercial_routing_rules r where r.organization_id=c.organization_id and r.channel_id=c.channel_session_id)),
conversations as materialized(select c.id,c.organization_id,c.contact_id from public.conversations c join ctx x on x.org=c.organization_id

 where (x.platform or(x.role is not null and(not x.scoped or x.channel_ids is null or c.channel_session_id=any(x.channel_ids)))) and ((x.platform or case when x.role is null then false when x.role in('viewer','manager','admin') then true when c.assigned_to_user_id=x.uid then true when x.visibility='all' then true when x.visibility='own_and_unassigned' then c.assigned_to_user_id is null else false end)
 or exists(select 1 from commercial cm where cm.organization_id=c.organization_id and cm.id=c.id))),
contacts as materialized(select c.id,c.organization_id from public.contacts c join ctx x on x.org=c.organization_id where x.platform or(x.role is not null and(
 not x.scoped or not x.restrict_contacts
 or exists(select 1 from leads l where l.organization_id=c.organization_id and l.contact_id=c.id)
 or exists(select 1 from conversations cv where cv.organization_id=c.organization_id and cv.contact_id=c.id)
 or(c.created_by_user_id=x.uid and not exists(select 1 from public.crm_leads l where l.organization_id=c.organization_id and l.contact_id=c.id)
 and not exists(select 1 from public.conversations cv where cv.organization_id=c.organization_id and cv.contact_id=c.id))))),
bc_any as materialized(select distinct organization_id,lead_id from public.conversation_business_contexts where lead_id is not null),
bc_allowed as materialized(select distinct bc.organization_id,bc.lead_id from public.conversation_business_contexts bc join public.conversations c on c.organization_id=bc.organization_id and c.id=bc.conversation_id join ctx x on x.org=bc.organization_id where bc.lead_id is not null and(x.platform or(x.role is not null and(not x.scoped or x.channel_ids is null or c.channel_session_id=any(x.channel_ids)))))
select jsonb_build_object('uid',a.uid,'platform',a.platform,'orgs',coalesce((select jsonb_object_agg(x.org::text,jsonb_build_object(
 'role',x.role,'scoped',x.scoped,'private',x.private,'visibility',x.visibility,'restrict_contacts',x.restrict_contacts,'channels',x.channel_ids,'pipelines',x.pipeline_ids,
 'contacts',coalesce((select jsonb_object_agg(z.id::text,true)from contacts z where z.organization_id=x.org),'{}'::jsonb),
 'conversations',coalesce((select jsonb_object_agg(z.id::text,true)from conversations z where z.organization_id=x.org),'{}'::jsonb),
 'commercial_conversations',coalesce((select jsonb_object_agg(z.id::text,true)from commercial z where z.organization_id=x.org),'{}'::jsonb),
 'leads',coalesce((select jsonb_object_agg(z.id::text,true)from leads z where z.organization_id=x.org),'{}'::jsonb),
 'bc_any',coalesce((select jsonb_object_agg(z.lead_id::text,true)from bc_any z where z.organization_id=x.org),'{}'::jsonb),
 'bc_allowed',coalesce((select jsonb_object_agg(z.lead_id::text,true)from bc_allowed z where z.organization_id=x.org),'{}'::jsonb)
))from ctx x),'{}'::jsonb))from actor a;
$context$;

-- Pure evaluator: no DB/auth/current_setting reads; policy supplies the fixed InitPlan context.
create or replace function scoped_acl_row_private.row_allowed(
 p_context jsonb,p_gate text,p_org uuid,p_id uuid,
 p_owner uuid default null,p_commercial uuid default null,p_pipeline uuid default null,p_channel uuid default null)
returns boolean language sql immutable security invoker set search_path=pg_catalog as $eval$
with raw as (select p_context->'orgs'->p_org::text x,(p_context->>'uid')::uuid uid,(p_context->>'platform')::boolean platform),
facts as(select x,uid,platform,x->>'role' role,
 case when x is null then false else(x->>'scoped')::boolean end scoped,
 coalesce((x->>'private')::boolean,false) private,
 coalesce(x->>'visibility','own_and_unassigned') visibility from raw),
checks as(select *,
 (platform or(role is not null and(not scoped or x->'channels'='null'::jsonb or x->'channels' is null or(x->'channels')?p_channel::text))) channel_allowed,
 (platform or(role is not null and(not scoped or x->'pipelines'='null'::jsonb or x->'pipelines' is null or(x->'pipelines')?p_pipeline::text))) pipeline_allowed,
 (case when platform then true when role is null then false when role in('viewer','manager','admin')then true when p_owner=uid then true when visibility='all'then true when visibility='own_and_unassigned'then p_owner is null else false end)view_allowed
 from facts)
select coalesce(case p_gate
 when 'contact' then platform or(role is not null and(not scoped or not(x->>'restrict_contacts')::boolean or(x->'contacts')?p_id::text))
 when 'channel' then channel_allowed
 when 'conversation_channel' then channel_allowed
 when 'conversation_scoped' then not scoped or(x->'conversations')?p_id::text
 when 'commercial_conversation' then(x->'commercial_conversations')?p_id::text
 when 'lead_view' then view_allowed
 when 'commercial_lead' then p_commercial=uid and(x->'leads')?p_id::text
 when 'lead_pipeline' then pipeline_allowed
 when 'lead_acl' then
 (case when not platform and private and role='agent'and p_commercial is not null then p_commercial=uid else view_allowed or(p_commercial=uid and role in('agent','manager','admin'))end)
 and pipeline_allowed
 and(not scoped or not coalesce((x->'bc_any')?p_id::text,false)or(x->'bc_allowed')?p_id::text)
 else false end,false)from checks;
$eval$;
revoke all on function scoped_acl_row_private.statement_context()from public,anon,service_role;
revoke all on function scoped_acl_row_private.row_allowed(jsonb,text,uuid,uuid,uuid,uuid,uuid,uuid)from public,anon,service_role;
grant execute on function scoped_acl_row_private.statement_context()to authenticated;
grant execute on function scoped_acl_row_private.row_allowed(jsonb,text,uuid,uuid,uuid,uuid,uuid,uuid)to authenticated;
alter policy acl_contacts_read on public.contacts using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context()),'contact',organization_id,id));
alter policy acl_conversations on public.conversations using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context()),'conversation_channel',organization_id,id,null,null,null,channel_session_id));
alter policy scoped_participacao_preserva_carteira on public.conversations using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context()),'conversation_scoped',organization_id,id));
alter policy commercial_conversation_read on public.conversations using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context()),'commercial_conversation',organization_id,id));
alter policy acl_lead_case_channel on public.crm_leads using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context()),'lead_acl',organization_id,id,owner_user_id,commercial_owner_user_id,pipeline_id));
alter policy commercial_lead_read on public.crm_leads using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context()),'commercial_lead',organization_id,id,null,commercial_owner_user_id));
alter policy crm_leads_select on public.crm_leads using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context()),'lead_view',organization_id,id,owner_user_id));
drop policy if exists acl_channels on public.channel_sessions;
drop policy if exists acl_channels_insert on public.channel_sessions;
drop policy if exists acl_channels_update on public.channel_sessions;
drop policy if exists acl_channels_delete on public.channel_sessions;
create policy acl_channels on public.channel_sessions as restrictive for select to authenticated using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context()),'channel',organization_id,id,null,null,null,id));
create policy acl_channels_insert on public.channel_sessions as restrictive for insert to authenticated with check(public.fn_acl_channel(organization_id,id));
create policy acl_channels_update on public.channel_sessions as restrictive for update to authenticated using(public.fn_acl_channel(organization_id,id))with check(public.fn_acl_channel(organization_id,id));
create policy acl_channels_delete on public.channel_sessions as restrictive for delete to authenticated using(public.fn_acl_channel(organization_id,id));
drop policy if exists acl_leads on public.crm_leads;
drop policy if exists acl_leads_insert on public.crm_leads;
drop policy if exists acl_leads_update on public.crm_leads;
drop policy if exists acl_leads_delete on public.crm_leads;
create policy acl_leads on public.crm_leads as restrictive for select to authenticated using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context()),'lead_pipeline',organization_id,id,null,null,pipeline_id));
create policy acl_leads_insert on public.crm_leads as restrictive for insert to authenticated with check(public.fn_acl_pipeline(organization_id,pipeline_id));
create policy acl_leads_update on public.crm_leads as restrictive for update to authenticated using(public.fn_acl_pipeline(organization_id,pipeline_id))with check(public.fn_acl_pipeline(organization_id,pipeline_id));
create policy acl_leads_delete on public.crm_leads as restrictive for delete to authenticated using(public.fn_acl_pipeline(organization_id,pipeline_id));


-- contrato preservado: 9035
-- manifest: Planeja apenas o conjunto ACL usado pelo gate e preserva atributos NEW/RETURNING sem cache persistente.
-- LOCAL overlay; STABLE uses the calling statement snapshot for every branch.
create or replace function scoped_acl_row_private.statement_context(p_gate text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $gate$
begin
case p_gate
when 'contact' then return (with actor as materialized(select auth.uid() uid, public.fn_is_platform_admin() platform),
roles as materialized(select o.id org,o.settings,a.uid,a.platform,public.fn_user_role_in_org(o.id) role,
 exists(select 1 from public.organization_data_boundaries d where d.organization_id=o.id) private
 from public.organizations o cross join actor a),
ctx as materialized(select r.*,s.channel_ids,s.pipeline_ids,coalesce(s.restrict_contacts,false) restrict_contacts,
 (r.role='agent' and s.user_id is not null) scoped,
 coalesce(r.settings->>'visibility_mode','own_and_unassigned') visibility,
 exists(select 1 from public.user_organizations m where m.organization_id=r.org and m.user_id=r.uid and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')) eligible
 from roles r left join public.member_access_scopes s on s.organization_id=r.org and s.user_id=r.uid),
lead_base as materialized(select l.*,x.uid,x.platform,x.role,x.private,x.scoped,x.channel_ids,x.pipeline_ids,x.visibility,
 (x.platform or case when x.role is null then false when x.role in('viewer','manager','admin') then true when l.owner_user_id=x.uid then true when x.visibility='all' then true when x.visibility='own_and_unassigned' then l.owner_user_id is null else false end) view_allowed
 from public.crm_leads l join ctx x on x.org=l.organization_id),
leads as materialized(select l.id,l.organization_id,l.contact_id from lead_base l where
 (case when not l.platform and l.private and l.role='agent' and l.commercial_owner_user_id is not null then l.commercial_owner_user_id=l.uid
 else l.view_allowed or(l.commercial_owner_user_id=l.uid and l.role in('agent','manager','admin')) end)
 and(l.platform or(l.role is not null and(not l.scoped or l.pipeline_ids is null or l.pipeline_id=any(l.pipeline_ids))))
 and(not l.scoped or not exists(select 1 from public.conversation_business_contexts bc where bc.organization_id=l.organization_id and bc.lead_id=l.id)
 or exists(select 1 from public.conversation_business_contexts bc join public.conversations c on c.organization_id=bc.organization_id and c.id=bc.conversation_id where bc.organization_id=l.organization_id and bc.lead_id=l.id and(l.platform or(l.role is not null and(not l.scoped or l.channel_ids is null or c.channel_session_id=any(l.channel_ids))))))),
commercial as materialized(select distinct c.id,c.organization_id from public.conversations c join ctx x on x.org=c.organization_id
 join public.conversation_business_contexts bc on bc.organization_id=c.organization_id and bc.conversation_id=c.id and bc.service_revision=c.service_revision and bc.status='assigned'
 join public.crm_leads l on l.organization_id=bc.organization_id and l.id=bc.lead_id
 where x.uid is not null and l.commercial_owner_user_id=x.uid and x.eligible and(x.role is not null or x.platform)
 and not coalesce((x.pipeline_ids is not null and not(l.pipeline_id=any(x.pipeline_ids))) or(x.channel_ids is not null and not(c.channel_session_id=any(x.channel_ids))),false)
 and exists(select 1 from public.commercial_routing_rules r where r.organization_id=c.organization_id and r.channel_id=c.channel_session_id)),
conversations as materialized(select c.id,c.organization_id,c.contact_id from public.conversations c join ctx x on x.org=c.organization_id

 where (x.platform or(x.role is not null and(not x.scoped or x.channel_ids is null or c.channel_session_id=any(x.channel_ids)))) and ((x.platform or case when x.role is null then false when x.role in('viewer','manager','admin') then true when c.assigned_to_user_id=x.uid then true when x.visibility='all' then true when x.visibility='own_and_unassigned' then c.assigned_to_user_id is null else false end)
 or exists(select 1 from commercial cm where cm.organization_id=c.organization_id and cm.id=c.id))),
contacts as materialized(select c.id,c.organization_id from public.contacts c join ctx x on x.org=c.organization_id where x.platform or(x.role is not null and(
 not x.scoped or not x.restrict_contacts
 or exists(select 1 from leads l where l.organization_id=c.organization_id and l.contact_id=c.id)
 or exists(select 1 from conversations cv where cv.organization_id=c.organization_id and cv.contact_id=c.id)
 or(c.created_by_user_id=x.uid and not exists(select 1 from public.crm_leads l where l.organization_id=c.organization_id and l.contact_id=c.id)
 and not exists(select 1 from public.conversations cv where cv.organization_id=c.organization_id and cv.contact_id=c.id)))))
select jsonb_build_object('uid',a.uid,'platform',a.platform,'orgs',coalesce((select jsonb_object_agg(x.org::text,jsonb_build_object(
 'role',x.role,'scoped',x.scoped,'private',x.private,'visibility',x.visibility,'restrict_contacts',x.restrict_contacts,'channels',x.channel_ids,'pipelines',x.pipeline_ids,
 'contacts',coalesce((select jsonb_object_agg(z.id::text,true)from contacts z where z.organization_id=x.org),'{}'::jsonb),
 'conversations','{}'::jsonb,
 'commercial_conversations','{}'::jsonb,
 'leads','{}'::jsonb,
 'bc_any','{}'::jsonb,
 'bc_allowed','{}'::jsonb
))from ctx x),'{}'::jsonb))from actor a);
when 'channel' then return (with actor as materialized(select auth.uid() uid, public.fn_is_platform_admin() platform),
roles as materialized(select o.id org,o.settings,a.uid,a.platform,public.fn_user_role_in_org(o.id) role,
 exists(select 1 from public.organization_data_boundaries d where d.organization_id=o.id) private
 from public.organizations o cross join actor a),
ctx as materialized(select r.*,s.channel_ids,s.pipeline_ids,coalesce(s.restrict_contacts,false) restrict_contacts,
 (r.role='agent' and s.user_id is not null) scoped,
 coalesce(r.settings->>'visibility_mode','own_and_unassigned') visibility,
 exists(select 1 from public.user_organizations m where m.organization_id=r.org and m.user_id=r.uid and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')) eligible
 from roles r left join public.member_access_scopes s on s.organization_id=r.org and s.user_id=r.uid)
select jsonb_build_object('uid',a.uid,'platform',a.platform,'orgs',coalesce((select jsonb_object_agg(x.org::text,jsonb_build_object(
 'role',x.role,'scoped',x.scoped,'private',x.private,'visibility',x.visibility,'restrict_contacts',x.restrict_contacts,'channels',x.channel_ids,'pipelines',x.pipeline_ids,
 'contacts','{}'::jsonb,
 'conversations','{}'::jsonb,
 'commercial_conversations','{}'::jsonb,
 'leads','{}'::jsonb,
 'bc_any','{}'::jsonb,
 'bc_allowed','{}'::jsonb
))from ctx x),'{}'::jsonb))from actor a);
when 'conversation_channel' then return (with actor as materialized(select auth.uid() uid, public.fn_is_platform_admin() platform),
roles as materialized(select o.id org,o.settings,a.uid,a.platform,public.fn_user_role_in_org(o.id) role,
 exists(select 1 from public.organization_data_boundaries d where d.organization_id=o.id) private
 from public.organizations o cross join actor a),
ctx as materialized(select r.*,s.channel_ids,s.pipeline_ids,coalesce(s.restrict_contacts,false) restrict_contacts,
 (r.role='agent' and s.user_id is not null) scoped,
 coalesce(r.settings->>'visibility_mode','own_and_unassigned') visibility,
 exists(select 1 from public.user_organizations m where m.organization_id=r.org and m.user_id=r.uid and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')) eligible
 from roles r left join public.member_access_scopes s on s.organization_id=r.org and s.user_id=r.uid)
select jsonb_build_object('uid',a.uid,'platform',a.platform,'orgs',coalesce((select jsonb_object_agg(x.org::text,jsonb_build_object(
 'role',x.role,'scoped',x.scoped,'private',x.private,'visibility',x.visibility,'restrict_contacts',x.restrict_contacts,'channels',x.channel_ids,'pipelines',x.pipeline_ids,
 'contacts','{}'::jsonb,
 'conversations','{}'::jsonb,
 'commercial_conversations','{}'::jsonb,
 'leads','{}'::jsonb,
 'bc_any','{}'::jsonb,
 'bc_allowed','{}'::jsonb
))from ctx x),'{}'::jsonb))from actor a);
when 'conversation_scoped' then return (with actor as materialized(select auth.uid() uid, public.fn_is_platform_admin() platform),
roles as materialized(select o.id org,o.settings,a.uid,a.platform,public.fn_user_role_in_org(o.id) role,
 exists(select 1 from public.organization_data_boundaries d where d.organization_id=o.id) private
 from public.organizations o cross join actor a),
ctx as materialized(select r.*,s.channel_ids,s.pipeline_ids,coalesce(s.restrict_contacts,false) restrict_contacts,
 (r.role='agent' and s.user_id is not null) scoped,
 coalesce(r.settings->>'visibility_mode','own_and_unassigned') visibility,
 exists(select 1 from public.user_organizations m where m.organization_id=r.org and m.user_id=r.uid and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')) eligible
 from roles r left join public.member_access_scopes s on s.organization_id=r.org and s.user_id=r.uid),
commercial as materialized(select distinct c.id,c.organization_id from public.conversations c join ctx x on x.org=c.organization_id
 join public.conversation_business_contexts bc on bc.organization_id=c.organization_id and bc.conversation_id=c.id and bc.service_revision=c.service_revision and bc.status='assigned'
 join public.crm_leads l on l.organization_id=bc.organization_id and l.id=bc.lead_id
 where x.uid is not null and l.commercial_owner_user_id=x.uid and x.eligible and(x.role is not null or x.platform)
 and not coalesce((x.pipeline_ids is not null and not(l.pipeline_id=any(x.pipeline_ids))) or(x.channel_ids is not null and not(c.channel_session_id=any(x.channel_ids))),false)
 and exists(select 1 from public.commercial_routing_rules r where r.organization_id=c.organization_id and r.channel_id=c.channel_session_id)),
conversations as materialized(select c.id,c.organization_id,c.contact_id from public.conversations c join ctx x on x.org=c.organization_id

 where (x.platform or(x.role is not null and(not x.scoped or x.channel_ids is null or c.channel_session_id=any(x.channel_ids)))) and ((x.platform or case when x.role is null then false when x.role in('viewer','manager','admin') then true when c.assigned_to_user_id=x.uid then true when x.visibility='all' then true when x.visibility='own_and_unassigned' then c.assigned_to_user_id is null else false end)
 or exists(select 1 from commercial cm where cm.organization_id=c.organization_id and cm.id=c.id)))
select jsonb_build_object('uid',a.uid,'platform',a.platform,'orgs',coalesce((select jsonb_object_agg(x.org::text,jsonb_build_object(
 'role',x.role,'scoped',x.scoped,'private',x.private,'visibility',x.visibility,'restrict_contacts',x.restrict_contacts,'channels',x.channel_ids,'pipelines',x.pipeline_ids,
 'contacts','{}'::jsonb,
 'conversations',coalesce((select jsonb_object_agg(z.id::text,true)from conversations z where z.organization_id=x.org),'{}'::jsonb),
 'commercial_conversations','{}'::jsonb,
 'leads','{}'::jsonb,
 'bc_any','{}'::jsonb,
 'bc_allowed','{}'::jsonb
))from ctx x),'{}'::jsonb))from actor a);
when 'commercial_conversation' then return (with actor as materialized(select auth.uid() uid, public.fn_is_platform_admin() platform),
roles as materialized(select o.id org,o.settings,a.uid,a.platform,public.fn_user_role_in_org(o.id) role,
 exists(select 1 from public.organization_data_boundaries d where d.organization_id=o.id) private
 from public.organizations o cross join actor a),
ctx as materialized(select r.*,s.channel_ids,s.pipeline_ids,coalesce(s.restrict_contacts,false) restrict_contacts,
 (r.role='agent' and s.user_id is not null) scoped,
 coalesce(r.settings->>'visibility_mode','own_and_unassigned') visibility,
 exists(select 1 from public.user_organizations m where m.organization_id=r.org and m.user_id=r.uid and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')) eligible
 from roles r left join public.member_access_scopes s on s.organization_id=r.org and s.user_id=r.uid),
commercial as materialized(select distinct c.id,c.organization_id from public.conversations c join ctx x on x.org=c.organization_id
 join public.conversation_business_contexts bc on bc.organization_id=c.organization_id and bc.conversation_id=c.id and bc.service_revision=c.service_revision and bc.status='assigned'
 join public.crm_leads l on l.organization_id=bc.organization_id and l.id=bc.lead_id
 where x.uid is not null and l.commercial_owner_user_id=x.uid and x.eligible and(x.role is not null or x.platform)
 and not coalesce((x.pipeline_ids is not null and not(l.pipeline_id=any(x.pipeline_ids))) or(x.channel_ids is not null and not(c.channel_session_id=any(x.channel_ids))),false)
 and exists(select 1 from public.commercial_routing_rules r where r.organization_id=c.organization_id and r.channel_id=c.channel_session_id))
select jsonb_build_object('uid',a.uid,'platform',a.platform,'orgs',coalesce((select jsonb_object_agg(x.org::text,jsonb_build_object(
 'role',x.role,'scoped',x.scoped,'private',x.private,'visibility',x.visibility,'restrict_contacts',x.restrict_contacts,'channels',x.channel_ids,'pipelines',x.pipeline_ids,
 'contacts','{}'::jsonb,
 'conversations','{}'::jsonb,
 'commercial_conversations',coalesce((select jsonb_object_agg(z.id::text,true)from commercial z where z.organization_id=x.org),'{}'::jsonb),
 'leads','{}'::jsonb,
 'bc_any','{}'::jsonb,
 'bc_allowed','{}'::jsonb
))from ctx x),'{}'::jsonb))from actor a);
when 'lead_view' then return (with actor as materialized(select auth.uid() uid, public.fn_is_platform_admin() platform),
roles as materialized(select o.id org,o.settings,a.uid,a.platform,public.fn_user_role_in_org(o.id) role,
 exists(select 1 from public.organization_data_boundaries d where d.organization_id=o.id) private
 from public.organizations o cross join actor a),
ctx as materialized(select r.*,s.channel_ids,s.pipeline_ids,coalesce(s.restrict_contacts,false) restrict_contacts,
 (r.role='agent' and s.user_id is not null) scoped,
 coalesce(r.settings->>'visibility_mode','own_and_unassigned') visibility,
 exists(select 1 from public.user_organizations m where m.organization_id=r.org and m.user_id=r.uid and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')) eligible
 from roles r left join public.member_access_scopes s on s.organization_id=r.org and s.user_id=r.uid)
select jsonb_build_object('uid',a.uid,'platform',a.platform,'orgs',coalesce((select jsonb_object_agg(x.org::text,jsonb_build_object(
 'role',x.role,'scoped',x.scoped,'private',x.private,'visibility',x.visibility,'restrict_contacts',x.restrict_contacts,'channels',x.channel_ids,'pipelines',x.pipeline_ids,
 'contacts','{}'::jsonb,
 'conversations','{}'::jsonb,
 'commercial_conversations','{}'::jsonb,
 'leads','{}'::jsonb,
 'bc_any','{}'::jsonb,
 'bc_allowed','{}'::jsonb
))from ctx x),'{}'::jsonb))from actor a);
when 'commercial_lead' then return (with actor as materialized(select auth.uid() uid, public.fn_is_platform_admin() platform),
roles as materialized(select o.id org,o.settings,a.uid,a.platform,public.fn_user_role_in_org(o.id) role,
 exists(select 1 from public.organization_data_boundaries d where d.organization_id=o.id) private
 from public.organizations o cross join actor a),
ctx as materialized(select r.*,s.channel_ids,s.pipeline_ids,coalesce(s.restrict_contacts,false) restrict_contacts,
 (r.role='agent' and s.user_id is not null) scoped,
 coalesce(r.settings->>'visibility_mode','own_and_unassigned') visibility,
 exists(select 1 from public.user_organizations m where m.organization_id=r.org and m.user_id=r.uid and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')) eligible
 from roles r left join public.member_access_scopes s on s.organization_id=r.org and s.user_id=r.uid),
lead_base as materialized(select l.*,x.uid,x.platform,x.role,x.private,x.scoped,x.channel_ids,x.pipeline_ids,x.visibility,
 (x.platform or case when x.role is null then false when x.role in('viewer','manager','admin') then true when l.owner_user_id=x.uid then true when x.visibility='all' then true when x.visibility='own_and_unassigned' then l.owner_user_id is null else false end) view_allowed
 from public.crm_leads l join ctx x on x.org=l.organization_id),
leads as materialized(select l.id,l.organization_id,l.contact_id from lead_base l where
 (case when not l.platform and l.private and l.role='agent' and l.commercial_owner_user_id is not null then l.commercial_owner_user_id=l.uid
 else l.view_allowed or(l.commercial_owner_user_id=l.uid and l.role in('agent','manager','admin')) end)
 and(l.platform or(l.role is not null and(not l.scoped or l.pipeline_ids is null or l.pipeline_id=any(l.pipeline_ids))))
 and(not l.scoped or not exists(select 1 from public.conversation_business_contexts bc where bc.organization_id=l.organization_id and bc.lead_id=l.id)
 or exists(select 1 from public.conversation_business_contexts bc join public.conversations c on c.organization_id=bc.organization_id and c.id=bc.conversation_id where bc.organization_id=l.organization_id and bc.lead_id=l.id and(l.platform or(l.role is not null and(not l.scoped or l.channel_ids is null or c.channel_session_id=any(l.channel_ids)))))))
select jsonb_build_object('uid',a.uid,'platform',a.platform,'orgs',coalesce((select jsonb_object_agg(x.org::text,jsonb_build_object(
 'role',x.role,'scoped',x.scoped,'private',x.private,'visibility',x.visibility,'restrict_contacts',x.restrict_contacts,'channels',x.channel_ids,'pipelines',x.pipeline_ids,
 'contacts','{}'::jsonb,
 'conversations','{}'::jsonb,
 'commercial_conversations','{}'::jsonb,
 'leads',coalesce((select jsonb_object_agg(z.id::text,true)from leads z where z.organization_id=x.org),'{}'::jsonb),
 'bc_any','{}'::jsonb,
 'bc_allowed','{}'::jsonb
))from ctx x),'{}'::jsonb))from actor a);
when 'lead_pipeline' then return (with actor as materialized(select auth.uid() uid, public.fn_is_platform_admin() platform),
roles as materialized(select o.id org,o.settings,a.uid,a.platform,public.fn_user_role_in_org(o.id) role,
 exists(select 1 from public.organization_data_boundaries d where d.organization_id=o.id) private
 from public.organizations o cross join actor a),
ctx as materialized(select r.*,s.channel_ids,s.pipeline_ids,coalesce(s.restrict_contacts,false) restrict_contacts,
 (r.role='agent' and s.user_id is not null) scoped,
 coalesce(r.settings->>'visibility_mode','own_and_unassigned') visibility,
 exists(select 1 from public.user_organizations m where m.organization_id=r.org and m.user_id=r.uid and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')) eligible
 from roles r left join public.member_access_scopes s on s.organization_id=r.org and s.user_id=r.uid)
select jsonb_build_object('uid',a.uid,'platform',a.platform,'orgs',coalesce((select jsonb_object_agg(x.org::text,jsonb_build_object(
 'role',x.role,'scoped',x.scoped,'private',x.private,'visibility',x.visibility,'restrict_contacts',x.restrict_contacts,'channels',x.channel_ids,'pipelines',x.pipeline_ids,
 'contacts','{}'::jsonb,
 'conversations','{}'::jsonb,
 'commercial_conversations','{}'::jsonb,
 'leads','{}'::jsonb,
 'bc_any','{}'::jsonb,
 'bc_allowed','{}'::jsonb
))from ctx x),'{}'::jsonb))from actor a);
when 'lead_acl' then return (with actor as materialized(select auth.uid() uid, public.fn_is_platform_admin() platform),
roles as materialized(select o.id org,o.settings,a.uid,a.platform,public.fn_user_role_in_org(o.id) role,
 exists(select 1 from public.organization_data_boundaries d where d.organization_id=o.id) private
 from public.organizations o cross join actor a),
ctx as materialized(select r.*,s.channel_ids,s.pipeline_ids,coalesce(s.restrict_contacts,false) restrict_contacts,
 (r.role='agent' and s.user_id is not null) scoped,
 coalesce(r.settings->>'visibility_mode','own_and_unassigned') visibility,
 exists(select 1 from public.user_organizations m where m.organization_id=r.org and m.user_id=r.uid and m.accepted_at is not null and m.revoked_at is null and m.role in('agent','manager','admin')) eligible
 from roles r left join public.member_access_scopes s on s.organization_id=r.org and s.user_id=r.uid),
bc_any as materialized(select distinct organization_id,lead_id from public.conversation_business_contexts where lead_id is not null),
bc_allowed as materialized(select distinct bc.organization_id,bc.lead_id from public.conversation_business_contexts bc join public.conversations c on c.organization_id=bc.organization_id and c.id=bc.conversation_id join ctx x on x.org=bc.organization_id where bc.lead_id is not null and(x.platform or(x.role is not null and(not x.scoped or x.channel_ids is null or c.channel_session_id=any(x.channel_ids)))))
select jsonb_build_object('uid',a.uid,'platform',a.platform,'orgs',coalesce((select jsonb_object_agg(x.org::text,jsonb_build_object(
 'role',x.role,'scoped',x.scoped,'private',x.private,'visibility',x.visibility,'restrict_contacts',x.restrict_contacts,'channels',x.channel_ids,'pipelines',x.pipeline_ids,
 'contacts','{}'::jsonb,
 'conversations','{}'::jsonb,
 'commercial_conversations','{}'::jsonb,
 'leads','{}'::jsonb,
 'bc_any',coalesce((select jsonb_object_agg(z.lead_id::text,true)from bc_any z where z.organization_id=x.org),'{}'::jsonb),
 'bc_allowed',coalesce((select jsonb_object_agg(z.lead_id::text,true)from bc_allowed z where z.organization_id=x.org),'{}'::jsonb)
))from ctx x),'{}'::jsonb))from actor a);
else return jsonb_build_object('uid',null,'platform',false,'orgs','{}'::jsonb);
end case;
end;
$gate$;
revoke all on function scoped_acl_row_private.statement_context(text) from public,anon,service_role;
grant execute on function scoped_acl_row_private.statement_context(text) to authenticated;
alter policy acl_contacts_read on public.contacts using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context('contact')),'contact',organization_id,id));
alter policy acl_conversations on public.conversations using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context('conversation_channel')),'conversation_channel',organization_id,id,null,null,null,channel_session_id));
alter policy scoped_participacao_preserva_carteira on public.conversations using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context('conversation_scoped')),'conversation_scoped',organization_id,id));
alter policy commercial_conversation_read on public.conversations using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context('commercial_conversation')),'commercial_conversation',organization_id,id));
alter policy acl_lead_case_channel on public.crm_leads using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context('lead_acl')),'lead_acl',organization_id,id,owner_user_id,commercial_owner_user_id,pipeline_id));
alter policy commercial_lead_read on public.crm_leads using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context('commercial_lead')),'commercial_lead',organization_id,id,null,commercial_owner_user_id));
alter policy crm_leads_select on public.crm_leads using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context('lead_view')),'lead_view',organization_id,id,owner_user_id));
alter policy acl_channels on public.channel_sessions using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context('channel')),'channel',organization_id,id,null,null,null,id));
alter policy acl_leads on public.crm_leads using(scoped_acl_row_private.row_allowed((select scoped_acl_row_private.statement_context('lead_pipeline')),'lead_pipeline',organization_id,id,null,null,pipeline_id));


-- contrato preservado: 0904
-- manifest: Exclusões Realtime invalidam consultas sem expor UUIDs fora da RLS.
-- Transporte CDC global: exige app e baseline juntos. Não habilita ACL, IA,
-- distribuição ou qualquer configuração de organização. Nenhum dado de entidade
-- apagada é copiado. Há no máximo uma linha por organização/tabela, sem outbox
-- crescente ou worker. O sinal revela apenas atividade da tabela no próprio tenant.

create table if not exists public.realtime_invalidations (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 table_name text not null,
 change_token uuid not null default gen_random_uuid(),
 primary key(organization_id,table_name)
);
alter table public.realtime_invalidations enable row level security;
revoke all on public.realtime_invalidations from public,anon,authenticated,service_role;
grant select on public.realtime_invalidations to authenticated,service_role;
drop policy if exists realtime_invalidations_read on public.realtime_invalidations;
create policy realtime_invalidations_read on public.realtime_invalidations for select to authenticated
 using(public.fn_is_platform_admin() or organization_id in(select public.fn_user_org_ids()));

create or replace function public.fn_realtime_invalidate_deleted() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_op='DELETE' then
  insert into public.realtime_invalidations(organization_id,table_name,change_token)
   select distinct d.organization_id,tg_table_name,gen_random_uuid()
   from (select distinct organization_id from deleted_rows) d
   -- A exclusão em cascata de uma organização não deve recriá-la por FK.
   where exists(select 1 from public.organizations o where o.id=d.organization_id)
   on conflict(organization_id,table_name) do update set change_token=excluded.change_token;
 elsif tg_op='TRUNCATE' then
  execute format('insert into public.realtime_invalidations(organization_id,table_name,change_token)
   select organization_id,%L,gen_random_uuid() from (select distinct organization_id from public.%I) d
   where exists(select 1 from public.organizations o where o.id=d.organization_id)
   on conflict(organization_id,table_name) do update set change_token=excluded.change_token',tg_table_name,tg_table_name);
 end if;
 return null;
end $$;
revoke execute on function public.fn_realtime_invalidate_deleted() from public,anon,authenticated,service_role;

-- O baseline legado pode continuar após um erro SQL. Não permitir ativar ou
-- editar o isolamento se a configuração CDC efetivamente aplicada for insegura.
create or replace function public.fn_realtime_privacy_ready() returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from pg_publication p where p.pubname='supabase_realtime'
  and p.pubinsert and p.pubupdate and not p.pubdelete and not p.pubtruncate)
 and exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
  and schemaname='public' and tablename='realtime_invalidations')
 and not exists(select 1 from pg_publication p join pg_publication_tables pt on pt.pubname=p.pubname
  join information_schema.columns c on c.table_schema=pt.schemaname and c.table_name=pt.tablename and c.column_name='organization_id'
  where pt.schemaname='public' and (p.pubdelete or p.pubtruncate));
$$;
revoke execute on function public.fn_realtime_privacy_ready() from public,anon;
grant execute on function public.fn_realtime_privacy_ready() to authenticated,service_role;
create or replace function public.fn_guard_realtime_privacy_activation() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not public.fn_realtime_privacy_ready() then
  raise exception 'realtime_privacy_not_ready' using errcode='55000';
 end if;
 return new;
end $$;
revoke execute on function public.fn_guard_realtime_privacy_activation() from public,anon,authenticated,service_role;
drop trigger if exists realtime_privacy_activation on public.member_access_scopes;
create trigger realtime_privacy_activation before insert or update on public.member_access_scopes
 for each row execute function public.fn_guard_realtime_privacy_activation();
drop trigger if exists realtime_privacy_activation on public.organization_data_boundaries;
create trigger realtime_privacy_activation before insert or update on public.organization_data_boundaries
 for each row execute function public.fn_guard_realtime_privacy_activation();

do $realtime$ declare t record;
begin
 -- Falha fechada: não alterar publications de integrações desconhecidas nem
 -- aprovar o isolamento se outro feed ainda publicar DELETE de dados tenant.
 if exists(select 1 from pg_publication p join pg_publication_tables pt on pt.pubname=p.pubname
   join information_schema.columns c on c.table_schema=pt.schemaname and c.table_name=pt.tablename and c.column_name='organization_id'
   where p.pubname<>'supabase_realtime' and pt.schemaname='public' and (p.pubdelete or p.pubtruncate)) then
  raise exception 'realtime_unsafe_alternate_publication';
 end if;
 if not exists(select 1 from pg_publication where pubname='supabase_realtime' and pubinsert and pubupdate) then
  raise exception 'realtime_requires_insert_update_publication';
 end if;
 -- DELETE não pode ser autorizado por linha pelo Realtime oficial. Os INSERTs
 -- e UPDATEs permanecem nativos; o mecanismo de broadcast não é alterado.
 alter publication supabase_realtime set(publish='insert,update');
 for t in select pt.tablename from pg_publication_tables pt
  join information_schema.columns c on c.table_schema=pt.schemaname and c.table_name=pt.tablename and c.column_name='organization_id'
  where pt.pubname='supabase_realtime' and pt.schemaname='public' and pt.tablename<>'realtime_invalidations'
 loop
  execute format('drop trigger if exists realtime_deleted_invalidate on public.%I',t.tablename);
  execute format('create trigger realtime_deleted_invalidate after delete on public.%I referencing old table as deleted_rows for each statement execute function public.fn_realtime_invalidate_deleted()',t.tablename);
  execute format('drop trigger if exists realtime_truncated_invalidate on public.%I',t.tablename);
  execute format('create trigger realtime_truncated_invalidate before truncate on public.%I for each statement execute function public.fn_realtime_invalidate_deleted()',t.tablename);
 end loop;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='realtime_invalidations') then
  alter publication supabase_realtime add table public.realtime_invalidations;
 end if;
end $realtime$;
notify pgrst,'reload schema';

-- manifest: Garante invalidação de exclusões também nas tabelas publicadas por apêndices oficiais posteriores à0906, preservando CDC INSERT/UPDATE nativo e sem expor IDs de linhas apagadas.
do $scoped_delete_feeds$ declare t record;begin
 for t in select pt.tablename from pg_publication_tables pt
  join information_schema.columns c on c.table_schema=pt.schemaname and c.table_name=pt.tablename and c.column_name='organization_id'
  where pt.pubname='supabase_realtime' and pt.schemaname='public' and pt.tablename<>'realtime_invalidations'
 loop
  execute format('drop trigger if exists realtime_deleted_invalidate on public.%I',t.tablename);
  execute format('create trigger realtime_deleted_invalidate after delete on public.%I referencing old table as deleted_rows for each statement execute function public.fn_realtime_invalidate_deleted()',t.tablename);
  execute format('drop trigger if exists realtime_truncated_invalidate on public.%I',t.tablename);
  execute format('create trigger realtime_truncated_invalidate before truncate on public.%I for each statement execute function public.fn_realtime_invalidate_deleted()',t.tablename);
 end loop;
end $scoped_delete_feeds$;

DROP POLICY IF EXISTS tenant_isolation_member_access_scopes_all ON public.member_access_scopes;
CREATE POLICY tenant_isolation_member_access_scopes_all ON public.member_access_scopes AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids())) WITH CHECK (organization_id IN (SELECT public.fn_user_org_ids()));

DROP POLICY IF EXISTS tenant_isolation_organization_data_boundaries_all ON public.organization_data_boundaries;
CREATE POLICY tenant_isolation_organization_data_boundaries_all ON public.organization_data_boundaries AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids())) WITH CHECK (organization_id IN (SELECT public.fn_user_org_ids()));

DROP POLICY IF EXISTS tenant_isolation_contact_context_quarantine_all ON public.contact_context_quarantine;
CREATE POLICY tenant_isolation_contact_context_quarantine_all ON public.contact_context_quarantine AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids())) WITH CHECK (organization_id IN (SELECT public.fn_user_org_ids()));

DROP POLICY IF EXISTS tenant_isolation_commercial_source_bindings_all ON public.commercial_source_bindings;
CREATE POLICY tenant_isolation_commercial_source_bindings_all ON public.commercial_source_bindings AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids())) WITH CHECK (organization_id IN (SELECT public.fn_user_org_ids()));

DROP POLICY IF EXISTS tenant_isolation_commercial_source_receipts_all ON public.commercial_source_receipts;
CREATE POLICY tenant_isolation_commercial_source_receipts_all ON public.commercial_source_receipts AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids())) WITH CHECK (organization_id IN (SELECT public.fn_user_org_ids()));

-- A assinatura atual preserva p_source_job_id e continuidade entre números do produto.
create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false,
  p_source_job_id uuid default null
)
 RETURNS SETOF conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
  v_numero uuid;
  v_trocou_de_numero boolean := false;
  v_continua uuid;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  -- #3926 — `p_source_job_id` é do RUNTIME (o turno que está executando),
  -- nunca de uma sessão de pessoa: recusar em vez de ignorar, porque ignorar
  -- em silêncio deixaria a atribuição de uma pessoa passando com o turno
  -- revogado sem ninguém saber por quê.
  if p_source_job_id is not null and auth.uid() is not null then
    raise exception 'source_job_requires_runtime_caller'
      using hint = 'p_source_job_id is set by the agent runtime, never by a user session';
  end if;
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

  -- Conversa fora da visibilidade de quem chama responde como conversa
  -- inexistente (zero linhas). A regra fica no WHERE, com o dono da própria
  -- linha (reavaliado na versão nova se houver espera), nunca um valor do
  -- corpo. Service role (sem auth.uid) segue.
  --
  -- A EXCEÇÃO DA #3479: conversa SEM dono pode ser assumida por quem assume
  -- para si. Sem ela o modo "Só os seus" se morde: a conversa que nasceu do
  -- cadastro do contato tem dono nulo, o predicado do modo responde "não vejo"
  -- para dono nulo, e o claim — a operação que daria dono a ela — era recusado,
  -- com a tela dizendo "está com outro atendente" sobre uma conversa de
  -- ninguém. O termo se limita sozinho: exige dono nulo E dono novo =
  -- chamador, então conversa de colega (o caso que a 0685 protege), a
  -- transferência para terceiro e o release continuam respondendo zero linhas
  -- exatamente como antes.
  select * into v_conv
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
     and (
       auth.uid() is null
       or case when public.fn_acl_scoped(p_organization_id) or public.fn_contact_context_private(p_organization_id)
          then public.fn_acl_conversation(p_organization_id, p_conversation_id)
          else (public.fn_can_view_conversation(organization_id, assigned_to_user_id)
            or (assigned_to_user_id is null and p_to_user_id = auth.uid()
                and p_reason = 'claim' and p_enforce_expected)) end
     )
   for no key update;

  if not found then
    return;
  end if;

  v_from := v_conv.assigned_to_user_id;

  if auth.uid() is null and current_setting('role',true) in ('authenticated','anon') then
    raise exception 'unauthenticated' using errcode='42501';
  end if;
  if public.fn_acl_scoped(p_organization_id) and p_to_user_id=auth.uid() and exists(
    select 1 from public.contacts ct where ct.organization_id=p_organization_id and ct.id=v_conv.contact_id
      and ct.carteira_user_id is not null and ct.carteira_user_id<>auth.uid()) then
    raise exception 'contact_in_other_portfolio' using errcode='42501';
  end if;
  if p_to_user_id is not null and exists(select 1 from public.member_access_scopes s
    where s.organization_id=p_organization_id and s.user_id=p_to_user_id
      and s.channel_ids is not null and not(v_conv.channel_session_id=any(s.channel_ids))) then
    raise exception 'assignee_channel_forbidden' using errcode='42501';
  end if;
  if auth.uid() is not null and v_from is not null and v_from<>auth.uid()
    and not public.fn_can_view_conversation(p_organization_id,v_from) then return;end if;


  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  -- ─── #3642: o número segue o vendedor ──────────────────────────────────────
  -- Numa empresa com um número por vendedor (`channel_routing_policies` +
  -- `channel_routing_responsibles`), a troca de dono mudava só o dono: a
  -- conversa continuava no `channel_session_id` do vendedor ANTERIOR e o envio
  -- (que sai pela sessão da conversa) fazia o vendedor novo responder pelo
  -- WhatsApp do colega. Aqui a conversa passa para o número conectado do dono
  -- novo, na MESMA transação — e como esta é a porta única da atribuição, a
  -- regra vale para Transferir (um e em lote), Assumir, MCP, automação e a
  -- passagem de carteira sem nenhum deles precisar conhecê-la.
  --
  -- QUAL número é a `fn_numero_da_transferencia` — a mesma que o diálogo de
  -- Transferir consulta para avisar antes de confirmar, então o aviso e o efeito
  -- não divergem. Nulo = o número fica (número compartilhado, número sem dono,
  -- dono novo sem número conectado do mesmo canal, grupo, ou o contato já tem
  -- conversa no número novo). A transferência nunca falha por causa do número.
  v_numero := public.fn_numero_da_transferencia(p_organization_id, p_conversation_id, p_to_user_id);
  v_trocou_de_numero := v_numero is not null;
  if p_to_user_id is not null and exists(select 1 from public.member_access_scopes s
    where s.organization_id=p_organization_id and s.user_id=p_to_user_id
      and s.channel_ids is not null and not(coalesce(v_numero,v_conv.channel_session_id)=any(s.channel_ids))) then
    raise exception 'assignee_channel_forbidden' using errcode='42501';
  end if;


  -- ─── #3732: e quando o número NÃO pode seguir ──────────────────────────────
  -- O caso que a 9039 deixou em pé: o contato já tem conversa no número do dono
  -- novo, então o número fica, e a conversa ficava presa com o dono novo num
  -- número que não é dele (envio em 409, "transfira para você" — já feito).
  --
  -- A conversa que está NESSE número passa para o dono novo quando estava sem
  -- dono ou com o dono ANTERIOR: é a metade que faltava para ele ter onde
  -- responder. Conversa que já é de uma TERCEIRA pessoa não é tomada — quem a
  -- assumiu no meio continua com ela, e o aviso do envio diz o nome dele. A
  -- adoção passa por esta mesma função, então o evento da linha do tempo e o
  -- resto vão junto.
  if not v_trocou_de_numero and p_to_user_id is not null then
    select o.id into v_continua
      from public.conversations o
     where o.id = public.fn_conversa_que_continua(
             p_organization_id, p_conversation_id, p_to_user_id)
       and (o.assigned_to_user_id is null
            or o.assigned_to_user_id is not distinct from v_from)
       and o.assigned_to_user_id is distinct from p_to_user_id
       -- Doc 237, escolha 3-B: a conversa que a IA está atendendo fica com a
       -- IA. Sem esta condição, conversa sem dono e com a IA ativa era adotada
       -- e calada sem prazo (`bot_silenced_until = 'infinity'`), inclusive por
       -- tabela numa troca de carteira, que pula essa conversa de propósito.
       and public.comando_da_conversa(o) <> 'automatico';
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
         -- #3642: o número acompanha o dono, e a thread do provider ANTERIOR não
         -- viaja — ela pertence ao número antigo.
         channel_session_id = case when v_trocou_de_numero then v_numero
                                   else channel_session_id end,
         provider_conversation_id = case when v_trocou_de_numero then null
                                         else provider_conversation_id end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason, source_job_id)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason, p_source_job_id);

  -- #3732: a conversa que continua no número do dono novo vai junto (depois do
  -- evento da conversa transferida, para a linha do tempo contar na ordem).
  if v_continua is not null then
    perform public.fn_conversation_assign(
      p_organization_id, v_continua, p_to_user_id, 'transfer', null, false, p_source_job_id);
  end if;

  return next v_conv;
end;
$function$;

-- Configuração e recibos só são escritos pelas funções com seus gates, não por GRANT herdado.
revoke insert, update, delete, truncate on public.member_access_scopes from anon, authenticated;
revoke insert, update, delete, truncate on public.organization_data_boundaries from anon, authenticated;
revoke insert, update, delete, truncate on public.contact_context_quarantine from anon, authenticated;
revoke insert, update, delete, truncate on public.commercial_routing_rules from anon, authenticated;
revoke insert, update, delete, truncate on public.conversation_business_contexts from anon, authenticated;
revoke insert, update, delete, truncate on public.commercial_owner_events from anon, authenticated;
revoke insert, update, delete, truncate on public.commercial_source_bindings from anon, authenticated;
revoke insert, update, delete, truncate on public.commercial_source_receipts from anon, authenticated;
revoke insert, update, delete, truncate on public.realtime_invalidations from anon, authenticated;
