-- 0065 — Reconcilia agent_inbox_items_kind_check após o merge feat/followup-flows ↔ main.
-- A 0057 (followup_dead) e a 0062 (snooze_expired) BROTARAM em branches paralelas e
-- ambas re-criam a MESMA constraint via drop/re-add — a última a rodar (0062 > 0057)
-- vencia e derrubava o `followup_dead`, quebrando o markDead do motor de follow-up.
-- Forward-fix: uma re-criação final com a UNIÃO de todos os kinds. Idempotente.
alter table agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in
    ('qr_rescan','job_dead','event_dead','budget_exceeded','handoff',
     'promotion_review','judge_unaligned','followup_dead','snooze_expired','other'));
