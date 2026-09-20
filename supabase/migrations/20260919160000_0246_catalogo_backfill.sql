-- 0246 · Leva a configuração do agente para o catálogo (backfill).
--
-- ─── O defeito que isto conserta ────────────────────────────────────────────
-- A 0245 moveu as regras do catálogo para `catalog_mappings`, mas nasceu com os
-- DEFAULTS (`similaridade_deterministica=false`, `similares_qtd=3`, `ordem={}`).
-- Quem já tinha configurado a regra no agente (`ai_agents.config.catalog`) ficou
-- com o motor lendo "desligado" — mudança de estrutura que mudou o processo.
--
-- Aqui os valores existentes são COPIADOS para o catálogo, só quando o catálogo
-- ainda não tem a regra ligada. O runtime também ganhou fallback (lê o catálogo;
-- se vazio, usa o agente), então isto é consolidação — não a única rede.
--
-- Idempotente: o WHERE exige `cm.similaridade_deterministica = false`, então
-- reaplicar não sobrescreve quem já configurou pelo catálogo.

update public.catalog_mappings cm
set
  similaridade_deterministica = true,
  similares_qtd = coalesce(
    nullif(a.config->'catalog'->>'similares_qtd', '')::int,
    cm.similares_qtd
  ),
  ordem = coalesce(
    (
      select jsonb_object_agg(t.elem, t.ord::int)
      from jsonb_array_elements_text(a.config->'catalog'->'criterio') with ordinality as t(elem, ord)
      where t.elem in ('cilindrada', 'preco', 'tipo')
    ),
    cm.ordem
  ),
  updated_at = now()
from public.ai_agents a
where a.organization_id = cm.organization_id
  and cm.similaridade_deterministica = false
  and (a.config->'catalog'->>'similaridade_deterministica')::boolean is true
  and a.config->'catalog'->'criterio' is not null;

comment on table public.catalog_mappings is
  'Mapeamento do catálogo do agente: qual tabela do banco externo e quais colunas são nome/ano/cor/km/preço/imagem/estoque, além das regras (semelhança automática, quantidade e ordem). O runtime lê daqui; se a regra estiver vazia, cai no fallback de ai_agents.config.catalog (compatibilidade com a configuração anterior à 0245).';
