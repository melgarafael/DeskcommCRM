-- 0040_conversation_routing_emit — G5-02 (AT-03, spec 13 §5): a ENTRADA de uma
-- conversa na fila emite `conversation.routing_requested` em event_log; o worker
-- (cron TS lib/routing/worker.ts) consome e distribui. Trigger NUNCA faz HTTP —
-- só emit_event (INSERT em event_log). Worker consome o side effect.
--
-- ANTI-ECO (crítico): AFTER INSERT APENAS, e SÓ quando a conversa nasce SEM dono
-- numa fila aberta (assigned_to_user_id IS NULL AND status IN ('open','pending')).
-- Não há trigger de UPDATE — logo o UPDATE de atribuição que fn_conversation_assign
-- faz (owner null → agente) JAMAIS re-emite o evento. Sem isso, o assign do worker
-- geraria um novo routing_requested → o worker reprocessaria → LOOP INFINITO.
-- Conversa criada JÁ com dono, ou fechada/arquivada/ai_handling, não entra na fila
-- e não emite.
--
-- Idempotente (create or replace + drop trigger if exists), portável em psql puro.

create or replace function public.fn_emit_conversation_routing() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  perform public.emit_event(
    'conversation.routing_requested',
    'conversation',
    new.id,
    jsonb_build_object('conversation_id', new.id, 'organization_id', new.organization_id),
    '{}'::jsonb,
    new.organization_id
  );
  return null; -- AFTER trigger: valor de retorno ignorado
end;
$$;

alter function public.fn_emit_conversation_routing() owner to postgres;

drop trigger if exists trg_conversation_routing_requested on public.conversations;
create trigger trg_conversation_routing_requested
  after insert on public.conversations
  for each row
  when (new.assigned_to_user_id is null and new.status in ('open', 'pending'))
  execute function public.fn_emit_conversation_routing();
