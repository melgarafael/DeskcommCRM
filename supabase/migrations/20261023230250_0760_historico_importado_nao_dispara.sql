-- manifest: **A mensagem do histórico importado não dispara gatilho (#999).** O importador de histórico do WhatsApp grava em `messages` conversas antigas marcadas com `metadata.historico_importado = 'true'` (contrato já escrito na 0686). Sem corte, cada linha atravessava os TRÊS gatilhos de INSERT que tratam toda linha como mensagem recebida: `trg_messages_emit_event` emitia `message.received`/`message.sent` (que acorda a IA, a push, o webhook de saída, a campanha e o follow-up — a IA responderia gente que falou meses atrás), `trg_demanda_abre_no_inbound` chamava `fn_service_inbound` (reabre a conversa encerrada, abre demanda/SLA, carimba `service_revision`) e `trg_reply_inbound_revision` somava +1 na revisão de contexto. A cura é o corte `coalesce(new.metadata->>'historico_importado','') = 'true'` no topo das três funções, no mesmo molde do corte da reação (0684): a linha continua gravada, só não conta como fala. E a RPC nova `fn_upsert_wa_conversation_importada(p_org, p_contact, p_session, p_last_message_at)` devolve a conversa 1:1 existente (mesma chave da `fn_upsert_wa_conversation`) sem tocar nela, ou cria uma `closed`, sem dono, com `last_message_at` da última mensagem que o canal tem (a inbox ordena por ela) — `trg_conversation_routing_requested` só dispara para `open`/`pending` sem dono, então a conversa importada não entra na fila. `create or replace` e função nova; sem tabela/coluna/policy/dado novo; apêndice idempotente no `baseline.sql` antes da VARREDURA anon.

-- ---- o histórico importado não é mensagem recebida (migration 0760, #999) ----
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
--
-- O importador traz do celular as conversas que aconteceram ANTES de o número
-- estar no CRM. Cada mensagem vira linha em `messages`, e `messages` tem três
-- gatilhos de INSERT que não perguntam de onde a linha veio:
--
--   * `trg_messages_emit_event` → `message.received` (ou `message.sent`/
--     `message.outbound` na saída). É o evento que acorda o agente de IA, a
--     notificação push, o webhook de saída do cliente, a resposta de campanha
--     e o follow-up de silêncio. Importar 2.000 mensagens seria 2.000 eventos,
--     e a IA responderia quem falou há meses;
--   * `trg_demanda_abre_no_inbound` → `fn_service_inbound`, que reabre a
--     conversa encerrada (quando `sent_at` é posterior ao encerramento) e abre
--     demanda nova com SLA ("Responder à nova mensagem do cliente");
--   * `trg_reply_inbound_revision` → +1 na revisão de contexto.
--
-- Medido no banco do `baseline.sql` antes deste bloco
-- (`tests/invariants/historico-importado-nao-dispara.test.ts`): a entrada
-- importada nascia com `event_log` `["message.received"]` e `service_revision`
-- carimbado; a saída importada, com `["message.sent"]`.
--
-- ─── A cura: o corte da reação (0684), com a chave do histórico ─────────────
--
-- O contrato da chave é o que a 0686 já escreveu e já respeita no
-- `trg_mensagem_do_vendedor_e_atividade`: `metadata.historico_importado` como
-- TEXTO `'true'`. A condição é a MESMA, letra por letra
-- (`coalesce(new.metadata->>'historico_importado','') = 'true'`), para as quatro
-- funções lerem a chave do mesmo jeito. Qualquer outro valor (`'false'`, ausente,
-- booleano JSON) não corta — e o teste cobra o `'false'`.
--
-- O corte fica no CORPO, como na 0684, e pelas mesmas razões: o gatilho não é
-- o único chamador e a regra mora onde é lida. A linha continua gravada — nada
-- de recusar a escrita —, só não conta como fala: não emite evento, não chama
-- `fn_service_inbound` (logo não ganha `service_revision` e o
-- `trg_appointment_inbound` nunca a vê) e não mexe na revisão.
--
-- `trg_message_service_lock` (BEFORE INSERT) fica de fora pelo mesmo motivo da
-- 0684: é só o mutex do atendimento, não transiciona estado nem emite evento.
--
-- ─── A conversa que o importador cria ───────────────────────────────────────
--
-- `fn_upsert_wa_conversation` cria a conversa `open`, sem dono — e
-- `trg_conversation_routing_requested` (AFTER INSERT, `when` sem dono e
-- `open`/`pending`) emite `conversation.routing_requested`: o worker de
-- roteamento distribuiria uma conversa de meses atrás. A irmã nova,
-- `fn_upsert_wa_conversation_importada`, usa a MESMA chave (organização +
-- contato + sessão, `is_group = false`), devolve a conversa que já existe SEM
-- tocar nela (nem `updated_at`: um UPDATE passaria pelos gatilhos de UPDATE de
-- `conversations`), e só quando não existe cria uma `closed`, sem dono, com
-- `last_message_at` = a última mensagem que o canal tem na conversa (sem ela a
-- inbox, que ordena por essa coluna com `nulls last`, mandaria toda conversa
-- importada para o fim da lista, sem data). O
-- `when` do gatilho de roteamento não a vê. Uma mensagem NOVA de verdade do
-- cliente, depois, passa por `fn_service_inbound` e reabre normalmente
-- (`service_closed_at` nulo não segura nada).
--
-- Permissões da irmã: SECURITY DEFINER, só `service_role` executa. Aqui com
-- `search_path = ''` e nomes qualificados (a forma que o Security Advisor pede,
-- 0521).
--
-- Sem string de usuário, sem coluna, sem policy, sem RLS. Idempotente
-- (`create or replace`; `revoke`/`grant` repetidos com a ACL da última
-- definição de cada função).
--
-- Gate: `tests/invariants/historico-importado-nao-dispara.test.ts`.

create or replace function public.fn_demanda_abre_no_inbound()
returns trigger language plpgsql security definer set search_path=public as $fn$
begin
  -- A REAÇÃO NÃO É MENSAGEM RECEBIDA. Sem este corte, o INSERT da linha
  -- `type='reaction'` chamava `fn_service_inbound`, que reabre a conversa
  -- encerrada e abre uma demanda nova para um gesto que não é fala.
  if new.type = 'reaction' then
    return new;
  end if;
  -- O HISTÓRICO IMPORTADO É PASSADO, NÃO ATENDIMENTO (0760, #999). Sem este
  -- corte, cada mensagem trazida do celular reabria a conversa e abria demanda
  -- com SLA. Mesma chave e mesmo texto da 0686.
  if coalesce(new.metadata->>'historico_importado','') = 'true' then
    return new;
  end if;
  perform public.fn_service_inbound(new.id);
  return new;
end; $fn$;
revoke execute on function public.fn_demanda_abre_no_inbound() from public,anon,authenticated;

create or replace function public.fn_emit_message_event() returns trigger
language plpgsql set search_path to 'public', 'pg_temp' as $fn$
declare
  v_event text;
begin
  -- A reação não vira evento. O `type='reaction'` sai antes de escolher o
  -- evento: sem isto, a linha emitia `message.received` (ou, quando o operador
  -- reagia, `message.outbound`) e acordava push, webhook de saída, campanha e
  -- follow-up — consumidores que não filtram o tipo. Nenhum evento é a resposta
  -- certa: reação não é mensagem, e não existe evento de reação.
  if new.type = 'reaction' then
    return new;
  end if;
  -- O histórico importado não vira evento, em NENHUMA direção (0760, #999):
  -- `message.received` acordaria a IA para responder quem falou há meses, e
  -- `message.sent`/`message.outbound` alimentaria webhook e métrica com o
  -- passado. Mesma chave e mesmo texto da 0686.
  if coalesce(new.metadata->>'historico_importado','') = 'true' then
    return new;
  end if;
  if new.direction = 'inbound' then
    if exists (select 1 from public.conversations c
               where c.id = new.conversation_id and c.organization_id = new.organization_id and c.is_group) then
      v_event := 'message.group_received';
    else
      v_event := 'message.received';
    end if;
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
      'channel_session_id', new.channel_session_id,
      'body_preview', "left"(new.body, 280)
    )
  );
  return new;
end$fn$;
grant all on function public.fn_emit_message_event() to anon;
grant all on function public.fn_emit_message_event() to authenticated;
grant all on function public.fn_emit_message_event() to service_role;

create or replace function public.fn_reply_inbound_revision() returns trigger language plpgsql security definer set search_path=public as $fn$
begin
  -- A revisão de contexto é "o cliente falou de novo" — e a reação não é fala.
  -- Sem o corte, um 👍 somava +1 e invalidava o rascunho de resposta da tela à
  -- toa, além de contar junto com a reabertura (que este bloco também acabou de
  -- desligar). O histórico importado tampouco é fala de agora (0760, #999).
  if new.direction='inbound' and new.type <> 'reaction'
     and coalesce(new.metadata->>'historico_importado','') <> 'true' then
    update public.conversations set reply_context_revision=reply_context_revision+1 where organization_id=new.organization_id and id=new.conversation_id and contact_id=new.contact_id;
  end if;
  return new;
end;$fn$;
revoke all on function public.fn_reply_inbound_revision() from public,anon,authenticated;

create or replace function public.fn_upsert_wa_conversation_importada(
  p_org uuid, p_contact uuid, p_session uuid, p_last_message_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $fn$
declare v_id uuid;
begin
  -- A conversa que já existe volta INTOCADA: nem status, nem dono, nem
  -- `updated_at` (um UPDATE passaria pelos gatilhos de UPDATE de conversations).
  select c.id into v_id
    from public.conversations c
   where c.organization_id = p_org and c.contact_id = p_contact
     and c.channel_session_id = p_session and c.is_group = false;
  if v_id is not null then
    return v_id;
  end if;

  -- Nasce `closed` e sem dono: o `when` de `trg_conversation_routing_requested`
  -- (sem dono E `open`/`pending`) não a vê, e nada entra na fila do roteamento.
  -- `last_message_at` é a data da última mensagem que o canal tem na conversa:
  -- sem ela a inbox (`order by last_message_at desc nulls last`) jogaria toda
  -- conversa importada para o fim da lista, sem data. Só no INSERT: conversa
  -- existente já tem a data dela, e tocar nela passaria pelos gatilhos de UPDATE.
  insert into public.conversations
    (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, metadata, last_message_at)
  values (p_org, p_contact, p_session, 'whatsapp', 'closed', false, 0, '{}'::jsonb, p_last_message_at)
  on conflict (organization_id, contact_id, channel_session_id) where is_group = false
  do nothing
  returning id into v_id;

  -- Corrida: outro escritor criou a conversa entre o SELECT e o INSERT. A dele
  -- vale, do jeito que ele a deixou.
  if v_id is null then
    select c.id into v_id
      from public.conversations c
     where c.organization_id = p_org and c.contact_id = p_contact
       and c.channel_session_id = p_session and c.is_group = false;
  end if;
  return v_id;
end; $fn$;

comment on function public.fn_upsert_wa_conversation_importada(uuid, uuid, uuid, timestamptz) is
  'Irmã de fn_upsert_wa_conversation para o importador de histórico do WhatsApp (#999): devolve a conversa 1:1 existente (organização + contato + sessão) sem tocar nela, ou cria uma closed e sem dono, com last_message_at = p_last_message_at — que não emite conversation.routing_requested. Só service_role.';

revoke all on function public.fn_upsert_wa_conversation_importada(uuid, uuid, uuid, timestamptz) from public;
revoke execute on function public.fn_upsert_wa_conversation_importada(uuid, uuid, uuid, timestamptz) from anon, authenticated;
grant execute on function public.fn_upsert_wa_conversation_importada(uuid, uuid, uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';
