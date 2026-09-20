-- Preserve the actual billing identity and a content-free usage snapshot for reconciliation.
-- Existing reservations are intentionally not backfilled from timestamps or model guesses.
alter table public.subscription_ai_reservations add column if not exists provider text;
alter table public.subscription_ai_reservations add column if not exists model text;
alter table public.subscription_ai_reservations add column if not exists usage_evidence jsonb;
create or replace function public.fn_record_subscription_ai_evidence(
 p_org uuid,p_call uuid,p_provider text,p_model text,p_evidence jsonb
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.subscription_ai_reservations%rowtype;
begin
 if p_provider is null or length(btrim(p_provider)) not between 1 and 256
    or p_model is null or length(btrim(p_model)) not between 1 and 256 then
   raise exception 'Identidade de consumo inválida.' using errcode='P4022';
 end if;
 if p_evidence is not null and (
   jsonb_typeof(p_evidence) is distinct from 'object'
   or p_evidence->'version' is distinct from '1'::jsonb
   or jsonb_typeof(p_evidence->'steps') is distinct from 'array'
 ) then raise exception 'Evidência de consumo inválida.' using errcode='P4022'; end if;
 select * into r from public.subscription_ai_reservations
 where id=p_call and organization_id=p_org for update;
 if not found then raise exception 'Reserva não encontrada.' using errcode='P4022'; end if;
 if (r.provider is not null and r.provider<>p_provider)
    or (r.model is not null and r.model<>p_model)
    or (r.usage_evidence is not null and p_evidence is not null and r.usage_evidence<>p_evidence) then
   raise exception 'Evidência já registrada com outro conteúdo.' using errcode='P4022';
 end if;
 update public.subscription_ai_reservations set provider=p_provider,model=p_model,
 usage_evidence=coalesce(usage_evidence,p_evidence)
 where id=p_call and organization_id=p_org;
end $$;
revoke all on function public.fn_record_subscription_ai_evidence(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.fn_record_subscription_ai_evidence(uuid,uuid,text,text,jsonb) to service_role;
