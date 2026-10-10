-- ============================================================================
-- 0152 — O GATILHO PASSA A MANDAR O TEXTO E A CONEXÃO.
--
-- A 0145 (e o commit que a acompanha) apagou a SEGUNDA emissão de
-- `message.received` que o ingest por QR fazia, porque o gatilho
-- `trg_messages_emit_event` já emite para todo canal e os quatro consumidores
-- rodavam duas vezes por mensagem.
--
-- Só que os dois payloads NÃO eram iguais, e o que sumiu tinha campo que o
-- gatilho não manda:
--
--   gatilho : message_id, conversation_id, contact_id, direction, type,
--             status, external_id
--   app     : conversation_id, contact_id, channel_session_id, body_preview
--
-- `body_preview` é lido pela condição "Texto da mensagem" das automações
-- (`app/app/webhooks/_components/RuleEditor.tsx`, valor `event.body_preview`) —
-- a ÚNICA condição de texto disponível para o gatilho `message.received`. Sem
-- ele, uma regra que o usuário configurou para reagir ao conteúdo da mensagem
-- deixa de casar, em silêncio: a automação não dispara e nada acusa por quê.
-- Também é interpolado em `{{event.body_preview}}` nas ações e vai no corpo do
-- webhook de saída.
--
-- ─── Por que acrescentar ao gatilho, e não devolver a emissão dupla ────────
--
-- Porque a emissão dupla cobrava sentimento duas vezes por mensagem e o
-- critério de aceite do EPIC-03 já dizia "só 1". O certo é o emissor único
-- carregar o payload COMPLETO — e assim o canal oficial, que nunca teve
-- `body_preview`, passa a ter também. A condição de texto funciona nos dois
-- canais pela primeira vez.
--
-- ─── Por que 280 ─────────────────────────────────────────────────────────
--
-- É o mesmo corte que a emissão removida usava. Mudar o tamanho aqui mudaria,
-- em silêncio, o resultado de uma regra "contém" já configurada por alguém.
--
-- `left()` e não `substring()`: `left` aceita NULL e devolve NULL, que é o que
-- se quer para mensagem sem corpo (mídia sem legenda) — a condição de texto
-- simplesmente não casa, em vez de casar com string vazia.
-- ============================================================================

create or replace function public.fn_emit_message_event() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_event text;
begin
  if new.direction = 'inbound' then
    v_event := 'message.received';
  else
    v_event := case new.status
                 when 'sending' then 'message.sending'
                 when 'sent' then 'message.sent'
                 when 'failed' then 'message.failed'
                 else 'message.outbound'
               end;
  end if;

  perform public.fn_log_event(
    new.organization_id, v_event,
    jsonb_build_object(
      'message_id', new.id, 'conversation_id', new.conversation_id,
      'contact_id', new.contact_id, 'direction', new.direction,
      'type', new.type, 'status', new.status, 'external_id', new.external_id,
      -- Os dois campos que só a emissão do app mandava.
      'channel_session_id', new.channel_session_id,
      'body_preview', left(new.body, 280)
    )
  );
  return new;
end$$;
