-- manifest: **A IA pode responder em grupo quando o operador libera na chave de cada grupo (issue #2729).** A 0482 trouxe os grupos para a inbox e fez o banco emitir `message.group_received` à parte de `message.received` — dois eventos diferentes para a mesma mensagem, porque consumidor nenhum de `message.received` (IA, follow-up, campanhas, automações) podia enxergar mensagem de grupo: a resposta automática num grupo de família é o defeito caro da regra antiga (PR #96, escuta dupla). O custo da separação foi o enunciado absoluto "a IA nunca responde em grupo": um grupo de clientes, com o operador respondendo à mão, não tem resposta nenhuma automática — e é a pergunta da issue. A peça é uma coluna POR GRUPO, `channel_session_groups.ia_responde boolean not null default false`: a IA só passa a responder no grupo em que o operador ligou a chave, e o default mantém o comportamento de 100% das instalações existentes. `NOT NULL default false` é a metade importante da régua: coluna que nasce sem nulo não aceita "não sei" por acidente, e `false` é exatamente o que quem nunca mexeu em nada queria dizer. Escrita pela rota `PUT /api/v1/channel-sessions/[id]/groups` (`ia_responde`), que é preferência LOCAL: não mexe no filtro do WhatsApp, não confirma nada com o transporte e não existe para grupo fora da fila (sem linha ligada não há mensagem para a IA responder — 409 `grupo_desligado`). Lida em dois lugares que não podem divergir: o ingest do grupo (`lib/grupos/ingest.ts`, que só pede o turno do agente para mensagem inbound de grupo com a chave ligada — o MESMO evento `ai_agent.dispatch_requested` da conversa individual, pelo MESMO consumidor) e o drain do motor (`lib/agent-engine/edge/crm/drain.ts`, que deixa de pular o evento). A régua é uma função só (`grupoLiberaIa`, `lib/grupos/ia-no-grupo.ts`: `=== true`, falha fechada para nulo/ausente), a primeira camada continua sendo o evento à parte `message.group_received` (nenhum outro consumidor passa a enxergar grupo), e as proteções de envio — janela de 24 h, ritmo, teto diário, silêncio pós-handoff, gate de elegibilidade, allowlist — seguem valendo normalmente, porque moram depois desta decisão. Sem backfill: `default false` já é o estado de todo mundo, e a migration não tem o que propagar. Idempotente (`add column if not exists` + comentário) e com `notify pgrst`. O MESMO bloco entra no `supabase/baseline.sql`, é o que o kit self-host aplica, install E update.

-- 0653: a chave por grupo "Permitir que a IA responda neste grupo" (issue #2729).

-- ---- a chave por grupo (migration 0653, issue #2729) ----
--
-- A regra antiga era absoluta e estava certa na época: a 0482 separou
-- `message.group_received` de `message.received` justamente para que IA,
-- follow-up, campanhas e automações não enxergassem mensagem de grupo (o
-- defeito do PR #96, escuta dupla). O que ela não previa é o grupo de CLIENTES
-- com atendimento parcialmente manual: o operador escreve o preço, a IA
-- confirma o horário, e ninguém escreve nada para "bom dia" de 40 pessoas.
--
-- A peça é uma coluna por grupo, na MESMA linha que já guarda "este grupo
-- entra na inbox":
--
--   enabled      quem entra na inbox (e mexe no filtro do WhatsApp)
--   ia_responde  quem a IA pode responder  ← esta migration
--
-- Duas chaves em vez de uma porque são decisões diferentes com custos
-- diferentes: ligar o grupo é barulho de notificação para todo mundo, ligar a
-- IA é fala em nome da empresa. Por isso o default é `false` — o estado de
-- quem nunca tocou em nada continua sendo o comportamento de sempre —, e por
-- isso a chave da IA só existe para grupo JÁ LIGADO (sem linha ligada não há
-- mensagem na inbox, logo não há nada para responder; a rota devolve
-- `grupo_desligado`).
--
-- Quem lê é o ingest do grupo (`lib/grupos/ingest.ts`), que para a mensagem
-- inbound só se a chave estiver ligada, e o drain do motor
-- (`lib/agent-engine/edge/crm/drain.ts`), que deixa de pular o evento. As duas
-- leituras passam pela MESMA função (`grupoLiberaIa`, `=== true`) — é a
-- divergência entre a régua local e a tela que já custou caro (0213/0480).
-- Nada de proteção de envio é contornada: janela, ritmo, teto, silêncio
-- pós-handoff e elegibilidade moram no turno, depois desta decisão.
--
-- Sem backfill e sem nulo: `not null default false` é o comportamento de
-- hoje escrito na coluna, e linha gravada antes da migration recebe o default
-- na própria `alter table` — que também é o motivo de o comparador ser
-- `=== true` e não "truthy": nulo que aparecer algum dia significa "não sei se
-- o operador liberou", e não sei não responde.

alter table public.channel_session_groups
  add column if not exists ia_responde boolean not null default false;

comment on column public.channel_session_groups.ia_responde is
  'A chave POR GRUPO "Permitir que a IA responda neste grupo" (issue #2729). DESLIGADA por padrão, que é o comportamento de sempre: a mensagem de grupo entra na inbox pela fila do grupo (enabled) e a IA não responde. LIGADA, o ingest do grupo pede o turno do agente (mesmo evento ai_agent.dispatch_requested da conversa individual) e o motor deixa de pular o evento — as proteções de envio (janela de 24h, ritmo, teto diário, silêncio pós-handoff, elegibilidade) seguem valendo. Não mexe no filtro do WhatsApp nem existe para grupo fora da fila: sem linha ligada não há mensagem para responder.';

notify pgrst, 'reload schema';
