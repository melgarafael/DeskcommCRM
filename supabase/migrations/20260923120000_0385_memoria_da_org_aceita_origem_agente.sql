-- 0385 — a memória da organização aceita a origem 'agent'.
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
-- A ferramenta MCP `crm_save_org_memory` (lib/mcp/tools/evolucao.ts) grava em
-- `org_memory_entries` com `source = 'agent'`, e a descrição dela promete isso
-- ao modelo ("nasce com origem 'agent' para o humano distinguir o que a IA
-- anotou"). Mas o CHECK da coluna, desde a 0067, só aceita `manual` e
-- `flywheel`: toda chamada falhava com 23514 e a ferramenta nunca gravou nada.
-- Diagnóstico de @vgamkt no #1130.
--
-- ─── Por que ampliar o CHECK, e não gravar 'manual' ─────────────────────────
-- A origem é a trilha de quem escreveu a política da empresa. Rotular como
-- `manual` o que a IA anotou faria a tela (e a auditoria) atribuir a uma pessoa
-- um texto que nenhuma pessoa escreveu. Decisão do titular: a origem gravada
-- tem de ser verdadeira.
--
-- ─── Idempotência ───────────────────────────────────────────────────────────
-- O CHECK nasceu inline na 0067, sem nome; o Postgres o batiza
-- `org_memory_entries_source_check`. `drop if exists` + `add` com o conjunto
-- final: as linhas existentes (`manual`/`flywheel`) cabem no conjunto novo, então
-- reaplicar numa base com dados não viola nada.
alter table public.org_memory_entries
  drop constraint if exists org_memory_entries_source_check;
alter table public.org_memory_entries
  add constraint org_memory_entries_source_check
  check (source in ('manual', 'flywheel', 'agent'));
