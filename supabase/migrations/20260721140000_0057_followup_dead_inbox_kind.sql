-- 0057 — agent_inbox_items ganha o kind 'followup_dead' (Task 4.1: engine de
-- follow-up). Quando um enrollment esgota attempts ou estoura max_steps, o
-- worker precisa avisar a operação com um kind próprio (doutrina anti-silêncio
-- do sistema de follow-up — spec 2026-07-21 §4) em vez de cair no genérico
-- 'other'. Idempotente: drop + re-add do CHECK (nome default do Postgres pra
-- check inline de coluna única: <tabela>_<coluna>_check).

alter table agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in
    ('qr_rescan','job_dead','event_dead','budget_exceeded','handoff',
     'promotion_review','judge_unaligned','followup_dead','other'));
