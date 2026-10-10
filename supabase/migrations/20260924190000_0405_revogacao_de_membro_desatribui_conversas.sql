-- 0405: Ao revogar um membro, as conversas abertas dele voltam para a fila (#1562).
--
-- Achado da revisão adversarial do #1561: `fn_routing_member_revoked` não
-- desatribuía as conversas abertas de quem era revogado da organização.
-- Uma conversa assumida ficava com `assigned_to_user_id` apontando para
-- o usuário revogado e `bot_silenced_until = 'infinity'`, deixando a conversa
-- muda sem que nenhum atendente a visse como sua nem a IA respondesse.
--
-- Agora, quando `revoked_at` é preenchido ou o papel deixa de ser elegível
-- (fora de agent/manager/admin), a função:
-- 1. Remove da escala de elegibilidade (`channel_routing_responsibles`);
-- 2. Desatribui todas as conversas abertas (`status in ('open','pending','claimed','ai_handling')`),
--    limpando `assigned_to_user_id`, `assigned_to_user_name`, `assignee_kind`,
--    resetando status para 'open', soltando o silêncio do bot com a regra do release
--    (`null` só sem `last_handoff_at`: conversa passada pela IA a um humano segue humana)
--    e registrando evento em `conversation_assignment_events` (`reason = 'member_revoked'`);
-- 3. Aciona o despertar do roteamento por canal (`fn_wake_channel_routing`).

-- O CHECK inline de conversation_assignment_events.reason só aceitava
-- claim/transfer/release/routing/handoff: sem ampliá-lo, o insert abaixo
-- falhava com 23514 e TODA revogação de membro com conversa aberta dava 500.
-- As linhas existentes cabem no conjunto novo; não há backfill.
alter table public.conversation_assignment_events
  drop constraint if exists conversation_assignment_events_reason_check;
alter table public.conversation_assignment_events
  add constraint conversation_assignment_events_reason_check
  check (reason in ('claim','transfer','release','routing','handoff','member_revoked'));

create or replace function public.fn_routing_member_revoked()
returns trigger language plpgsql security definer set search_path=public as $$
declare
 v_conv record;
begin
 if new.revoked_at is not null or new.role not in('agent','manager','admin') then
  delete from public.channel_routing_responsibles where organization_id=new.organization_id and user_id=new.user_id;

  for v_conv in
    select id from public.conversations
     where organization_id=new.organization_id
       and assigned_to_user_id=new.user_id
       and status in('open','pending','claimed','ai_handling')
     order by id
  loop
    update public.conversations
       set assigned_to_user_id=null,
           assigned_to_user_name=null,
           assigned_at=null,
           assignee_kind=null,
           status='open',
           status_changed_at=now(),
           unread_count_for_assignee=0,
           -- Mesma regra do release de fn_conversation_assign: a conversa que a IA
           -- passou a um humano (last_handoff_at) continua com a IA calada.
           bot_silenced_until=case when last_handoff_at is null then null else bot_silenced_until end,
           updated_at=now()
     where id=v_conv.id;

    insert into public.conversation_assignment_events
      (organization_id,conversation_id,from_user_id,to_user_id,changed_by,reason)
    values
      (new.organization_id,v_conv.id,new.user_id,null,auth.uid(),'member_revoked');
  end loop;
 end if;
 perform public.fn_wake_channel_routing(new.organization_id);
 return new;
end;
$$;
revoke all on function public.fn_routing_member_revoked() from public,anon,authenticated;
