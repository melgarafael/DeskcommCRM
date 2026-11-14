-- manifest: **O plano de cobrança do revendedor aceita dólar e euro, além de real:** o CHECK de `cobranca_planos.moeda` passa de `BRL` para `BRL`, `USD` e `EUR`. Quem vende para fora do Brasil cria o plano na moeda do cliente, e o checkout da Stripe cobra nela. O Asaas segue só com real (a recusa mora na rota e no adaptador). Aditiva: só troca o CHECK por um mais largo; nenhuma linha muda, e toda linha existente (BRL) já cumpre o novo.
-- ============================================================================
-- 9332 — MOEDA POR PLANO NA COBRANÇA DO REVENDEDOR.
--
-- A coluna `moeda` nasceu na 0583 com CHECK só `BRL`, e o adaptador da Stripe
-- mandava `currency: "brl"` fixo. Uma instalação que vende fora do Brasil não
-- conseguia cobrar na moeda em que anuncia o preço.
--
-- O CHECK nasceu sem nome (`check` na própria coluna), e o Postgres o chama
-- `cobranca_planos_moeda_check`. Trocar por um mais largo é seguro para o
-- `update.sh`: as linhas que existem são todas BRL e cumprem o novo.
-- ============================================================================

alter table public.cobranca_planos
  drop constraint if exists cobranca_planos_moeda_check;

alter table public.cobranca_planos
  add constraint cobranca_planos_moeda_check
  check (moeda = any (array['BRL'::text, 'USD'::text, 'EUR'::text]));
