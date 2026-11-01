-- manifest: A passagem de conversa de um agente de IA para outro ganha trilha própria: `ai_router_decisions.outcome` aceita `transferred` (desfecho da AÇÃO, distinto de `reclassified`, que é o do classificador) e a tabela ganha `origem` (`classificador`/`acao`), `agente_anterior_id`, `motivo` (vocabulário fechado) e `solicitado_por` — quem pediu, de qual agente para qual, quando e por quê, sem texto livre e sem PII (#3770).
--
-- 9064 — a ação explícita de transferência entre agentes de IA (#3770).
--
-- ─── Por que uma coluna e um valor de `outcome`, e não `reclassified` ──────
--
-- Com roteador sticky a passagem JÁ acontece, mas só quando o classificador
-- acerta a `intent_description` de outro membro — o desfecho é `reclassified`
-- e a trilha não distingue "o modelo decidiu" de "alguém pediu". A ação
-- explícita (`transferirAgenteDaConversa`, `lib/agent-engine/agent/`) precisa
-- dizer as duas coisas numa linha: QUE foi uma ação (`origem = 'acao'`,
-- `outcome = 'transferred'`) e QUEM pediu, de onde para onde, por quê.
--
-- `reclassified` continua significando exatamente o que significava: o
-- classificador trocou o agente. Quem lê a trilha hoje (`app/api/v1/ai/evolution`
-- e `lib/ai/evolution/aggregate.ts`) não muda de comportamento: `transferred`
-- não entra na conta de "roteamento classificado".
--
-- ─── Sem texto livre ──────────────────────────────────────────────────────
--
-- O contrato da tabela desde a 0085 é "sem PII — o texto do lead nunca entra
-- aqui", e ela é lida por toda a organização. Por isso `motivo` é vocabulário
-- FECHADO (par TypeScript em `transferir-agente.ts`:
-- `MOTIVOS_DA_TRANSFERENCIA_DE_AGENTE`) e não prosa escrita pelo modelo, que
-- seria justamente a porta de entrada de PII.
--
-- `solicitado_por` é o usuário que pediu, quando a ação parte de uma pessoa.
-- Sem FK de propósito: a coluna pode receber um id de usuário de outra
-- instalação/tenant legado, e uma FK para `auth.users` faria `delete` de conta
-- mexer em trilha append-only. `agente_anterior_id`, esse sim, aponta para
-- `ai_agents` com `on delete set null`, como `agent_id` já faz.
--
-- Aditiva e idempotente: nada de backfill (linhas antigas ficam com
-- `origem = 'classificador'`, que é a verdade — todas nasceram do classificador
-- ou do sticky dele), nenhuma linha reescrita.

alter table public.ai_router_decisions
  drop constraint if exists ai_router_decisions_outcome_check;
-- IMPORTANTE — por que `= any (array[...])` e não `in (...)`:
-- a cerca `tests/unit/desfecho-da-captacao-um-vocabulario-so.test.ts` acha o
-- CHECK de `webhook_lead_captures.outcome` pela ÚLTIMA ocorrência, no
-- `baseline.sql` inteiro, da grafia `outcome` + `in (...)`. Um apêndice novo, no fim do
-- arquivo, com essa mesma grafia para OUTRA tabela cega a cerca (ela passa a
-- ler o vocabulário do roteador e acusa três defeitos que não existem). As duas
-- formas viram a MESMA constraint no catálogo (`pg_get_constraintdef` normaliza
-- `in (...)` para `= any (array[...])`), então a verdade do banco não muda —
-- muda só o que a cerca enxerga. A fragilidade da cerca fica registrada no PR.
alter table public.ai_router_decisions
  add constraint ai_router_decisions_outcome_check
  check (outcome = any (array['classified', 'sticky', 'reclassified', 'fallback', 'no_match', 'classifier_failed', 'transferred']));

-- POR ONDE a decisão entrou: o classificador (o de sempre, e o sticky que ele
-- mantém) ou uma AÇÃO explícita. É a coluna que separa os dois mundos sem
-- precisar cruzar `outcome` com `intent_name`.
alter table public.ai_router_decisions
  add column if not exists origem text not null default 'classificador';
alter table public.ai_router_decisions
  drop constraint if exists ai_router_decisions_origem_check;
alter table public.ai_router_decisions
  add constraint ai_router_decisions_origem_check
  check (origem in ('classificador', 'acao'));

-- DE QUAL agente a conversa saiu (`null` = ela ainda não tinha agente ativo).
alter table public.ai_router_decisions
  add column if not exists agente_anterior_id uuid references ai_agents(id) on delete set null;

-- POR QUE a passagem aconteceu — vocabulário fechado, sem texto livre.
alter table public.ai_router_decisions
  add column if not exists motivo text;
alter table public.ai_router_decisions
  drop constraint if exists ai_router_decisions_motivo_check;
alter table public.ai_router_decisions
  add constraint ai_router_decisions_motivo_check
  check (motivo is null or motivo in ('pedido_do_agente', 'pedido_do_operador', 'regra_de_automacao'));

-- QUEM pediu, quando foi uma pessoa.
alter table public.ai_router_decisions
  add column if not exists solicitado_por uuid;
