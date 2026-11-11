-- 9332_liberar_nao_pede_rodizio — #3937, o item do botão "Liberar".
--
-- manifest: **"Liberar" não devolve a conversa ao rodízio na mesma transação (#3937, decisão do mantenedor: pedido C do relato).** O gatilho `trg_routing_assignment_changed` tratava "saiu do dono" e "reabriu" como o mesmo fato: qualquer UPDATE em que a conversa voltasse ao pool pedia `conversation.routing_requested`. Como "Liberar" (`fn_conversation_assign` com `p_to_user_id` nulo e `reason='release'`) é exatamente um UPDATE que tira o dono e devolve `status='open'`, a conversa liberada voltava a ter dono em ~1 minuto — medido pelo autor da issue: dezenas de conversas liberadas voltaram em menos de 2 minutos. A régua nova separa as duas portas: o pedido nasce só quando a conversa ENTRA no pool vindo de fora dele (`old.status` terminal ⇒ reabertura), e NÃO quando ela apenas perde o dono. O caminho de entrada na fila continua onde sempre esteve — `after insert on conversations` (migration 0040) e o `fn_request_channel_routing` das portas que querem pedir (`fn_wake_channel_routing` em disponibilidade, política e revogação de membro; o cron `rodizio-devolucao` pede explicitamente no passo 3). A conversa liberada fica sem dono, visível no Inbox, e volta à distribuição por um fato novo de verdade: mudança de disponibilidade/capacidade, regra do número ou reabertura. **Mensagem nova do cliente ainda NÃO a acorda:** esse caminho (o gatilho do #4113) e o teto de tentativas (#3916) ficaram fora deste recorte por decisão do dono (doc 309, alternativa A) e esperam os outros dois caminhos de volta — pedido de humano e abertura do horário. Nada de objeto novo, nada de migration antiga reescrita: `create or replace` da função de gatilho, mais o `drop trigger if exists`/`create trigger` de mesma assinatura. O aviso `routing_unassigned` NÃO muda: sem o teto de tentativas, a distribuição segue tentando e a frase dele continua verdadeira. Prova em `tests/invariants/liberar-nao-volta-ao-rodizio.test.ts` (Postgres efêmero, gatilho e funções reais).

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
