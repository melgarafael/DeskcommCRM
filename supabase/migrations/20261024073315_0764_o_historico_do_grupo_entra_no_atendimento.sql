-- manifest: carimba a recebida de GRUPO com a revisão de serviço e abre o episódio com service_started_at, para o histórico do grupo entrar no turno da IA (#2729)
--
-- #2729 — o histórico do grupo entra no atendimento.
--
-- O turno da IA monta o histórico em `getLeadContext`, e a régua dele é o
-- ATENDIMENTO CORRENTE: recebida só entra com `messages.service_revision =
-- c.service_revision`; enviada só entra com `messages.sent_at >=
-- c.service_started_at`. A conversa de grupo nascia fora dos dois:
--
--   (a) `fn_service_inbound` saía cedo quando a conversa era de grupo, ANTES de
--       carimbar a mensagem — toda recebida de grupo ficava com
--       `service_revision` nulo e sumia do histórico. Medido com a mesma função
--       que o turno usa (`getLeadContext`): grupo vinha vazio, o controle 1:1
--       vinha com as três mensagens.
--   (b) `criarConversaDoGrupo` (lib/grupos/ingest.ts) criava a conversa sem
--       `service_started_at`; `messages.sent_at >= NULL` é NULL, nunca verdade,
--       então TODA enviada ficava de fora.
--
-- A função abaixo é a MESMA de sempre (faixa do episódio, dono que fica,
-- boundary); muda só o ramo de grupo: ele não cria demanda — grupo continua sem
-- funil, como no desenho aprovado — mas carimba o episódio.
--
-- Idempotente: `create or replace` + `update ... where service_started_at is
-- null`. O backfill só preenche NULL com o instante da primeira mensagem (ou da
-- criação); não inventa revisão para mensagem antiga, porque revisão é
-- afirmação sobre o episódio e essas mensagens são de antes dele.

-- ---- histórico do grupo no atendimento (migration 0764) ----

-- Conversa de grupo que já existe nasce com o episódio datado na primeira
-- mensagem dela: sem isto o conserto só valeria para grupo NOVO.
update public.conversations c
   set service_started_at = coalesce(
         (select min(m.sent_at) from public.messages m
           where m.organization_id = c.organization_id and m.conversation_id = c.id),
         c.created_at)
 where c.service_started_at is null
   and (c.is_group or coalesce(c.group_chat_id,'') like '%@g.us');

-- Carimbo retroativo das recebidas de grupo em conversa ABERTA: sem isto o
-- histórico do grupo só passaria a existir para mensagem NOVA. Grupo não tem
-- funil, então não há episódio anterior a distinguir — o que está aberto é o
-- episódio corrente. Conversa encerrada fica de fora de propósito: ela pertence
-- a um episódio fechado, e quando reabrir começa outro (o carimbo vem na
-- reabertura, em `reabrirSeFechada`).
update public.messages m
   set service_revision = c.service_revision
  from public.conversations c
 where c.organization_id = m.organization_id
   and c.id = m.conversation_id
   and (c.is_group or coalesce(c.group_chat_id,'') like '%@g.us')
   and c.status not in ('closed','resolved','archived')
   and m.direction = 'inbound'
   and m.service_revision is null;

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
 -- #2729 — GRUPO: sem demanda (grupo não tem funil, como no desenho aprovado),
 -- mas COM o carimbo do episódio, que faltava e esvaziava o histórico do turno:
 -- `getLeadContext` só inclui recebida com `messages.service_revision =
 -- c.service_revision`, e a saída cedo daqui deixava TODA recebida de grupo com
 -- revisão nula.
 --
 -- A conversa ENCERRADA continua saindo cedo: quem reabre grupo é o ingest
 -- (`reabrirSeFechada`, em lib/grupos/ingest.ts), DEPOIS do insert, e carimbar
 -- aqui poria a mensagem no episódio VELHO — a revisão sobe na reabertura.
 if c.is_group or coalesce(c.group_chat_id,'') like '%@g.us' then
   if c.status in ('closed','resolved','archived') then return; end if;
   -- Conversa de grupo anterior a este carimbo nasce sem `service_started_at`, e
   -- `messages.sent_at >= NULL` nunca é verdade: toda enviada sairia do
   -- histórico. O campo passa a valer a partir da primeira mensagem que chega.
   if c.service_started_at is null then
     update public.conversations set service_started_at=m.sent_at
      where id=c.id and organization_id=c.organization_id returning * into c;
   end if;
   update public.messages set service_revision=c.service_revision
    where id=m.id and organization_id=c.organization_id;
   return;
 end if;

 if c.contact_id is distinct from m.contact_id
    or not exists(select 1 from public.contacts where id=m.contact_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(c.organization_id,c.contact_id);
 select * into c from public.conversations where id=m.conversation_id and organization_id=m.organization_id for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if m.sent_at <= c.service_closed_at then return; end if;
 reopened := c.status in ('closed','resolved','archived');
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
