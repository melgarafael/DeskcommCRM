-- manifest: Centraliza a revogação do turno na mesma organização, job e conversa, preservando leases e políticas de follow-up.
-- Forward-fix: 0594 já foi aplicada; não altera sua história.
create or replace function public.fn_autonomous_turn_revoked(p_org uuid, p_job uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.job_queue j
    join public.event_log r on r.organization_id = j.organization_id and r.entity_id = j.id
    where j.organization_id = p_org and j.id = p_job
      and r.event_type = 'conversation.autonomous_turn_revoked'
      and r.entity_kind = 'job' and r.status = 'done'
      and r.payload->>'conversation_id' = j.payload->'service_boundary'->>'conversation_id'
  );
$$;
revoke all on function public.fn_autonomous_turn_revoked(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_autonomous_turn_revoked(uuid, uuid) to service_role;

-- Chamado pelo worker e pelo envio inline: mantém o lease com precisão de µs.
create or replace function public.fn_followup_claim_current(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.job_queue j where j.organization_id=p_org and j.id=p_job
  and j.kind='followup_turn' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
  and not public.fn_autonomous_turn_revoked(p_org, j.id));
$$;
revoke all on function public.fn_followup_claim_current(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_followup_claim_current(uuid,uuid,text,timestamptz) to service_role;

-- Pausa permite retomada: descarte é trilha do turno, não cancelamento da inscrição.
create or replace function public.fn_followup_turno_descartado(p_org uuid, p_job uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with gravado as (
    insert into public.followup_enrollment_events
      (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
    select p_org, e.id, e.current_node_id, 'turn_discarded',
           jsonb_build_object('job_id', j.id, 'motivo', case when public.fn_autonomous_turn_revoked(p_org, j.id) then 'conversation_command_taken' else 'org_nao_operante' end),
           coalesce(j.payload->>'source_step_key', j.id::text) || ':descartado'
      from public.job_queue j
      join public.followup_enrollments e
        on e.organization_id = p_org
       and e.id::text = j.payload->>'followup_enrollment_id'
       and e.current_node_id = j.payload->>'node_id'
       and e.status in ('active', 'waiting_reply', 'dormente', 'paused_handoff', 'paused_manual')
     where j.id = p_job
       and j.organization_id = p_org
       and j.kind = 'followup_turn'
       and j.payload->>'purpose' = 'send_message'
    on conflict (enrollment_id, idempotency_key) where idempotency_key is not null do nothing
    returning 1
  )
  select exists (select 1 from gravado);
$$;

revoke execute on function public.fn_followup_turno_descartado(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_followup_turno_descartado(uuid, uuid) to service_role;

