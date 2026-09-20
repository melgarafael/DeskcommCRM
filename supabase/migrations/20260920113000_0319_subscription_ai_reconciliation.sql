-- An explicit platform-admin review resolves unknown usage atomically with its audit.
-- No timer expires holds, and no tenant can submit its own accounting cost.
create or replace function public.fn_reconcile_subscription_ai(
 p_org uuid,p_call uuid,p_actor uuid,p_cost_usd_cents numeric,p_reference text,p_request_id text
) returns numeric language plpgsql security definer set search_path=public,pg_temp as $$
declare
 r public.subscription_ai_reservations%rowtype;
 period uuid;
 charge numeric;
 prior jsonb;
begin
 if not exists(select 1 from public.platform_admins where user_id=p_actor and scope='full' and revoked_at is null) then
   raise exception 'Administração completa necessária.' using errcode='42501';
 end if;
 if p_cost_usd_cents is null or p_cost_usd_cents<0 or p_cost_usd_cents>='Infinity'::numeric
    or p_reference is null or length(btrim(p_reference)) not between 10 and 1000 then
   raise exception 'Informe o custo conferido e a referência da verificação.' using errcode='P4022';
 end if;
 select period_id into period from public.subscription_ai_reservations where id=p_call and organization_id=p_org;
 if not found then raise exception 'Reserva não encontrada.' using errcode='P4022'; end if;
 -- Keep the same period-before-reservation lock order as automatic settlement.
 perform 1 from public.subscription_ai_periods where id=period and organization_id=p_org for update;
 select * into r from public.subscription_ai_reservations where id=p_call and organization_id=p_org for update;
 if r.status='settled' then
   select metadata into prior from public.api_audit_log
    where organization_id=p_org and resource_id=p_call and action='billing.ai_reconciled'
    order by created_at desc limit 1;
   if prior is not null and r.cost_usd_cents=p_cost_usd_cents and prior->>'reference'=btrim(p_reference) then
     return r.charged_brl_cents;
   end if;
   raise exception 'Este consumo já foi conciliado. Atualize a lista.' using errcode='P4022';
 end if;
 if r.status<>'unknown' then
   raise exception 'O consumo ainda está em andamento; não pode ser conciliado manualmente.' using errcode='P4022';
 end if;
 if r.provider is null or r.model is null then
   raise exception 'Consumo sem identificação suficiente para esta conferência.' using errcode='P4022';
 end if;
 charge:=public.fn_settle_subscription_ai(p_org,p_call,p_cost_usd_cents);
 insert into public.api_audit_log(organization_id,actor_user_id,acting_as_platform_admin,action,resource_type,resource_id,request_id,bypassed_rls,metadata)
 values(p_org,p_actor,true,'billing.ai_reconciled','subscription_ai_reservation',p_call,p_request_id,true,
 jsonb_build_object('reference',btrim(p_reference),'cost_usd_cents',p_cost_usd_cents,'charged_brl_cents',charge,
 'provider',r.provider,'model',r.model,'period_id',r.period_id,'usage_evidence',r.usage_evidence));
 return charge;
end $$;
revoke all on function public.fn_reconcile_subscription_ai(uuid,uuid,uuid,numeric,text,text) from public,anon,authenticated;
grant execute on function public.fn_reconcile_subscription_ai(uuid,uuid,uuid,numeric,text,text) to service_role;
