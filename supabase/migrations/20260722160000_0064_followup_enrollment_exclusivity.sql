-- 0064 — Task 8.6: UM follow-up vivo por lead ORG-WIDE + agent_id no enrollment.
--
-- Furo achado pelo Rafael (walkthrough): o índice unique-live era
-- (pointer_id, contact_id) — impede duplicata no MESMO fluxo, mas NÃO entre
-- fluxos. A varredura de silêncio itera TODOS os pointers de silêncio ativos e
-- enrollava o mesmo contato em CADA um → um lead silencioso que casa N fluxos
-- vira N sequências paralelas = spam. Decisão do Rafael: exclusividade
-- 1-por-lead na ORG (índice vira (organization_id, contact_id)).
--
-- Idempotente + psql-puro (sem BEGIN/COMMIT — o runner envolve em transação).

-- (a) DEDUP FIRST — self-host-safe. O novo índice único parcial (org, contact)
--     falha se já houver >1 enrollment VIVO para o mesmo (org, contact). Para
--     qualquer (org, contact) com mais de um vivo, mantém o de started_at MAIS
--     RECENTE e cancela os demais. Genérico (window function, sem ids
--     hardcoded) — roda ANTES de criar o índice, senão o update.sh de um clone
--     com dados sujos quebra.
with ranked as (
  select id,
         row_number() over (
           partition by organization_id, contact_id
           order by started_at desc, id desc
         ) as rn
  from followup_enrollments
  where status in ('active', 'waiting_reply', 'paused_handoff')
)
update followup_enrollments e
set status = 'cancelled',
    cancel_reason = 'exclusivity_backfill',
    next_eval_at = null,
    updated_at = now()
from ranked
where e.id = ranked.id
  and ranked.rn > 1;

-- (b) troca o unique-live de (pointer_id, contact_id) → (organization_id,
--     contact_id). MESMO nome de índice (baseline/comentários seguem coerentes);
--     a cláusula WHERE não muda, só as colunas.
drop index if exists idx_followup_enrollments_one_live;
create unique index if not exists idx_followup_enrollments_one_live
  on followup_enrollments (organization_id, contact_id)
  where status in ('active', 'waiting_reply', 'paused_handoff');

-- (c) agent_id: qual agente ARMOU o fluxo (o fluxo é habilitado por um agente
--     publicado via ai_agent_versions.followup — 0061). Registra pra fila
--     mostrar e a persona ser fixada. on delete set null: apagar o agente não
--     apaga o histórico do enrollment.
alter table followup_enrollments
  add column if not exists agent_id uuid references ai_agents(id) on delete set null;
create index if not exists idx_followup_enrollments_agent
  on followup_enrollments (agent_id);
