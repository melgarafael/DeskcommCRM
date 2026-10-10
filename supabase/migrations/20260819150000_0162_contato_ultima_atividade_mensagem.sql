-- ============================================================================
-- 0162 — Mensagem de conversa carimba `contacts.last_activity_at`.
--
-- A lista /app/contacts mostra "Última atividade" de `contacts.last_activity_at`,
-- denormalizado hoje só pelo trigger de `crm_lead_activities`. Mensagens de
-- WhatsApp/Meta/Zernio passam por `fn_mark_conversation_message` e atualizam
-- `conversations.last_message_at` — mas o contato ficava parado (— ou data velha).
--
-- O relógio do LEAD continua na lista positiva da 0079; aqui só o contato.
-- ============================================================================

create or replace function public.fn_mark_conversation_message(
  p_conv uuid, p_direction text, p_preview text, p_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set
    last_message_at = p_at, last_message_preview = p_preview,
    last_inbound_at  = case when p_direction = 'inbound'  then p_at else last_inbound_at  end,
    last_outbound_at = case when p_direction = 'outbound' then p_at else last_outbound_at end,
    unread_count_for_assignee = case
      when p_direction = 'inbound'  then unread_count_for_assignee + 1
      when p_direction = 'outbound' then 0
      else unread_count_for_assignee
    end,
    updated_at = now()
  where id = p_conv;

  update public.contacts c
     set last_activity_at = greatest(coalesce(c.last_activity_at, '-infinity'::timestamptz), p_at)
    from public.conversations v
   where v.id = p_conv
     and c.id = v.contact_id;
end; $$;

comment on function public.fn_mark_conversation_message is
  'Atualiza agregados da conversa (inbound incrementa unread; outbound zera) e carimba contacts.last_activity_at.';

-- Contatos que já conversaram mas nunca tiveram atividade de lead.
update public.contacts c
   set last_activity_at = sub.max_at
  from (
    select contact_id, max(last_message_at) as max_at
      from public.conversations
     where last_message_at is not null
     group by contact_id
  ) sub
 where c.id = sub.contact_id
   and coalesce(c.last_activity_at, '-infinity'::timestamptz) < sub.max_at;

notify pgrst, 'reload schema';
