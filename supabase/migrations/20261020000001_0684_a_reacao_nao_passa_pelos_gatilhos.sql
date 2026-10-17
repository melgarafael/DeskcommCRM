-- manifest: **A reação não passa mais pelos gatilhos de mensagem recebida (arremate do PR #2815, issue #2797).** O escritor único da fatia 1 (`lib/channels/reacao.ts`) grava a reação como linha `type='reaction'` LIGADA ao alvo e não chama `fn_mark_conversation_message` — por isso ela não move `last_message_at`, a janela de 24h, a prévia nem o contador de não lidas. Mas o INSERT em `messages` ainda atravessava os TRÊS gatilhos que tratam toda linha como mensagem recebida, e a reação os disparava: `trg_demanda_abre_no_inbound` chamava `fn_service_inbound` e REABRIA a conversa fechada (abrindo demanda nova), `trg_messages_emit_event` emitia `message.received` (que alcança a notificação push, o webhook de saída do cliente, a resposta de campanha e o follow-up — nenhum deles filtra o tipo), e `trg_reply_inbound_revision` somava +1 na revisão de contexto. Medido numa sonda de banco real: conversa `closed` com `reply_context_revision=2` voltava `open` com revisão 4 depois de um 👍, e o `event_log` da reação nascia `["message.received"]`. A cura é o corte `new.type = 'reaction'` no topo das TRÊS funções (equivalente ao `new.type <> 'reaction'` pedido na triagem): a linha da reação continua sendo gravada — nada de recusar a escrita —, mas não conta como fala. NÃO carimba, não reabre, não emite evento, não mexe na revisão. `create or replace`, sem tabela/coluna/policy/dado novo; apêndice idempotente no `baseline.sql` antes da VARREDURA anon.

-- ---- a reação não é mensagem recebida: os três gatilhos do INSERT (migration 0684, #2797/#2815) ----
--
-- ─── O defeito, e por que o "não carimba" do PR não bastava ─────────────────
--
-- A fatia 1 tirou a reação do caminho de mensagem NO APLICATIVO: `reacao.ts` é
-- o único escritor, resolve o alvo antes de qualquer escrita e NÃO chama
-- `fn_mark_conversation_message`. Isso fecha o carimbo (última mensagem, janela
-- de 24h, prévia, contador de não lidas) — e foi medido que o carimbo de fato
-- não acontece.
--
-- O que ficou de pé é o outro lado da mesma tabela: `messages` tem gatilhos de
-- INSERT, e eles não perguntam o `type`. Um 👍 virava, no banco:
--
--   * `trg_demanda_abre_no_inbound` → `fn_service_inbound(new.id)` → reabre a
--     conversa que estava `closed`/`resolved`/`archived` e abre uma demanda
--     nova ("Responder à nova mensagem do cliente") para uma reação;
--   * `trg_messages_emit_event` → `message.received`, que é consumido pela
--     notificação push (como "Mídia"), pelo webhook de saída do cliente, pela
--     resposta de campanha e pelo follow-up de silêncio — nenhum filtra o tipo;
--   * `trg_reply_inbound_revision` → +1 na revisão de contexto, que invalida o
--     rascunho de resposta preso na tela à toa.
--
-- A reabertura é exatamente o "👍 que reabria a conversa" que a issue #2797
-- existe para consertar — e no canal oficial a `main` já gravava a reação em
-- `messages` antes deste PR, então os gatilhos já disparavam lá. Medido numa
-- sonda de banco real (baseline + este PR): fechar com `fn_service_status(…,
-- 'closed', …)` e inserir a reação devolvia `status=open` e
-- `reply_context_revision` de 2 para 4 (o +1 da reabertura e o +1 do gatilho).
--
-- ─── Por que cortar na FUNÇÃO, e não no gatilho nem na tabela ───────────────
--
-- `create trigger … when (new.type <> 'reaction')` resolveria sem tocar em
-- corpo nenhum, mas o gatilho não é o único chamador destas funções (a
-- `fn_emit_message_event` é a mesma em todos os pontos do arquivo) e a coluna
-- passaria a mentir: a linha da reação continuaria entrando pela mesma porta e
-- só o `when` a esconderia. O corte fica no corpo, onde a regra é lida.
--
-- A outra saída da triagem — gravar a reação FORA de `messages` — muda o
-- escritor, o CHECK de `type`, o vínculo com o alvo e o desenho da Inbox numa
-- tacada só. Fica para a fatia que desenhar a Inbox (`#2797`, "fora desta
-- fatia"); aqui a linha da reação permanece, ligada ao alvo, e apenas deixa de
-- ser tratada como fala.
--
-- ─── O que NÃO é tocado ────────────────────────────────────────────────────
--
-- `trg_message_service_lock` (BEFORE INSERT, `fn_message_service_lock`) fica de
-- fora DE PROPÓSITO: ele só adquire o advisory de serialização do atendimento
-- (`fn_service_lock`) e não transiciona estado nem emite evento. Tirar a reação
-- dele mudaria a ORDEM do INSERT em relação às transições de `fn_service_trocar`
-- sem ganho nenhum — um mutex não faz a reação ser mensagem.
--
-- `fn_service_inbound` continua com a régua dela (`m.direction <> 'inbound'`),
-- intacta: consertar quem a CHAMA é o escopo; ela mesma não muda. E o
-- `trg_appointment_inbound` (AFTER UPDATE OF `service_revision`) também sai de
-- alcance sozinho — sem `fn_service_inbound`, a linha da reação nunca ganha
-- `service_revision`, então o gatilho nunca a vê.
--
-- Sem string de usuário, sem coluna, sem policy, sem RLS. Idempotente
-- (`create or replace`; `revoke`/`grant` repetidos com a ACL da ÚLTIMA
-- definição de cada função, para não mexer em privilégio).
--
-- Gate: `tests/invariants/reacao-nao-passa-pelos-gatilhos.test.ts` (a sonda
-- acima virada invariante: a conversa fecha, o evento não nasce e a revisão não
-- anda).

create or replace function public.fn_demanda_abre_no_inbound()
returns trigger language plpgsql security definer set search_path=public as $fn$
begin
  -- A REAÇÃO NÃO É MENSAGEM RECEBIDA. Sem este corte, o INSERT da linha
  -- `type='reaction'` chamava `fn_service_inbound`, que reabre a conversa
  -- encerrada e abre uma demanda nova para um gesto que não é fala.
  if new.type = 'reaction' then
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
  -- desligar).
  if new.direction='inbound' and new.type <> 'reaction' then
    update public.conversations set reply_context_revision=reply_context_revision+1 where organization_id=new.organization_id and id=new.conversation_id and contact_id=new.contact_id;
  end if;
  return new;
end;$fn$;
revoke all on function public.fn_reply_inbound_revision() from public,anon,authenticated;

notify pgrst, 'reload schema';
