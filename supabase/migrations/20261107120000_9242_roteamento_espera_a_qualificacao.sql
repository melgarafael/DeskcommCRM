-- manifest: **A passagem para humano devolve a conversa à fila UMA vez (#3966).** Com rodízio ou carga ligados, a conversa era distribuída no NASCIMENTO (`trg_conversation_routing_requested`, AFTER INSERT) e o `routing-worker` a entregava antes de a IA terminar de qualificar: a atribuição grava `assignee_kind = 'user'` e o gate calava o agente (`conversa_de_humano`). O worker agora pula enquanto há agente de IA publicado atendendo o número e a conversa não passou por handoff (`lib/routing/qualificacao-da-ia.ts`), e o evento do nascimento morre consumido. Faltava a outra metade: `fn_routing_assignment_changed` não pedia roteamento na transição `ai_handling → pending` que `performHumanHandoff` grava, então a conversa que esperou a IA nunca entrava na fila. O gatilho passa a disparar também em `last_handoff_at` e a pedir o roteamento quando ele muda — o marcador durável de "a qualificação terminou", gravado pelos DOIS caminhos de passagem (motor nativo e `crm_request_human_handoff`) e limpo pelo `reactivate-bot`. `fn_request_channel_routing` já deduplica por `(organization_id, entity_id)` enquanto o pedido está pendente: um handoff, um pedido. Quem não tem IA ligada não é tocado — o worker distribui no nascimento como sempre. Corpo idêntico ao da 0228 mais o ramo novo; gatilho recriado com a coluna. Gate: `tests/invariants/roteamento-espera-a-qualificacao.test.ts`.
--
-- 9242 — A PASSAGEM PARA HUMANO PEDE O ROTEAMENTO UMA VEZ (#3966).
--
-- ─── O defeito, medido ──────────────────────────────────────────────────────
--
-- Com rodízio/carga ligados, `trg_conversation_routing_requested` (AFTER INSERT
-- em conversations) emite `conversation.routing_requested` e o `routing-worker`
-- entrega a conversa a uma pessoa em menos de 1 min — antes de a IA qualificar.
-- A atribuição grava `assignee_kind = 'user'` e o gate da IA cala o agente com o
-- motivo `conversa_de_humano` (`lib/ai/elegibilidade/gate.ts`): a própria fila
-- desligava a IA que deveria qualificar.
--
-- O lado TS desta migration (`lib/routing/qualificacao-da-ia.ts` + `decide.ts`)
-- faz o worker PULAR enquanto a IA está qualificando. Só que o evento do
-- nascimento é consumido nesse pulo — e nada o reemite quando a IA termina:
--
--   · `performHumanHandoff` (`lib/agent-engine/agent/human-handoff.ts`) grava
--     `status = 'pending'` e `last_handoff_at = now()` num ÚNICO UPDATE;
--   · `fn_routing_assignment_changed` só pedia roteamento quando a conversa
--     VOLTAVA a ficar sem dono (`old.assigned_to_user_id is not null` ou
--     `old.status` fora da lista). `ai_handling → pending` não é nenhum dos
--     dois: a conversa que esperou a IA ficava sem fila, com a IA calada.
--
-- ─── O conserto: o handoff é um pedido de fila ─────────────────────────────
--
-- `last_handoff_at` é o marcador DURÁVEL de "a qualificação terminou": quem o
-- grava são os dois caminhos de passagem (o motor nativo e
-- `crm_request_human_handoff`, que usa a mesma `triggerHandoff`), e quem o
-- limpa é o `reactivate-bot` (`lib/escalacao/retomada.ts`) quando a IA volta a
-- atender — então um episódio novo de qualificação volta a adiar.
--
-- O gatilho passa a cobrir a coluna e o corpo a pedir o roteamento quando
-- `last_handoff_at` muda. UMA vez: `fn_request_channel_routing` já deduplica por
-- `(organization_id, entity_id)` no índice parcial de `conversation.routing_requested`
-- com status `pending`/`processing` — handoff repetido enquanto o pedido está na
-- fila atualiza `next_attempt_at`, não cria linha nova.
--
-- Para quem não tem agente de IA nada muda: o worker distribui no nascimento
-- (o pulo exige agente publicado atendendo o número) e o ramo novo só dispara
-- quando um handoff de verdade acontece.
--
-- Idempotente (`create or replace` + gatilho recriado). Espelho no
-- `baseline.sql`, antes da VARREDURA anon (a função é criada aqui).
-- Gate: `tests/invariants/roteamento-espera-a-qualificacao.test.ts`.

create or replace function public.fn_routing_assignment_changed()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.assigned_to_user_id is not null or new.status not in('open','pending','claimed','ai_handling') then
  update public.agent_inbox_items set status='resolved' where organization_id=new.organization_id
   and kind='routing_unassigned' and ref_id=new.id and status<>'resolved';
 elsif old.assigned_to_user_id is not null or old.status not in('open','pending','claimed','ai_handling')
    -- #3966: a PASSAGEM PARA HUMANO tira a conversa do comando da IA. Sem este
    -- ramo, o pedido do nascimento já foi consumido (a IA qualificava) e a
    -- conversa nunca entrava na fila: a IA ficava calada e ninguém recebia.
    or (new.last_handoff_at is not null and new.last_handoff_at is distinct from old.last_handoff_at) then
  perform public.fn_request_channel_routing(new.organization_id,new.id);
 end if;
 return new;
end;
$$;
revoke all on function public.fn_routing_assignment_changed() from public,anon,authenticated;

drop trigger if exists trg_routing_assignment_changed on public.conversations;
create trigger trg_routing_assignment_changed after update of assigned_to_user_id,status,last_handoff_at on public.conversations
 for each row execute function public.fn_routing_assignment_changed();

notify pgrst, 'reload schema';
