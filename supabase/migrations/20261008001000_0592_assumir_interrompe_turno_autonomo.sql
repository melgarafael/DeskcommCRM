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
  update public.job_queue j
     set status = 'failed', locked_by = null, locked_at = null,
         last_error = 'conversation_command_taken'
   where j.organization_id = new.organization_id
     and j.payload->'service_boundary'->>'conversation_id' = new.conversation_id::text
     and j.payload->'service_boundary'->>'organization_id' = new.organization_id::text
     and j.contact_id = (select c.contact_id from public.conversations c
       where c.organization_id = new.organization_id and c.id = new.conversation_id)
     and ((j.kind in ('inbound_turn', 'case_reply_turn') and j.status in ('pending', 'running'))
       or (j.kind = 'followup_turn' and j.status = 'running'));
  -- Follow-ups futuros continuam sujeitos à política de pausa/cancelamento do fluxo.
  -- transactional_delivery, approved_reply e operator_turn não têm este dono.
  return new;
end;
$$;
revoke all on function public.fn_interromper_turnos_ao_assumir() from public, anon, authenticated;
-- Função de trigger: não há RPC/EXECUTE concedido ao caller.
drop trigger if exists trg_interromper_turnos_ao_assumir on public.conversation_assignment_events;
create trigger trg_interromper_turnos_ao_assumir
  after insert on public.conversation_assignment_events
  for each row execute function public.fn_interromper_turnos_ao_assumir();
