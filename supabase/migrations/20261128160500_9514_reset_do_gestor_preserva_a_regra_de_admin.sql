-- manifest: O reset feito por GESTOR deixa de apagar o que só admin configura (#5381, doc 430). `channel_routing_policies.has_manager_rule` (não nula, default true) diz se a linha carrega regra de gestor (responsáveis, `distribution_mode`, destino padrão): `fn_set_channel_routing` com `p_reset` de gestor vira UPDATE que zera essas três coisas, desmarca a linha e PRESERVA `ai_wait_minutes` e `sector_id`; o reset de admin segue apagando a linha inteira. `fn_channel_routing_claim` só recusa por lista de responsáveis quando a linha carrega regra de gestor — sem isso o número resetado ficaria com a linha órfã bloqueando todo mundo. Espelho no baseline no fim do arquivo, idempotente. Gate: tests/invariants/reset-do-gestor-preserva-a-regra-de-admin.test.ts.

alter table public.channel_routing_policies
  add column if not exists has_manager_rule boolean not null default true;

comment on column public.channel_routing_policies.has_manager_rule is
  'A linha carrega regra de GESTOR (responsáveis, distribution_mode e destino padrão)? false = só as colunas de admin (ai_wait_minutes, sector_id) sobreviveram ao reset do gestor (#5381).';

create or replace function public.fn_set_channel_routing(
  p_org uuid,p_channel uuid,p_users uuid[],p_reset boolean default false,
  p_mode text default null,p_default_assignee uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_policy_id uuid; v_mode text; requested_count integer; found_count integer; v_admin boolean;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'manager') or not public.fn_support_write_allowed(p_org)
 then raise exception 'routing_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'routing_mfa_required' using errcode='42501';end if;
 if p_users is null or cardinality(p_users)>1000 or array_position(p_users,null) is not null then
  raise exception 'routing_invalid_members' using errcode='22023';end if;
 if p_mode is not null and p_mode not in('manual','round_robin','load') then
  raise exception 'routing_invalid_mode' using errcode='22023';end if;
 -- Leitores de claim usam SHARE nesta identidade, inclusive na ausência de policy.
 perform 1 from public.channel_sessions where organization_id=p_org and id=p_channel and archived_at is null for update;
 if not found then raise exception 'routing_channel_not_found' using errcode='P0002';end if;
 -- (#5381) Quem reseta decide o ALCANCE do reset: admin apaga a regra inteira;
 -- gestor limpa só o que ele mesmo edita e deixa de pé o que é de admin.
 v_admin := public.fn_role_at_least(p_org,'admin') or public.fn_is_platform_admin_full();
 if p_reset then
  if v_admin then
   delete from public.channel_routing_policies where organization_id=p_org and channel_session_id=p_channel;
   v_mode:=null;
  else
   update public.channel_routing_policies
      set distribution_mode=null, default_assignee_user_id=null,
          has_manager_rule=false, updated_at=now()
    where organization_id=p_org and channel_session_id=p_channel
    returning id into v_policy_id;
   if v_policy_id is not null then
    delete from public.channel_routing_responsibles where organization_id=p_org and channel_routing_responsibles.policy_id=v_policy_id;
   end if;
   v_mode:=null;
  end if;
 else
  select count(distinct x) into requested_count from unnest(p_users) x;
  perform 1 from public.user_organizations where organization_id=p_org and user_id=any(p_users)
   and revoked_at is null and role in('agent','manager','admin') order by user_id for share;
  get diagnostics found_count=row_count;
  if found_count<>requested_count then raise exception 'routing_invalid_members' using errcode='22023';end if;
  -- O destino padrão passa pela MESMA régua dos responsáveis: membro ativo.
  if p_default_assignee is not null then
   perform 1 from public.user_organizations where organization_id=p_org and user_id=p_default_assignee
    and revoked_at is null and role in('agent','manager','admin') for share;
   if not found then raise exception 'routing_invalid_members' using errcode='22023';end if;
  end if;
  insert into public.channel_routing_policies(organization_id,channel_session_id,distribution_mode,default_assignee_user_id,has_manager_rule)
   values(p_org,p_channel,p_mode,p_default_assignee,true)
   on conflict(organization_id,channel_session_id) do update set distribution_mode=excluded.distribution_mode,
    default_assignee_user_id=excluded.default_assignee_user_id,has_manager_rule=true,updated_at=now() returning id into v_policy_id;
  delete from public.channel_routing_responsibles where organization_id=p_org and channel_routing_responsibles.policy_id=v_policy_id;
  insert into public.channel_routing_responsibles(organization_id,policy_id,user_id)
   select p_org,v_policy_id,x from(select distinct unnest(p_users) x) users;
  v_mode:=p_mode;
 end if;
 perform public.fn_wake_channel_routing(p_org,p_channel);
 return jsonb_build_object('channel_session_id',p_channel,'policy_id',v_policy_id,
  'mode',case when p_reset then 'legacy_unconfigured' when cardinality(p_users)=0 then 'restricted_empty' else 'restricted' end,
  'user_ids',case when p_reset then '[]'::jsonb else to_jsonb(p_users) end,
  'distribution_mode',to_jsonb(v_mode),
  'has_manager_rule',to_jsonb(case when p_reset then false else true end),
  'default_assignee_user_id',to_jsonb(case when p_reset then null else p_default_assignee end));
end;
$$;
revoke all on function public.fn_set_channel_routing(uuid,uuid,uuid[],boolean,text,uuid) from public,anon;
grant execute on function public.fn_set_channel_routing(uuid,uuid,uuid[],boolean,text,uuid) to authenticated;

create or replace function public.fn_channel_routing_claim(p_org uuid,p_conversation uuid,p_channel uuid,p_user uuid,p_schedule jsonb default null,p_reason text default 'routing')
returns text language plpgsql security definer set search_path=public as $$
declare c public.conversations; pre_contact uuid; member_id uuid; v_policy_id uuid; v_default uuid; v_manager_rule boolean; availability public.attendant_availability; current_load integer;
begin
 if p_reason not in('routing','handoff') then raise exception 'routing_reason_invalid' using errcode='22023';end if;
 select contact_id into pre_contact from public.conversations where organization_id=p_org and id=p_conversation;
 if not found then return 'conversation_changed';end if;
 perform public.fn_service_lock(p_org,pre_contact);
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':'||p_user::text,228));
 -- Task9: o trigger de status do canal toca conversas; ordem comum channel -> conversation.
 perform 1 from public.channel_sessions where organization_id=p_org and id=p_channel for share;
 if not found then return 'conversation_changed';end if;
 select * into c from public.conversations where organization_id=p_org and id=p_conversation for no key update;
 if not found or c.contact_id is distinct from pre_contact or c.channel_session_id is distinct from p_channel
  or c.status not in('open','pending','claimed','ai_handling') then return 'conversation_changed';end if;
 if c.assigned_to_user_id is not null then return 'already_assigned';end if;
 select id into member_id from public.user_organizations where organization_id=p_org and user_id=p_user
  and revoked_at is null and role in('agent','manager','admin') for share;
 if not found then return 'candidate_revoked';end if;
 -- (migration 0663, issue #2331) O destino padrão do número é aceito mesmo que
 -- não esteja na lista de responsáveis: são ajustes distintos (responsáveis
 -- restringem o rodízio; o destino padrão é entrega direta).
 -- (#5381) A restrição só existe quando a linha carrega REGRA DE GESTOR: a
 -- linha que sobrou do reset do gestor guarda ai_wait/fila de admin e não é
 -- lista de ninguém — sem esta guarda o número resetado ficaria travado.
 select id,default_assignee_user_id,has_manager_rule into v_policy_id,v_default,v_manager_rule from public.channel_routing_policies where organization_id=p_org and channel_session_id=p_channel;
 if found and v_manager_rule and p_user is distinct from v_default
  and not exists(select 1 from public.channel_routing_responsibles r where r.organization_id=p_org and r.policy_id=v_policy_id and r.user_id=p_user)
 then return 'candidate_not_allowed';end if;
 -- (migration 9062) FILA É DESTINO: com fila na conversa, a distribuição
 -- automática não sai dela. Vale para o worker de rodízio e para o handoff da IA,
 -- que entram por esta função; a atribuição MANUAL não passa aqui de propósito.
 -- Módulo `setores` desligado ⇒ a fila não manda (mesma leitura de
 -- lib/instalacao/modulos.ts: só `ligado` liga). Quem liga, usa e desliga não
 -- fica com a fila velha gravada restringindo o rodízio sem tela que a mostre.
 if c.sector_id is not null
  and exists(select 1 from public.platform_config pc where pc.chave='MODULO_SETORES' and pc.valor='ligado')
  and not exists(select 1 from public.attendant_sector_members m where m.organization_id=p_org
                  and m.sector_id=c.sector_id and m.user_id=p_user)
 then return 'candidate_not_in_sector';end if;
 select * into availability from public.attendant_availability where organization_id=p_org and user_id=p_user for share;
 if not found or not availability.is_available or (p_schedule is not null and availability.schedule is distinct from p_schedule)
 then return 'capacity_changed';end if;
 select count(*) into current_load from public.conversations where organization_id=p_org and assigned_to_user_id=p_user and status in('open','pending','claimed','ai_handling');
 if current_load>=availability.capacity then return 'capacity_changed';end if;
 perform public.fn_conversation_assign(p_org,p_conversation,p_user,p_reason,null,true);
 return 'assigned';
end;
$$;
revoke all on function public.fn_channel_routing_claim(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_channel_routing_claim(uuid,uuid,uuid,uuid,jsonb,text) to service_role;

notify pgrst, 'reload schema';
