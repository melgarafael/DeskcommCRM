-- ============================================================================
-- 0211 — CRÉDITO DO CLIENTE (ATT.txt Fase 1, ficha 360° Financeiro)
--
-- O bloqueio de pedido por limite de crédito (regra Fase 2) precisa de ONDE
-- guardar o limite. Duas colunas anuláveis em `contacts`: NULL = sem limite
-- definido (não bloqueia nada) — cliente novo não nasce bloqueado por um
-- default, e a ausência de análise de crédito é um estado visível, não zero.
--
-- Sem tabela nova de propósito: limite e condição são atributos do cliente,
-- não entidade com ciclo próprio (DIRC letra C — derivável não se cria).
-- RLS/policies inalteradas: mesmas da tabela.
-- ============================================================================

alter table public.contacts
  add column if not exists limite_credito_cents bigint,
  add column if not exists condicao_pagamento text;

alter table public.contacts
  drop constraint if exists contacts_limite_credito_nao_negativo;

alter table public.contacts
  add constraint contacts_limite_credito_nao_negativo
  check (limite_credito_cents is null or limite_credito_cents >= 0);

comment on column public.contacts.limite_credito_cents is
  'Teto de crédito em centavos. NULL = sem limite definido (não bloqueia). Soma dos pedidos em aberto + novo pedido acima disto barra a venda, salvo override de gerente.';
comment on column public.contacts.condicao_pagamento is
  'Condição padrão do cliente (ex.: 30/60/90 dias). Sugestão no pedido, não trava.';
