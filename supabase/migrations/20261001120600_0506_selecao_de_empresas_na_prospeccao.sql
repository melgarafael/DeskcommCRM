-- manifest: **A escolha do operador vira coluna (issue #1896): quais empresas da busca entram na fila.** `prospecting_candidates.selected boolean not null default true` — o padrão é TUDO marcado (quem não mexer continua com a mesma fila de antes). Ativação só aborda os marcados; os desmarcados vão para `skipped` com o motivo "Não selecionada pelo operador." (mesmo estado dos dois motivos que já existem). Ação nova `select` (id, candidate_ids, selected), idempotente, só em campanha `draft`, com auditoria.
-- Issue #1896: o operador escolhe quais empresas da busca entram na fila.
-- `selected boolean not null default true` em prospecting_candidates: o padrão
-- é TUDO marcado, então quem não mexer continua vendo a mesma fila de antes
-- (a coluna não muda comportamento por si só).
-- A ativação só aborda os marcados; os desmarcados vão para `skipped` com o
-- motivo "Não selecionada pelo operador." — o mesmo estado dos dois motivos
-- que já existem (sem telefone brasileiro, contato já existente).
alter table public.prospecting_candidates
  add column if not exists selected boolean not null default true;
notify pgrst, 'reload schema';