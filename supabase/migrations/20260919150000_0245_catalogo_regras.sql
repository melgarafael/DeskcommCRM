-- 0245 · As regras do catálogo moravam no agente; passam a morar no catálogo.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- O dono pediu (2026-09-19): ligar/desligar, ordem e "quantas oferecer" devem
-- ficar JUNTO ao catálogo (tela de Integração de dados), e não na config do
-- agente. Assim, `catalog_mappings` (0244) ganha:
--   - `similaridade_deterministica`: o motor escolhe as semelhantes (regra fixa)
--     em vez de depender do julgamento do modelo;
--   - `similares_qtd`: quantas motos oferecer (1..8);
--   - `ordem`: prioridade dos papéis, usada para escolher as semelhantes E para
--     montar a legenda. Ex.: {"cilindrada":1,"preco":2,"nome":3,...}.
--
-- `ai_agents.config.catalog` continua existindo para os TOGGLES DE FORMATO
-- (foto_por_moto, abertura_sem_citar, pergunta_separada, enviar_foto_automatica),
-- que são preferência de mensagem do agente. O motor lê os dois.
--
-- Nenhuma função nova em `public` ⇒ item 9 da doutrina de migrations não acionado.

alter table public.catalog_mappings
  add column if not exists similaridade_deterministica boolean not null default false,
  add column if not exists similares_qtd integer not null default 3,
  add column if not exists ordem jsonb not null default '{}'::jsonb;

alter table public.catalog_mappings
  drop constraint if exists catalog_mappings_similares_qtd_valido;
alter table public.catalog_mappings
  add constraint catalog_mappings_similares_qtd_valido
    check (similares_qtd between 1 and 8);

comment on column public.catalog_mappings.similaridade_deterministica is
  'true = o motor escolhe as motos semelhantes por regra fixa (ordem), sem depender do julgamento do modelo.';
comment on column public.catalog_mappings.similares_qtd is
  'Quantas motos semelhantes oferecer quando o modelo pedido não existe (1..8).';
comment on column public.catalog_mappings.ordem is
  'Prioridade por papel de coluna (ex.: {"cilindrada":1,"preco":2}). Vale para escolher as semelhantes e para a ordem dos campos na legenda.';
