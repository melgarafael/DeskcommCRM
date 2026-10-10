-- 0090 — Índice único parcial: no máximo 1 run "dispatched" por vez.
--
-- A rota /api/v1/system/agent (task 4) e a futura rota de disparo (task 5)
-- precisam poder CONFIAR nisso como garantia de banco, não como expectativa
-- de aplicação — um check-then-insert sem constraint é TOCTOU sob
-- concorrência (dois cliques quase simultâneos criariam dois runs
-- "dispatched", e o lookup do heartbeat devolveria o pedido errado ou
-- lançaria PGRST116 por "mais de uma linha").

-- Dedup defensivo ANTES da constraint: se por algum motivo já existir mais
-- de uma linha "dispatched" (não deveria acontecer hoje, mas um clone que já
-- rodou uma versão anterior deste código pode ter dados inconsistentes),
-- mantém só a mais recente como dispatched e marca as demais como failed —
-- senão o índice abaixo quebra o update.sh de um clone assim.
with ranked as (
  select id, row_number() over (order by dispatched_at desc) as rn
  from public.system_update_runs
  where status = 'dispatched'
)
update public.system_update_runs
set status = 'failed', finished_at = coalesce(finished_at, now())
where id in (select id from ranked where rn > 1);

create unique index if not exists uniq_system_update_runs_dispatched
  on public.system_update_runs (status)
  where status = 'dispatched';

comment on index public.uniq_system_update_runs_dispatched is
  'No máximo 1 run "dispatched" por vez — garante que o lookup do heartbeat (lib/system/update-run.ts) nunca ache mais de uma linha pendente.';
