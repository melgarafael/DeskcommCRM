-- ============================================================================
-- 0161 — Resposta zera o contador de mensagens pendentes na fila.
--
-- O badge da inbox incrementava a cada inbound mas NUNCA caía quando o
-- atendente (ou a IA) respondia — só no assign/transfer. Resultado: conversa
-- com 1 mensagem nova do cliente mostrava 6 no badge porque as 5 anteriores
-- tinham sido respondidas mas o contador nunca foi zerado.
--
-- Semântica corrigida: inbound soma 1; outbound zera (nada pendente até o
-- cliente escrever de novo). Mark-as-read (rota POST mark-read) cobre o caso
-- em que o atendente abre a thread sem responder.
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
end; $$;

comment on function public.fn_mark_conversation_message is
  'Atualiza agregados da conversa: inbound incrementa unread; outbound zera (respondido).';

-- Corrige contadores stale: inbound desde a última resposta do atendente/IA.
update public.conversations c
set unread_count_for_assignee = coalesce((
  select count(*)::integer
  from public.messages m
  where m.conversation_id = c.id
    and m.direction = 'inbound'
    and m.sent_at > coalesce(c.last_outbound_at, '-infinity'::timestamptz)
), 0)
where unread_count_for_assignee <> coalesce((
  select count(*)::integer
  from public.messages m
  where m.conversation_id = c.id
    and m.direction = 'inbound'
    and m.sent_at > coalesce(c.last_outbound_at, '-infinity'::timestamptz)
), 0);
