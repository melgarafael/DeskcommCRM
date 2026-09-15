-- Migration 0219: moeda padrão da instalação vira Kwanza (AOA)
--
-- Esta instalação atende o mercado angolano. As quatro colunas de moeda do
-- produto (`organizations.currency`, `catalog_products.moeda`,
-- `crm_leads.currency`, `orders.currency`) nasceram com default 'BRL'
-- (migrations 0208, 0204 e o dump original) porque o produto nasceu para o
-- mercado brasileiro. Aqui só o DEFAULT muda — toda linha já gravada guarda
-- a moeda com que nasceu, de propósito (o comentário de
-- `organizations.currency` já diz isso: "pedido pago em BRL não vira MXN
-- depois"). Sem backfill.
--
-- Os CHECKs são de FORMA (ISO-4217, `^[A-Z]{3}$`), não de vocabulário
-- fechado — 'AOA' já passa neles sem mudança nenhuma.
alter table public.organizations
  alter column currency set default 'AOA';

alter table public.catalog_products
  alter column moeda set default 'AOA';

alter table public.crm_leads
  alter column currency set default 'AOA';

alter table public.orders
  alter column currency set default 'AOA';
