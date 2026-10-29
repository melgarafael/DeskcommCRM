-- manifest: Lista do funil (#3172) — índice `idx_crm_leads_org_pipeline_position_id` em `crm_leads`, na ORDEM EXATA da página: `(organization_id, pipeline_id, position_in_stage, id)`. O `range` da rota corta o que VOLTA, não o que o banco AVALIA: sem índice na ordem pedida o Postgres passa a regra de visibilidade (`fn_can_view_lead`, 3 a 7 ms por linha na instalação que abriu a issue) em todo o funil antes de ordenar — medido pelo mantenedor num banco de teste com um funil de 3.901 negócios: 3.901 chamadas e ~3,8 s na página 1. Com o índice, o plano vira `Index Scan` com parada antecipada (51 a 76 chamadas, ~55 a 78 ms). `id` entra como DESEMPATE, para a mesma URL devolver sempre as mesmas linhas quando dois negócios compartilham a `position_in_stage`.
--
-- ─── Por que estas quatro colunas, nesta ordem ──────────────────────────────
-- A consulta da página filtra por igualdade as duas primeiras
-- (`organization_id`, `pipeline_id`), exclui o arquivado e ordena por
-- `position_in_stage` — a mesma ordem do quadro — com `id` no fim. Num btree, o
-- prefixo de igualdade seguido das colunas de ORDEM é o que permite ao plano
-- caminhar o índice já ordenado e PARAR depois de `per_page + 1` linhas, em vez
-- de ler o funil, ordenar e cortar no fim.
--
-- Sem predicado parcial, de propósito: este é o índice que o mantenedor mediu
-- contra o banco real (o `where status <> 'archived'` mudaria o tamanho, não a
-- ordem — e um predicado que o planejador não reconheça tornaria o índice
-- inútil em silêncio, que é o defeito que esta migration existe para fechar).
--
-- ─── Compatibilidade ────────────────────────────────────────────────────────
-- `create index if not exists`: idempotente. Toma lock SHARE em `crm_leads`
-- enquanto constrói (bloqueia escrita, não leitura); sem `concurrently` porque
-- roda dentro da transação do `db push`/`baseline` — numa tabela de milhares de
-- linhas é breve. Índice a mais só custa escrita; o ganho é a leitura da aba
-- Lista, que é o que a issue #3172 mede.

create index if not exists idx_crm_leads_org_pipeline_position_id
  on public.crm_leads (organization_id, pipeline_id, position_in_stage, id);

comment on index public.idx_crm_leads_org_pipeline_position_id is
  'Página da aba Lista do funil (#3172): (organization_id, pipeline_id) por igualdade e (position_in_stage, id) na ordem da consulta. `id` é o desempate que torna a paginação determinística quando dois negócios têm a mesma position_in_stage.';
