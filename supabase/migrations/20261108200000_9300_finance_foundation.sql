-- =============================================================================
-- ARM Finance Module - Foundation
-- Schema, enums, RLS helper (adapted from ERP for ARM multi-tenancy).
-- Uses organization_id + fn_user_org_ids() instead of tenant_id + current_tenant_id().
-- =============================================================================

-- 1. SCHEMA
CREATE SCHEMA IF NOT EXISTS finance;

COMMENT ON SCHEMA finance IS 'Modulo financiero (contabilidad, POS, impuestos). Multi-org via organization_id + RLS.';

GRANT USAGE ON SCHEMA finance TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA finance
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA finance
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;

-- 2. ENUMS
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'account_type_enum') THEN
    CREATE TYPE finance.account_type_enum AS ENUM (
      'asset_receivable', 'asset_cash', 'asset_current', 'asset_non_current',
      'asset_prepayments', 'asset_fixed',
      'liability_payable', 'liability_credit_card', 'liability_current', 'liability_non_current',
      'equity', 'equity_unaffected',
      'income', 'income_other',
      'expense', 'expense_depreciation', 'expense_direct_cost',
      'off_balance'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'journal_type_enum') THEN
    CREATE TYPE finance.journal_type_enum AS ENUM ('sale', 'purchase', 'cash', 'bank', 'general');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'entry_state_enum') THEN
    CREATE TYPE finance.entry_state_enum AS ENUM ('draft', 'posted', 'cancelled');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'payment_state_enum') THEN
    CREATE TYPE finance.payment_state_enum AS ENUM ('not_paid', 'partial', 'in_payment', 'paid', 'reversed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'move_type_enum') THEN
    CREATE TYPE finance.move_type_enum AS ENUM (
      'entry', 'out_invoice', 'out_refund', 'in_invoice', 'in_refund', 'out_receipt', 'in_receipt'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'session_state_enum') THEN
    CREATE TYPE finance.session_state_enum AS ENUM ('opening_control', 'opened', 'closing_control', 'closed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'payment_method_type_enum') THEN
    CREATE TYPE finance.payment_method_type_enum AS ENUM ('cash', 'bank', 'transfer', 'pay_later');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'tax_calc_type_enum') THEN
    CREATE TYPE finance.tax_calc_type_enum AS ENUM ('division', 'percentage', 'group');
  END IF;
END
$$;

-- 3. RLS HELPER: apply_org_rls()
-- ARM pattern: organization_id IN (SELECT public.fn_user_org_ids())
CREATE OR REPLACE FUNCTION finance.apply_org_rls(p_table regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_schema text;
  v_name   text;
BEGIN
  SELECT n.nspname, c.relname INTO v_schema, v_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = p_table;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);

  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', v_name || '_org_select', p_table);
  EXECUTE format(
    'CREATE POLICY %I ON %s FOR SELECT TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids()))',
    v_name || '_org_select', p_table);

  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', v_name || '_org_insert', p_table);
  EXECUTE format(
    'CREATE POLICY %I ON %s FOR INSERT TO authenticated WITH CHECK (organization_id IN (SELECT public.fn_user_org_ids()))',
    v_name || '_org_insert', p_table);

  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', v_name || '_org_update', p_table);
  EXECUTE format(
    'CREATE POLICY %I ON %s FOR UPDATE TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids())) WITH CHECK (organization_id IN (SELECT public.fn_user_org_ids()))',
    v_name || '_org_update', p_table);

  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', v_name || '_org_delete', p_table);
  EXECUTE format(
    'CREATE POLICY %I ON %s FOR DELETE TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids()))',
    v_name || '_org_delete', p_table);
END
$$;

-- 4. AUDIT TRIGGER: updated_by automatic
-- organization_id must be supplied by the caller; RLS validates it.
CREATE OR REPLACE FUNCTION finance.set_audit_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_by := coalesce(auth.uid(), NEW.updated_by);
  RETURN NEW;
END
$$;
