-- 0100 — agent_case_events.kind ganha 'agent_noted'
--
-- Por quê: o agente conseguia ABRIR um chamado e nada mais. Não havia como ele
-- registrar o que aconteceu depois — "o cliente respondeu isto", "tentei aquilo e
-- não resolveu" — e o CHECK de `kind` não tinha nenhum valor honesto para isso:
-- 'lead_provided' é a informação que o LEAD deu por meio da tool de atualização,
-- 'human_replied' é a pessoa. Reusar qualquer um dos dois faria a linha do tempo
-- do chamado mentir sobre quem agiu.
--
-- Sem esse registro, a pessoa seguinte que abre o chamado começa do zero — que é
-- exatamente a descontinuidade que o pacote de escalação existe para fechar.
--
-- Idempotente e portável em psql puro: drop-if-exists + add da constraint com a
-- lista completa. Nenhum dado existente viola a lista nova (ela só CRESCE), então
-- não há backfill a fazer antes.

alter table public.agent_case_events
  drop constraint if exists agent_case_events_kind_check;

alter table public.agent_case_events
  add constraint agent_case_events_kind_check check (kind in (
    'opened',
    'human_replied',
    'lead_asked',
    'lead_provided',
    'lead_unresponsive',
    'resolved',
    'escalated',
    'cancelled',
    'agent_noted'
  ));
