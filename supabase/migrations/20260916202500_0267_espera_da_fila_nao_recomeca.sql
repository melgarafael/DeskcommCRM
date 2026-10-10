-- ============================================================================
-- 0267 — A espera na Fila não recomeça a cada mensagem do cliente (issue #990).
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
-- A aba Fila ordena por tempo de espera crescente, e a régua era
-- `conversations.last_inbound_at` — a ÚLTIMA mensagem do cliente. Essa coluna é
-- reescrita a cada mensagem nova (`fn_mark_conversation_message` faz
-- `greatest(last_inbound_at, p_at)`), então quem insiste volta para o fim da
-- fila: a espera dele "recomeça" a cada pergunta. Medido no cenário da issue —
-- A escreve 10h00, B escreve 10h05, A escreve 10h10 → hoje a Fila mostra B (a
-- que espera desde 10h05) NA FRENTE de A (que espera desde 10h00).
--
-- ─── A régua nova ──────────────────────────────────────────────────────────
-- "A mensagem do cliente mais antiga desde a última resposta enviada":
--
--     min(messages.sent_at) where direction='inbound' and sent_at > last_outbound_at
--
-- ─── Por que virou COLUNA, e não uma expressão na consulta ─────────────────
-- A ordem da Fila é um `order by` pedido ao PostgREST pela rota da lista
-- (`app/api/v1/conversations/_handler.ts`), e o PostgREST ordena por COLUNA: a
-- expressão acima mora em `messages` e depende de `last_outbound_at` da
-- conversa, então ordenar por ela exigiria uma view nova no lugar da tabela —
-- o que mudaria toda leitura do Inbox, não só a Fila. `last_inbound_at` já é a
-- mesma denormalização (escrita pelo mesmo trigger) desde a 0027.
--
-- ─── E quando não há mensagem sem resposta? ────────────────────────────────
-- Aí a coluna carrega `last_inbound_at`, que é o que a Fila usava antes desta
-- migration. Essas linhas (tudo respondido, ou conversa que entrou na Fila por
-- handoff depois de respondida) nunca tiveram o defeito da #990, e o valor
-- mantém ordem, pílula "Aguardando há…" e posição das ferramentas de IA
-- apontando para o MESMO instante — as três leem esta coluna. Sem esse
-- preenchimento a linha ficaria NULL, e NULL ordena por último: a conversa que
-- hoje aparece no meio da fila cairia para o fim na atualização.
--
-- ─── Preenchimento das conversas que já existem ────────────────────────────
-- Duas passadas, e a ordem é o que segura o custo numa base grande:
--
--   1. quem NÃO tem mensagem sem resposta (a conversa já respondida) recebe o
--      valor de hoje — `last_inbound_at` — sem consultar `messages` nenhuma vez;
--   2. quem TEM recebe o começo da espera, com um `min()` POR CONVERSA, servido
--      por `idx_messages_conversation_sent (conversation_id, sent_at DESC)`.
--
-- Ou seja: a parte cara é proporcional às conversas QUE ESTÃO ESPERANDO, não ao
-- tamanho de `messages`. Idempotente pela própria guarda — a segunda aplicação
-- não encontra linha com `awaiting_since is null`.
-- ============================================================================

alter table public.conversations add column if not exists awaiting_since timestamptz;

comment on column public.conversations.awaiting_since is
  'Desde quando o cliente espera resposta: o instante da mensagem DELE mais antiga que ninguém respondeu ainda (min(sent_at) dos inbound posteriores a last_outbound_at, no atendimento em curso). É a régua da Fila — a ordem da lista, a pílula "Aguardando há…" da linha e a posição entregue às ferramentas de IA leem esta coluna, e é isso que faz a ordem da tela e o número dito ao cliente não divergirem. last_inbound_at (a ÚLTIMA mensagem) reinicia a cada mensagem e fazia quem insiste descer para o fim da fila (issue #990); esta coluna mantém o começo da espera. Quando não há mensagem sem resposta — a bola está com o cliente —, carrega last_inbound_at, que é o que a Fila usava antes desta migration.';

update public.conversations c
set awaiting_since = c.last_inbound_at
where c.awaiting_since is null
  and c.last_inbound_at is not null
  and c.last_outbound_at is not null
  and c.last_inbound_at <= c.last_outbound_at;

update public.conversations c
set awaiting_since = coalesce(
  (
    select min(m.sent_at)
    from public.messages m
    where m.conversation_id = c.id
      and m.direction = 'inbound'
      and m.sent_at > coalesce(c.last_outbound_at, '-infinity'::timestamptz)
      and m.sent_at > coalesce(c.service_closed_at, '-infinity'::timestamptz)
  ),
  c.last_inbound_at
)
where c.awaiting_since is null
  and c.last_inbound_at is not null
  and (c.last_outbound_at is null or c.last_inbound_at > c.last_outbound_at);

create or replace function public.fn_mark_conversation_message(p_conv uuid,p_direction text,p_preview text,p_at timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare c public.conversations; pre_contact uuid;
begin
 select * into c from public.conversations where id=p_conv;
 if not found then return; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(c.organization_id,c.contact_id);
 select * into c from public.conversations where id=p_conv for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if p_direction='inbound' and p_at<=c.service_closed_at then return; end if;
 update public.conversations set
  last_message_at=greatest(last_message_at,p_at),
  last_message_preview=case when last_message_at is null or p_at>=last_message_at then p_preview else last_message_preview end,
  last_inbound_at=case when p_direction='inbound' then greatest(last_inbound_at,p_at) else last_inbound_at end,
  last_outbound_at=case when p_direction='outbound' then greatest(last_outbound_at,p_at) else last_outbound_at end,
  unread_count_for_assignee=case when p_direction='inbound' then unread_count_for_assignee+1 when p_direction='outbound' then 0 else unread_count_for_assignee end,
  -- A régua da Fila (issue #990). Os três ramos do inbound, na ordem:
  --   1. mensagem ATRASADA (escrita antes da última resposta) — já respondida,
  --      não é espera: mantém o que havia;
  --   2. a espera guardada é de uma mensagem SEM RESPOSTA deste atendimento —
  --      o cliente insistiu: fica o começo da espera, o mais ANTIGO dos dois;
  --   3. não havia espera (tudo respondido) ou ela é de um atendimento já
  --      encerrado: a espera de agora começa nesta mensagem.
  -- E o outbound: resposta anterior à espera guardada não a responde (fora de
  -- ordem, mantém); qualquer outra responde tudo até aqui, e a coluna volta ao
  -- last_inbound_at — "não há mensagem sem resposta".
  awaiting_since=case
    when p_direction='inbound' then
      case
        when p_at<=coalesce(c.last_outbound_at,'-infinity'::timestamptz) then
          coalesce(c.awaiting_since,greatest(coalesce(c.last_inbound_at,'-infinity'::timestamptz),p_at))
        when c.awaiting_since>coalesce(c.last_outbound_at,'-infinity'::timestamptz)
         and c.awaiting_since>coalesce(c.service_closed_at,'-infinity'::timestamptz) then
          least(c.awaiting_since,p_at)
        else p_at
      end
    else
      case
        when c.awaiting_since is not null and p_at<c.awaiting_since then c.awaiting_since
        else c.last_inbound_at
      end
  end
 where id=p_conv and organization_id=c.organization_id;
 update public.contacts set last_activity_at=greatest(last_activity_at,p_at)
 where id=c.contact_id and organization_id=c.organization_id;
end; $$;
revoke execute on function public.fn_mark_conversation_message(uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_mark_conversation_message(uuid,text,text,timestamptz) to service_role;


-- A MESMA REGUA no espelho da cadeia: `apendice-do-baseline-nao-diverge-da-cadeia`
-- exige que a ultima definicao da CADEIA e a do APENDICE tenham o mesmo corpo —
-- sem esta copia, quem aplica a cadeia ficaria com a coluna antiga congelada.
create or replace function public.fn_reply_record_receipt(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz,p_message uuid,p_external text,p_echo_ids text[] default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare contact uuid;d public.ai_reply_drafts;m public.messages;
begin
 select contact_id into contact from public.job_queue where organization_id=p_org and id=p_job;
 if contact is null then return null;end if;
 perform public.fn_service_lock(p_org,contact);
 perform 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized for share;
 if not found then return null;end if;
 select * into d from public.ai_reply_drafts where organization_id=p_org and send_job_id=p_job;
 if not found then return null;end if;
 perform 1 from public.conversations where organization_id=p_org and id=d.conversation_id and contact_id=contact for no key update;
 if not found then return null;end if;
 perform 1 from public.job_queue where organization_id=p_org and id=p_job for update;
 perform 1 from public.ai_reply_drafts where organization_id=p_org and id=d.id for update;
 if public.fn_reply_receipt_policy(p_org,p_job,p_worker,p_acquired_at)->>'current'<>'true' then return null;end if;
 select * into m from public.messages where organization_id=p_org and id=p_message and conversation_id=d.conversation_id and contact_id=d.contact_id and channel_session_id=d.channel_session_id and direction='outbound' and type='text' and body=d.approved_body and exists(select 1 from public.send_ledger l where l.organization_id=p_org and l.job_id=p_job and l.seq=1 and l.id::text=messages.metadata->>'idempotency_key') for update;
 if not found then return null;end if;
 delete from public.messages where organization_id=p_org and conversation_id=d.conversation_id and sent_via='external_device' and external_id=any(p_echo_ids) and id<>p_message;
 update public.messages set status='sent',external_id=p_external,ack=0 where organization_id=p_org and id=p_message returning * into m;
 update public.send_ledger set status='accepted',crm_message_id=p_message,updated_at=now(),last_error=null where organization_id=p_org and job_id=p_job and seq=1 and id::text=m.metadata->>'idempotency_key';
 -- A resposta aprovada é uma SAÍDA: responde tudo até aqui, e a régua da Fila
 -- (issue #990, migration 0267) volta ao `last_inbound_at` — "não há mensagem do
 -- cliente sem resposta". Sem esta coluna o valor antigo ficaria congelado e a
 -- conversa continuaria contando a espera que esta resposta acabou de encerrar.
 update public.conversations set last_outbound_at=now(),last_message_at=now(),last_message_preview=left(d.approved_body,280),unread_count_for_assignee=0,awaiting_since=last_inbound_at where organization_id=p_org and id=d.conversation_id;
 update public.contacts set last_activity_at=now() where organization_id=p_org and id=contact;
 return to_jsonb(m);
end;$$;
revoke all on function public.fn_reply_record_receipt(uuid,uuid,text,timestamptz,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.fn_reply_record_receipt(uuid,uuid,text,timestamptz,uuid,text,text[]) to service_role;

notify pgrst, 'reload schema';
