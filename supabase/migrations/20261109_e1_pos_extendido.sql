-- ============================================================
-- E.1 POS Extendido — Delta Schema
-- Tablas nuevas + ALTER ADD COLUMN en tablas existentes
-- SEGURO: solo CREATE TABLE y ALTER TABLE ADD COLUMN
-- ============================================================

-- ============================================================
-- 1. PRODUCTS — Catálogo de productos con stock
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name            text NOT NULL,
  sku             text,
  description     text,
  category        text,
  sale_price      numeric(14,2) NOT NULL DEFAULT 0,
  cost_price      numeric(14,2) DEFAULT 0,
  tax_ids         uuid[] DEFAULT '{}',
  is_active       boolean NOT NULL DEFAULT true,
  track_stock     boolean NOT NULL DEFAULT false,
  stock_quantity  integer NOT NULL DEFAULT 0,
  min_stock       integer DEFAULT 0,
  image_url       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "products_org_isolation" ON finance.products
  USING (organization_id = ANY(public.fn_user_org_ids()));

CREATE INDEX IF NOT EXISTS idx_products_org
  ON finance.products(organization_id);
CREATE INDEX IF NOT EXISTS idx_products_category
  ON finance.products(category) WHERE is_active;

-- ============================================================
-- 2. DISCOUNTS — Reglas de descuento y códigos promo
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.discounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name            text NOT NULL,
  discount_type   text NOT NULL CHECK (discount_type IN ('percentage', 'fixed', 'bogo')),
  value           numeric(14,2) NOT NULL DEFAULT 0,
  applies_to      text NOT NULL DEFAULT 'sale' CHECK (applies_to IN ('sale', 'item', 'category')),
  promo_code      text,
  is_active       boolean NOT NULL DEFAULT true,
  valid_from      date,
  valid_until     date,
  max_uses        integer,
  current_uses    integer NOT NULL DEFAULT 0,
  min_purchase    numeric(14,2) DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance.discounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "discounts_org_isolation" ON finance.discounts
  USING (organization_id = ANY(public.fn_user_org_ids()));

CREATE UNIQUE INDEX IF NOT EXISTS idx_discounts_promo_code
  ON finance.discounts(organization_id, promo_code)
  WHERE promo_code IS NOT NULL AND is_active;

-- RPC: Incremento atómico de usos de descuento
CREATE OR REPLACE FUNCTION finance.increment_discount_uses(p_discount_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE finance.discounts
     SET current_uses = current_uses + 1,
         updated_at   = now()
   WHERE id = p_discount_id;
END;
$$;

-- ============================================================
-- 3. GIFT CARDS — Tarjetas de regalo
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.gift_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  code            text NOT NULL,
  initial_amount  numeric(14,2) NOT NULL,
  current_balance numeric(14,2) NOT NULL,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'used', 'expired', 'cancelled')),
  purchased_by    uuid,
  assigned_to     uuid,
  sale_id         uuid,
  expires_at      timestamptz,
  notes           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance.gift_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gift_cards_org_isolation" ON finance.gift_cards
  USING (organization_id = ANY(public.fn_user_org_ids()));

CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_code
  ON finance.gift_cards(organization_id, code);

-- ============================================================
-- 4. GIFT CARD TRANSACTIONS — Historial de movimientos
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.gift_card_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id      uuid NOT NULL REFERENCES finance.gift_cards(id),
  transaction_type  text NOT NULL CHECK (transaction_type IN ('credit', 'debit', 'refund')),
  amount            numeric(14,2) NOT NULL,
  balance_after     numeric(14,2) NOT NULL,
  sale_id           uuid,
  description       text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance.gift_card_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gc_txn_via_card" ON finance.gift_card_transactions
  USING (gift_card_id IN (
    SELECT id FROM finance.gift_cards
     WHERE organization_id = ANY(public.fn_user_org_ids())
  ));

CREATE INDEX IF NOT EXISTS idx_gc_txn_card
  ON finance.gift_card_transactions(gift_card_id);

-- ============================================================
-- 5. INVOICES — Facturación formal
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  sale_id         uuid REFERENCES finance.sales(id),
  invoice_number  text NOT NULL,
  invoice_date    date NOT NULL DEFAULT CURRENT_DATE,
  customer_name   text,
  customer_nit    text,
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  tax_total       numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance.invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoices_org_isolation" ON finance.invoices
  USING (organization_id = ANY(public.fn_user_org_ids()));

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number
  ON finance.invoices(organization_id, invoice_number);

-- ============================================================
-- 6. ACCOUNTS RECEIVABLE — Cuentas por cobrar
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.accounts_receivable (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  invoice_id      uuid REFERENCES finance.invoices(id),
  contact_id      uuid,
  amount          numeric(14,2) NOT NULL,
  paid_amount     numeric(14,2) NOT NULL DEFAULT 0,
  balance         numeric(14,2) NOT NULL,
  due_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'partial', 'paid', 'overdue', 'written_off')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance.accounts_receivable ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ar_org_isolation" ON finance.accounts_receivable
  USING (organization_id = ANY(public.fn_user_org_ids()));

CREATE INDEX IF NOT EXISTS idx_ar_contact
  ON finance.accounts_receivable(contact_id);
CREATE INDEX IF NOT EXISTS idx_ar_status
  ON finance.accounts_receivable(status) WHERE status != 'paid';

-- ============================================================
-- 7. EXPENSES — Gastos (minimal para statistics, E.3 expandirá)
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  description     text NOT NULL,
  amount          numeric(14,2) NOT NULL,
  category        text NOT NULL DEFAULT 'general',
  expense_date    date NOT NULL DEFAULT CURRENT_DATE,
  payment_method  text,
  receipt_url     text,
  notes           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance.expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "expenses_org_isolation" ON finance.expenses
  USING (organization_id = ANY(public.fn_user_org_ids()));

CREATE INDEX IF NOT EXISTS idx_expenses_org_date
  ON finance.expenses(organization_id, expense_date);

-- ============================================================
-- 8. PROFESSIONAL CONFIGS — Comisiones por miembro
-- ============================================================
CREATE TABLE IF NOT EXISTS finance.professional_configs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  member_id         uuid NOT NULL,
  commission_type   text CHECK (commission_type IN ('percentage', 'fixed', 'tiered')),
  commission_config jsonb DEFAULT '{}',
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, member_id)
);

ALTER TABLE finance.professional_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "prof_configs_org_isolation" ON finance.professional_configs
  USING (organization_id = ANY(public.fn_user_org_ids()));

-- ============================================================
-- 9. ALTER ADD COLUMN — Extender tablas existentes
-- Solo ADD COLUMN, nunca modificar columnas existentes
-- ============================================================

-- sale_lines: agregar professional_id y commission_amount
ALTER TABLE finance.sale_lines
  ADD COLUMN IF NOT EXISTS professional_id     uuid,
  ADD COLUMN IF NOT EXISTS commission_amount   numeric(14,2) DEFAULT 0;

-- sales: agregar campos de descuento, gift card, propina
ALTER TABLE finance.sales
  ADD COLUMN IF NOT EXISTS tip_amount        numeric(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_id       uuid,
  ADD COLUMN IF NOT EXISTS discount_amount   numeric(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gift_card_id      uuid,
  ADD COLUMN IF NOT EXISTS gift_card_amount  numeric(14,2) DEFAULT 0;

-- ============================================================
-- 10. PROXY VIEWS — PostgREST solo expone public schema
-- ============================================================

CREATE OR REPLACE VIEW public.finance_products AS
  SELECT * FROM finance.products;

CREATE OR REPLACE VIEW public.finance_discounts AS
  SELECT * FROM finance.discounts;

CREATE OR REPLACE VIEW public.finance_gift_cards AS
  SELECT * FROM finance.gift_cards;

CREATE OR REPLACE VIEW public.finance_gift_card_transactions AS
  SELECT * FROM finance.gift_card_transactions;

CREATE OR REPLACE VIEW public.finance_invoices AS
  SELECT * FROM finance.invoices;

CREATE OR REPLACE VIEW public.finance_accounts_receivable AS
  SELECT * FROM finance.accounts_receivable;

CREATE OR REPLACE VIEW public.finance_expenses AS
  SELECT * FROM finance.expenses;

CREATE OR REPLACE VIEW public.finance_professional_configs AS
  SELECT * FROM finance.professional_configs;

-- ============================================================
-- 11. GRANTS — Acceso vía proxy views
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON finance.products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.discounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.gift_cards TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.gift_card_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.invoices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.accounts_receivable TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.expenses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance.professional_configs TO authenticated;

GRANT SELECT ON public.finance_products TO authenticated;
GRANT SELECT ON public.finance_discounts TO authenticated;
GRANT SELECT ON public.finance_gift_cards TO authenticated;
GRANT SELECT ON public.finance_gift_card_transactions TO authenticated;
GRANT SELECT ON public.finance_invoices TO authenticated;
GRANT SELECT ON public.finance_accounts_receivable TO authenticated;
GRANT SELECT ON public.finance_expenses TO authenticated;
GRANT SELECT ON public.finance_professional_configs TO authenticated;

GRANT EXECUTE ON FUNCTION finance.increment_discount_uses(uuid) TO authenticated;
