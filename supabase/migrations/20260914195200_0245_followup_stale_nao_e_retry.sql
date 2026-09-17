-- followup_stale deixou de ser SQLSTATE 40001 (serialization_failure).
--
-- 40001 é o código com que o Postgres pede RETRY da transação. O patch de
-- follow-up usa a mesma mensagem para "revisão velha" e "enrollment sumiu" —
-- estados permanentes. O cliente (PostgREST, pool, worker) retentava na hora,
-- ~100 vezes por segundo, e o banco ficava em 100% de CPU gravando o mesmo
-- erro. Medido no projeto hospedado: 6000 followup_stale/min, estável por
-- mais de 24h, com convoy de advisory lock num único contato.
--
-- P0001 (raise_exception) não entra nesse laço. A mensagem continua
-- `followup_stale` — quem já trata pelo texto não muda. CREATE OR REPLACE
-- idempotente; ACL igual à 0224.

create or replace function public.fn_followup_revision()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if old.appointment_revision is not null then
  new.appointment_revision:=old.appointment_revision;
  if new.appointment_id is null and not exists(select 1 from public.calendar_appointments where organization_id=old.organization_id and id=old.appointment_id) then
   new.status:='cancelled';new.cancel_reason:='O compromisso foi removido.';new.next_eval_at:=null;new.claimed_until:=null;new.completed_at:=now();
  else new.appointment_id:=old.appointment_id; end if;
  if new.contact_id is distinct from old.contact_id then
   new.status:='cancelled';new.cancel_reason:='O contato do compromisso mudou.';new.next_eval_at:=null;new.claimed_until:=null;new.completed_at:=now();
  end if;
 end if;
 if new.appointment_revision is not null and new.status in ('active','waiting_reply','paused_handoff','paused_manual') then
  if old.status not in ('active','waiting_reply','paused_handoff','paused_manual') or not exists(
   select 1 from public.calendar_appointments a join public.appointment_recovery_receipts r
    on r.organization_id=a.organization_id and r.appointment_id=a.id and r.appointment_revision=a.revision
   where a.organization_id=new.organization_id and a.id=new.appointment_id and a.revision=new.appointment_revision
    and a.status='no_show' and a.contact_id=new.contact_id and r.result='started' and r.invalidated_at is null
  ) then raise exception 'followup_stale' using errcode='P0001'; end if;
 end if;
 new.revision:=old.revision+1; return new;
end; $$;
revoke all on function public.fn_followup_revision() from public,anon,authenticated;

create or replace function public.fn_followup_patch(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare current public.followup_enrollments; patched public.followup_enrollments; contact uuid;
begin
 select contact_id into contact from public.followup_enrollments where id=p_id and organization_id=p_org;
 if not found then raise exception 'followup_stale' using errcode='P0001'; end if;
 perform public.fn_service_lock(p_org,contact);
 select * into current from public.followup_enrollments where id=p_id and organization_id=p_org for update;
 if current.contact_id is distinct from contact or current.revision is distinct from p_revision then raise exception 'followup_stale' using errcode='P0001'; end if;
 if p_patch->>'status' in ('active','waiting_reply') and current.appointment_revision is not null and not public.fn_appointment_enrollment_current(p_org,p_id,current.current_node_id) then raise exception 'followup_stale' using errcode='P0001'; end if;
 select * into patched from jsonb_populate_record(current,p_patch);
 update public.followup_enrollments set status=patched.status,current_node_id=patched.current_node_id,next_eval_at=patched.next_eval_at,
  claimed_until=patched.claimed_until,attempts=patched.attempts,last_error=patched.last_error,steps_taken=patched.steps_taken,
  outcome=patched.outcome,cancel_reason=patched.cancel_reason,completed_at=patched.completed_at,timing_plan=patched.timing_plan
 where organization_id=p_org and id=p_id returning revision into p_revision;
 return p_revision;
end; $$;
revoke all on function public.fn_followup_patch(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.fn_followup_patch(uuid,uuid,bigint,jsonb) to service_role;
