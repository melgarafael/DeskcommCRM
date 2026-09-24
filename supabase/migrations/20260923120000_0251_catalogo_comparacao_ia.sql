-- 0251 · Catálogo: configuração POR COLUNA (IA, critério, legenda, comparação) + referência.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- Até aqui a semelhança só podia usar 4 papéis fixos (nome, tipo, preço,
-- cilindrada), a legenda guardava nomes de coluna e o contexto da IA era o
-- catálogo inteiro. Agora o dono escolhe, COLUNA A COLUNA, o que fazer:
--
--   * `colunas` (jsonb) — array de objetos, um por coluna configurada:
--       { "coluna": "marca",
--         "ia": true,        // valor enviado à IA (contexto; reduz tokens)
--         "criterio": true,  // a IA PODE usar como filtro na consulta ampla
--         "mostrar": true,   // aparece na legenda que vai com a foto
--         "comparar": true,  // o motor usa para ORDENAR as semelhantes
--         "ordem": 2,        // prioridade (1 = mais importante)
--         "compoe_nome": true } // entra no nome exibido (ex.: nome + versão)
--   * `col_similares` (text) — coluna de REFERÊNCIA (ex.: `moto_similar`):
--       quando o cliente pede uma moto que não temos, o motor procura o pedido
--       nessa coluna e oferece a moto REAL que a cita. Fica SÓ no motor; a IA
--       nunca vê os nomes de referência.
--
-- ─── Retrocompatibilidade ───────────────────────────────────────────────────
-- `colunas` vazio ⇒ o motor deriva da configuração antiga (papéis `col_*`,
-- `legenda`, `ordem`). Os campos de papel PERMANECEM e seguem sendo lidos.
--
-- Nenhuma função nova em `public` ⇒ item 9 da doutrina de migrations não acionado.

alter table public.catalog_mappings
  add column if not exists colunas jsonb not null default '[]'::jsonb,
  add column if not exists col_similares text;

comment on column public.catalog_mappings.colunas is
  'Configuração POR COLUNA: array de {coluna, ia, criterio, mostrar, comparar, ordem, compoe_nome}. Vazio = derivar da configuração antiga (papéis + legenda + ordem).';
comment on column public.catalog_mappings.col_similares is
  'Coluna de REFERÊNCIA de motos similares (ex.: moto_similar). Usada SÓ no motor: acha a moto real que cita o pedido. Nunca vai para a IA nem para o cliente.';
