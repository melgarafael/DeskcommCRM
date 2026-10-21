-- manifest: **A conversa fechada volta a reabrir quando a mensagem do cliente chega FORA DE ORDEM (issue #3015).** `fn_service_inbound` descartava a mensagem antes de decidir a reabertura: `if m.sent_at <= c.service_closed_at then return; end if` vinha ANTES de `reopened := c.status in ('closed','resolved','archived')`. Quando o webhook entrega uma mensagem cujo `sent_at` é anterior ao fechamento — entrega atrasada do canal, lote do provider, relógio do aparelho atrás —, o guard devolvia cedo e NADA acontecia: a conversa do par (contato, canal) seguia `closed` com a mensagem dentro, o Inbox não a mostrava (a aba Fila filtra por `comando_da_conversa = 'aguardando'`, e `closed` vira `encerrada`) e o cliente ficava sem resposta, sem erro em lugar nenhum. Medido numa sonda de banco real: canal B fechado 30 min antes, mensagem com `sent_at` de 1h atrás → B permanecia `closed`/`encerrada` e fora da Fila. O conserto move o guard para DEPOIS do cálculo de `reopened` e o restringe ao caminho que NÃO é reabertura: mensagem nova em conversa encerrada reabre o atendimento pela ordem de CHEGADA, não pela ordem do `sent_at`, e o `sent_at` continua sendo o que ordena a timeline e o que carimba `service_started_at`. O que o guard protegia continua protegido: reentrega da MESMA linha não reabre (o `m.service_revision is not null` do topo e o índice único por `external_id`), e a segunda mensagem atrasada de um episódio já reaberto não reabre de novo (a conversa já está `open`, então o guard volta a valer). Recorte por par (contato, canal) intacto. `create or replace`, sem tabela/coluna/policy/dado novo; apêndice idempotente no `baseline.sql`.

-- 0717 — a reabertura para de depender da ORDEM do `sent_at` (issue #3015).
--
-- ## O defeito
--
-- `fn_upsert_wa_conversation` (o upsert do par contato+canal que a ingestão usa)
-- devolve a conversa FECHADA quando ela já existe, com `insert … on conflict do
-- update set updated_at = now()`. Quem reabre é `fn_service_inbound`, disparado
-- por `trg_demanda_abre_no_inbound` no INSERT da mensagem. Só que ele fazia:
--
--   if m.sent_at <= c.service_closed_at then return; end if;
--   reopened := c.status in ('closed','resolved','archived');
--
-- Ou seja: a decisão de reabrir era tomada pela ORDEM do `sent_at` do payload
-- do canal. Mensagem que chega depois do fechamento mas foi enviada ANTES dele
-- (entrega atrasada, lote do provider, relógio do aparelho do cliente atrás) era
-- descartada em silêncio — e a conversa seguia encerrada com a mensagem dentro.
--
-- ## O que muda
--
-- O guard passa a valer só quando NÃO há reabertura em jogo:
--
--   reopened := c.status in ('closed','resolved','archived');
--   if not reopened and m.sent_at <= c.service_closed_at then return; end if;
--
-- Conversa encerrada + mensagem inbound nova ⇒ reabre, com `sent_at` anterior ou
-- não. `sent_at` continua sendo o que ordena a timeline e o que carimba
-- `service_started_at` do episódio novo — o que deixa de ser verdade é que ele
-- decida QUEM espera resposta.
--
-- ## O que o guard protegia, e continua protegido
--
-- 1 · REENTREGA. A mesma mensagem reentregue pelo canal não abre episódio novo:
--     o topo do `fn_service_inbound` devolve cedo quando `m.service_revision is
--     not null` (a linha já foi carimbada), e a ingestão nem cria linha nova
--     (`messages` tem índice único por `organization_id, external_id`, e o
--     `23505` é tratado como dedup em `lib/waha/ingest.ts`).
-- 2 · ORDEM DENTRO DE UM MESMO EPISÓDIO. Depois da primeira reabertura a
--     conversa está `open`, então uma SEGUNDA mensagem atrasada do mesmo
--     episódio cai no ramo `not reopened` e o guard volta a valer — nenhuma
--     reabertura dupla, nenhum `service_revision` somando duas vezes por causa
--     da mesma rajada.
-- 3 · AGREGADOS DE CONVERSA ABERTA. Mensagem atrasada em conversa aberta não
--     vira "última atividade": o ramo `not reopened` mantém exatamente o
--     comportamento anterior (o mesmo critério que `fn_mark_conversation_message`
--     usa, por outro caminho, para `last_message_at`/`awaiting_since`).
-- 4 · ESCOPO. Nada muda no recorte: a decisão é sempre da conversa do par
--     (contato, canal) da mensagem, e nenhuma outra conversa do contato é lida
--     ou tocada.
--
-- ## Invariantes preservados
--
-- `service_revision` continua incrementando UMA vez por reabertura (é ela que
-- invalida o trabalho do episódio encerrado), `service_closed_at` continua sendo
-- o instante do fechamento — a reabertura NÃO o limpa, é a fronteira do
-- episódio que terminou —, e `service_started_at` recebe o `sent_at` da mensagem
-- que reabriu, como já recebia. As duas metades do gatilho (`trg_service_stamp_status`
-- e `trg_service_reopened_routing`) seguem intocadas.

create or replace function public.fn_service_inbound(p_message uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
 m public.messages;
 c public.conversations;
 d public.demandas;
 reopened boolean;
 keep_owner boolean;
 pre_contact uuid;
begin
 select * into m from public.messages where id = p_message;
 if not found or m.direction <> 'inbound' or m.service_revision is not null then return; end if;
 select * into c from public.conversations where id = m.conversation_id;
 if not found or c.organization_id is distinct from m.organization_id
    or c.channel_session_id is distinct from m.channel_session_id
    or not exists(select 1 from public.channel_sessions where id=m.channel_session_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 if c.is_group or coalesce(c.group_chat_id,'') like '%@g.us' then return; end if;
 if c.contact_id is distinct from m.contact_id
    or not exists(select 1 from public.contacts where id=m.contact_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(c.organization_id,c.contact_id);
 select * into c from public.conversations where id=m.conversation_id and organization_id=m.organization_id for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
-- A ORDEM do `sent_at` decide se uma mensagem atrasada entra no episódio em
-- curso — nunca se um cliente que escreveu depois do fechamento volta a ser
-- atendido (issue #3015). Só o caminho que NÃO reabre devolve cedo.
 reopened := c.status in ('closed','resolved','archived');
 if not reopened and m.sent_at <= c.service_closed_at then return; end if;
 -- Só quando a empresa ligou "a conversa fica com quem atendeu". O caminho é o
 -- de lib/schemas/routing.ts, e só o booleano true liga: chave ausente ou com
 -- outro valor = o comportamento de sempre (volta para a fila).
 keep_owner := reopened and c.assigned_to_user_id is not null
   and coalesce((select o.settings->'routing'->'conversation_stays_with_attendant' = 'true'::jsonb
                   from public.organizations o where o.id = c.organization_id), false)
   and coalesce(public.fn_member_role_in_org(c.assigned_to_user_id,c.organization_id),'none')
     in ('agent','manager','admin');
 if not reopened then
   select x.* into d from public.demandas x join public.demanda_conversas dc on dc.demanda_id=x.id
    where x.id=c.current_demanda_id and x.organization_id=c.organization_id and x.contact_id=c.contact_id
      and dc.organization_id=c.organization_id and dc.conversation_id=c.id
      and dc.service_revision=c.service_revision and x.fechada_em is null;
 end if;
 if d.id is null then
   insert into public.demandas
     (organization_id,contact_id,aberta_em,origem,estado,dono_kind,dono_user_id,proximo_passo)
    values(c.organization_id,c.contact_id,m.sent_at,'inbound','aberta',
      case when keep_owner then 'humano' else 'ia' end,
      case when keep_owner then c.assigned_to_user_id else null end,
      'Responder à nova mensagem do cliente') returning * into d;
 end if;
 if reopened then
   update public.conversations set
     status=case when keep_owner then 'claimed' else 'open' end,
     status_changed_at=clock_timestamp(),
     service_revision=service_revision+1,service_started_at=m.sent_at,
     assigned_to_user_id=case when keep_owner then c.assigned_to_user_id else null end,
     -- O relógio do episódio NOVO, não o do encerrado: o prazo de devolução
     -- automática à IA (handoff_return_after_minutes) conta a partir do
     -- último sinal humano, e assigned_at é um deles. Guardar o do episódio
     -- antigo devolveria a conversa à IA no primeiro tick do cron.
     assigned_at=case when keep_owner then clock_timestamp() else null end,
     assignee_kind=case when keep_owner then 'user' else null end,
     bot_silenced_until=case when keep_owner then 'infinity'::timestamptz else c.bot_silenced_until end,
     active_ai_agent_id=null,
     current_demanda_id=d.id
    where id=c.id and organization_id=c.organization_id returning * into c;
 else
   update public.conversations set
     service_revision=service_revision+case when current_demanda_id is not null and current_demanda_id<>d.id then 1 else 0 end,
     service_started_at=case when current_demanda_id is not null and current_demanda_id<>d.id then m.sent_at else coalesce(service_started_at,m.sent_at) end,
     current_demanda_id=d.id
    where id=c.id and organization_id=c.organization_id returning * into c;
 end if;
 insert into public.demanda_conversas(organization_id,demanda_id,conversation_id,service_revision)
  values(c.organization_id,d.id,c.id,c.service_revision) on conflict(demanda_id,conversation_id)
  do update set service_revision=excluded.service_revision;
 update public.messages set service_revision=c.service_revision,demanda_id=d.id,demanda_revision=d.revision
  where id=m.id and organization_id=c.organization_id;
end; $$;
revoke execute on function public.fn_service_inbound(uuid) from public,anon,authenticated;
grant execute on function public.fn_service_inbound(uuid) to service_role;
