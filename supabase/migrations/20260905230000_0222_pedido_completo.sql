-- ============================================================================
-- 0222 — PEDIDO COMPLETO (observações separadas, entrega, desconto %, parcelas)
--
-- - `obs_interna`: o que a equipe lê e o cliente nunca vê. `observacoes`
--   segue existindo como a do CLIENTE (imprime no PDF) — separar sem migrar
--   dado: o que já foi escrito era visível, e escondê-lo retroativamente
--   mudaria documento já entregue.
-- - Entrega: transportadora, modalidade e previsão (o romaneio imprime).
-- - `desconto_pct`: desconto GERAL em % (alternativo a desconto_cents em R$;
--   valem juntos, somando — a rota calcula). Por item continua desconto_pct.
-- - `parcelas`: espelho calculado da condição (30/60/90 → 3 linhas com
--   vencimento). JSON porque parcela não tem ciclo próprio: recalcular é
--   barato, e entidade sem comportamento é tabela à toa (DIRC-C).
-- ============================================================================

alter table public.commercial_orders
  add column if not exists obs_interna text,
  add column if not exists transportadora_nome text,
  add column if not exists modalidade_frete text not null default 'retirada',
  add column if not exists previsao_entrega date,
  add column if not exists desconto_pct numeric(5, 2),
  add column if not exists parcelas jsonb not null default '[]';

alter table public.commercial_orders
  drop constraint if exists commercial_orders_modalidade_valida;

alter table public.commercial_orders
  add constraint commercial_orders_modalidade_valida
  check (modalidade_frete in ('retirada', 'propria', 'terceirizada'));

alter table public.commercial_orders
  drop constraint if exists commercial_orders_desconto_pct_faixa;

alter table public.commercial_orders
  add constraint commercial_orders_desconto_pct_faixa
  check (desconto_pct is null or (desconto_pct >= 0 and desconto_pct <= 100));

comment on column public.commercial_orders.obs_interna is
  'Só a equipe lê. observacoes (legado) é a do cliente e imprime no PDF.';
comment on column public.commercial_orders.parcelas is
  'Espelho calculado [{n, valor_cents, vencimento}]: derivado da condição, recalculado a cada gravação — sem ciclo próprio.';
