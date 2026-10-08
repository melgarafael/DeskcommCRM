-- manifest: Tomada humana invalida os turnos autônomos da conversa, sem vencer lembretes ou aprovações.
-- A identidade do atendimento não muda: só o lease do trabalho que perdeu comando.
-- Status terminal não volta a pending quando a conversa é devolvida ao automático.
create or replace function public.fn_interromper_turnos_ao_assumir()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Distribuir ao responsável não é assumir; handoff é decisão do próprio turno.
  if new.reason not in ('claim', 'transfer') or new.to_user_id is null then return new; end if;
  -- O fato de atribuição deve corresponder ao dono real, na MESMA organização.
  if not exists (select 1 from public.conversations c
    where c.organization_id = new.organization_id and c.id = new.conversation_id
      and c.assigned_to_user_id = new.to_user_id) then return new; end if;
  -- O fluxo tem escrita interna própria: a sessão humana não pode cancelar seu
  -- job. Guarda um fato terminal para o worker descartar sob a sua autoridade.
  -- Não usa created_at >= locked_at: now() é o início da transação da tomada,
  -- que pode ter começado ANTES da aquisição do lease que está sendo revogado.
  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
    select new.organization_id, 'conversation.autonomous_turn_revoked', 'job', j.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'assignment_event_id', new.id), 'done'
    from public.job_queue j
    where j.organization_id = new.organization_id and j.kind = 'followup_turn' and j.status = 'running'
      and j.payload->'service_boundary'->>'conversation_id' = new.conversation_id::text
      and j.payload->'service_boundary'->>'organization_id' = new.organization_id::text
      and j.contact_id = (select c.contact_id from public.conversations c
        where c.organization_id = new.organization_id and c.id = new.conversation_id);
  update public.job_queue j
     set status = 'failed', locked_by = null, locked_at = null,
         last_error = 'conversation_command_taken'
   where j.organization_id = new.organization_id
     and j.payload->'service_boundary'->>'conversation_id' = new.conversation_id::text
     and j.payload->'service_boundary'->>'organization_id' = new.organization_id::text
     and j.contact_id = (select c.contact_id from public.conversations c
       where c.organization_id = new.organization_id and c.id = new.conversation_id)
     and j.kind in ('inbound_turn', 'case_reply_turn')
     and j.status in ('pending', 'running');
  -- O worker encerra só o turno de follow-up revogado, não a inscrição nem sua política.
  -- transactional_delivery, approved_reply e operator_turn não têm este dono.
  return new;
end;
$$;
revoke execute on function public.fn_interromper_turnos_ao_assumir() from public, anon, authenticated, service_role;
-- Função de trigger: não há RPC/EXECUTE concedido ao caller.
drop trigger if exists trg_interromper_turnos_ao_assumir on public.conversation_assignment_events;
create trigger trg_interromper_turnos_ao_assumir
  after insert on public.conversation_assignment_events
  for each row execute function public.fn_interromper_turnos_ao_assumir();

-- A mesma revogação alcança o envio inline (sem agent-worker/AsyncLocalStorage).
create or replace function public.fn_followup_claim_current(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.job_queue j where j.organization_id=p_org and j.id=p_job
  and j.kind='followup_turn' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
  and not exists(select 1 from public.event_log r where r.organization_id=p_org
    and r.event_type='conversation.autonomous_turn_revoked' and r.entity_kind='job' and r.entity_id=j.id
    and r.status='done' and r.payload->>'conversation_id'=j.payload->'service_boundary'->>'conversation_id'));
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
           jsonb_build_object('job_id', j.id, 'motivo', case when exists (
             select 1 from public.event_log r where r.organization_id=p_org
               and r.event_type='conversation.autonomous_turn_revoked' and r.entity_kind='job'
               and r.entity_id=j.id and r.status='done'
           ) then 'conversation_command_taken' else 'org_nao_operante' end),
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
