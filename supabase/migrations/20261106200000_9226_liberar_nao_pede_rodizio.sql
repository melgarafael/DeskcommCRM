-- 9226_liberar_nao_pede_rodizio — #3937, o item do botão "Liberar".
--
-- manifest: **"Liberar" não devolve a conversa ao rodízio na mesma transação (#3937, decisão do mantenedor: pedido C do relato).** O gatilho `trg_routing_assignment_changed` tratava "saiu do dono" e "reabriu" como o mesmo fato: qualquer UPDATE em que a conversa voltasse ao pool pedia `conversation.routing_requested`. Como "Liberar" (`fn_conversation_assign` com `p_to_user_id` nulo e `reason='release'`) é exatamente um UPDATE que tira o dono e devolve `status='open'`, a conversa liberada voltava a ter dono em ~1 minuto — medido pelo autor da issue: dezenas de conversas liberadas voltaram em menos de 2 minutos. A régua nova separa as duas portas: o pedido nasce só quando a conversa ENTRA no pool vindo de fora dele (`old.status` terminal ⇒ reabertura), e NÃO quando ela apenas perde o dono. O caminho de entrada na fila continua onde sempre esteve — `after insert on conversations` (migration 0040) e o `fn_request_channel_routing` das portas que querem pedir (`fn_wake_channel_routing` em disponibilidade, política e revogação de membro; o cron `rodizio-devolucao` pede explicitamente no passo 3). A conversa liberada fica sem dono, visível no Inbox, e volta à distribuição por um fato novo de verdade: mensagem do cliente (migration 9225), mudança de disponibilidade/capacidade, regra do número ou reabertura. Nada de objeto novo, nada de migration antiga reescrita: `create or replace` da função de gatilho e do corpo do aviso, mais o `drop trigger if exists`/`create trigger` de mesma assinatura. O aviso `routing_unassigned` também perde a frase "A distribuição continuará tentando", que a #3916 tornou falsa: com o estado terminal, o aviso é o RECIBO de uma conversa que parou de ser reagendada, não uma promessa de nova tentativa. Prova em `tests/invariants/liberar-nao-volta-ao-rodizio.test.ts` (Postgres efêmero, gatilho e funções reais).

-- ---- "Liberar" não pede o rodízio (issue #3937) ----
--
-- O gatilho é `after update of assigned_to_user_id,status`, e há DOIS fatos que
-- caem nele:
--
--   1. a conversa PERDE o dono e volta para `open` — é o "Liberar" (rota
--      `app/api/v1/conversations/[id]/release/route.ts:44-49` e o cron
--      `rodizio-devolucao`, que já pede o rodízio por conta própria no passo 3);
--   2. a conversa REABRE — `old.status` terminal (`closed`/`resolved`/
--      `archived`) e `new.status` de volta no pool. Aqui o pedido tem de
--      continuar nascendo: é o caminho que faz a conversa reaberta voltar a ser
--      distribuída.
--
-- A régua de baixo olha SÓ o `old.status`. Quem perde o dono já está no pool, e
-- "estava no pool e continua no pool" não é chegada — é o que a decisão do
-- mantenedor pediu: liberar tira a conversa do atendente e NÃO a devolve à
-- distribuição por causa disso.
--
-- As portas que hoje dependem de um pedido continuam com ele, e nenhuma delas
-- passa por este gatilho: `fn_wake_channel_routing` (disponibilidade, política
-- do número, revogação de membro) e o `fn_request_channel_routing` explícito do
-- cron de devolução ao rodízio.

create or replace function public.fn_routing_assignment_changed()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.assigned_to_user_id is not null or new.status not in('open','pending','claimed','ai_handling') then
  update public.agent_inbox_items set status='resolved' where organization_id=new.organization_id
   and kind='routing_unassigned' and ref_id=new.id and status<>'resolved';
 elsif old.status not in('open','pending','claimed','ai_handling') then
  perform public.fn_request_channel_routing(new.organization_id,new.id);
 end if;
 return new;
end;
$$;
revoke all on function public.fn_routing_assignment_changed() from public,anon,authenticated;
drop trigger if exists trg_routing_assignment_changed on public.conversations;
create trigger trg_routing_assignment_changed after update of assigned_to_user_id,status on public.conversations
 for each row execute function public.fn_routing_assignment_changed();

-- ---- o aviso deixa de prometer uma tentativa que não existe mais (#3916) ----
--
-- O corpo vinha da 0228 e dizia "A distribuição continuará tentando". Com o
-- estado terminal do #3916 isso passou a ser falso na única situação em que o
-- aviso nasce (o evento esgotou as tentativas e FECHOU). O texto novo diz o que
-- o operador precisa saber: a conversa está parada, sem responsável, e o que a
-- traz de volta é um fato novo — alguém assumir ou o cliente escrever de novo.
-- O `on conflict` e o índice `agent_inbox_routing_unique` continuam iguais: um
-- item por conversa, reaberto em vez de duplicado.

create or replace function public.fn_routing_unassigned_notice(p_org uuid,p_conversation uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.conversations where organization_id=p_org and id=p_conversation and assigned_to_user_id is null
  and status in('open','pending','claimed','ai_handling')) then return;end if;
 insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
 values(p_org,'routing_unassigned','warn','Uma conversa aguarda um responsável',
  case when p_reason='invalid_channel' then 'Confira o canal de origem desta conversa nas Conexões.'
   else 'Confira os responsáveis do canal em Configurações → Atendimento e a disponibilidade da equipe. A conversa segue na fila, sem responsável, até alguém assumir ou o cliente escrever de novo.' end,
  'conversation',p_conversation)
 on conflict(organization_id,ref_id,kind) where kind='routing_unassigned'
 do update set status='open',body=excluded.body;
end;
$$;
revoke all on function public.fn_routing_unassigned_notice(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_routing_unassigned_notice(uuid,uuid,text) to service_role;
