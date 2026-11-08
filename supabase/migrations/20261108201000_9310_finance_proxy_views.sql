-- =============================================================================
-- ARM Finance - Proxy views in public schema for PostgREST
-- PostgREST only exposes the `public` schema. These views delegate to
-- finance.* tables with security_invoker = true, so RLS policies on the
-- underlying tables are enforced.
--
-- Naming: finance_{table_name} to avoid collisions with ARM's existing tables.
-- =============================================================================

-- Tables (CRUD via views)

CREATE OR REPLACE VIEW public.finance_chart_of_accounts
WITH (security_invoker = true) AS
SELECT * FROM finance.chart_of_accounts;

CREATE OR REPLACE VIEW public.finance_journals
WITH (security_invoker = true) AS
SELECT * FROM finance.journals;

CREATE OR REPLACE VIEW public.finance_tax_groups
WITH (security_invoker = true) AS
SELECT * FROM finance.tax_groups;

CREATE OR REPLACE VIEW public.finance_tax_configs
WITH (security_invoker = true) AS
SELECT * FROM finance.tax_configs;

CREATE OR REPLACE VIEW public.finance_pos_configs
WITH (security_invoker = true) AS
SELECT * FROM finance.pos_configs;

CREATE OR REPLACE VIEW public.finance_payment_methods
WITH (security_invoker = true) AS
SELECT * FROM finance.payment_methods;

CREATE OR REPLACE VIEW public.finance_pos_config_payment_methods
WITH (security_invoker = true) AS
SELECT * FROM finance.pos_config_payment_methods;

CREATE OR REPLACE VIEW public.finance_pos_sessions
WITH (security_invoker = true) AS
SELECT * FROM finance.pos_sessions;

CREATE OR REPLACE VIEW public.finance_document_sequences
WITH (security_invoker = true) AS
SELECT * FROM finance.document_sequences;

CREATE OR REPLACE VIEW public.finance_journal_entries
WITH (security_invoker = true) AS
SELECT * FROM finance.journal_entries;

CREATE OR REPLACE VIEW public.finance_journal_entry_lines
WITH (security_invoker = true) AS
SELECT * FROM finance.journal_entry_lines;

CREATE OR REPLACE VIEW public.finance_sales
WITH (security_invoker = true) AS
SELECT * FROM finance.sales;

CREATE OR REPLACE VIEW public.finance_sale_lines
WITH (security_invoker = true) AS
SELECT * FROM finance.sale_lines;

CREATE OR REPLACE VIEW public.finance_sale_payments
WITH (security_invoker = true) AS
SELECT * FROM finance.sale_payments;

CREATE OR REPLACE VIEW public.finance_payments
WITH (security_invoker = true) AS
SELECT * FROM finance.payments;

CREATE OR REPLACE VIEW public.finance_full_reconciliations
WITH (security_invoker = true) AS
SELECT * FROM finance.full_reconciliations;

CREATE OR REPLACE VIEW public.finance_payment_reconciliations
WITH (security_invoker = true) AS
SELECT * FROM finance.payment_reconciliations;

CREATE OR REPLACE VIEW public.finance_cash_movements
WITH (security_invoker = true) AS
SELECT * FROM finance.cash_movements;

CREATE OR REPLACE VIEW public.finance_bank_statements
WITH (security_invoker = true) AS
SELECT * FROM finance.bank_statements;

CREATE OR REPLACE VIEW public.finance_bank_statement_lines
WITH (security_invoker = true) AS
SELECT * FROM finance.bank_statement_lines;

CREATE OR REPLACE VIEW public.finance_bank_reconciliation_entries
WITH (security_invoker = true) AS
SELECT * FROM finance.bank_reconciliation_entries;

CREATE OR REPLACE VIEW public.finance_reconcile_rules
WITH (security_invoker = true) AS
SELECT * FROM finance.reconcile_rules;

CREATE OR REPLACE VIEW public.finance_tax_report_tags
WITH (security_invoker = true) AS
SELECT * FROM finance.tax_report_tags;

CREATE OR REPLACE VIEW public.finance_tax_config_tags
WITH (security_invoker = true) AS
SELECT * FROM finance.tax_config_tags;

CREATE OR REPLACE VIEW public.finance_entry_line_tags
WITH (security_invoker = true) AS
SELECT * FROM finance.entry_line_tags;

-- Reporting views (read-only)

CREATE OR REPLACE VIEW public.finance_v_sale_tax_lines
WITH (security_invoker = true) AS
SELECT * FROM finance.v_sale_tax_lines;

CREATE OR REPLACE VIEW public.finance_v_session_summary
WITH (security_invoker = true) AS
SELECT * FROM finance.v_session_summary;

CREATE OR REPLACE VIEW public.finance_v_daily_sales_report
WITH (security_invoker = true) AS
SELECT * FROM finance.v_daily_sales_report;

CREATE OR REPLACE VIEW public.finance_v_sales_by_payment_method
WITH (security_invoker = true) AS
SELECT * FROM finance.v_sales_by_payment_method;

CREATE OR REPLACE VIEW public.finance_v_tax_summary
WITH (security_invoker = true) AS
SELECT * FROM finance.v_tax_summary;

CREATE OR REPLACE VIEW public.finance_v_receivable_payable_lines
WITH (security_invoker = true) AS
SELECT * FROM finance.v_receivable_payable_lines;

CREATE OR REPLACE VIEW public.finance_v_accounts_receivable
WITH (security_invoker = true) AS
SELECT * FROM finance.v_accounts_receivable;

CREATE OR REPLACE VIEW public.finance_v_accounts_payable
WITH (security_invoker = true) AS
SELECT * FROM finance.v_accounts_payable;

CREATE OR REPLACE VIEW public.finance_v_bank_statement_balances
WITH (security_invoker = true) AS
SELECT * FROM finance.v_bank_statement_balances;

CREATE OR REPLACE VIEW public.finance_v_libro_ventas_iva
WITH (security_invoker = true) AS
SELECT * FROM finance.v_libro_ventas_iva;

CREATE OR REPLACE VIEW public.finance_v_libro_compras_iva
WITH (security_invoker = true) AS
SELECT * FROM finance.v_libro_compras_iva;

CREATE OR REPLACE VIEW public.finance_v_declaracion_iva_mensual
WITH (security_invoker = true) AS
SELECT * FROM finance.v_declaracion_iva_mensual;

CREATE OR REPLACE VIEW public.finance_v_declaracion_it_mensual
WITH (security_invoker = true) AS
SELECT * FROM finance.v_declaracion_it_mensual;

-- Permissions: all proxy views readable/writable by authenticated and service_role
-- (RLS on underlying tables controls actual access)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.finance_chart_of_accounts,
  public.finance_journals,
  public.finance_tax_groups,
  public.finance_tax_configs,
  public.finance_pos_configs,
  public.finance_payment_methods,
  public.finance_pos_config_payment_methods,
  public.finance_pos_sessions,
  public.finance_document_sequences,
  public.finance_journal_entries,
  public.finance_journal_entry_lines,
  public.finance_sales,
  public.finance_sale_lines,
  public.finance_sale_payments,
  public.finance_payments,
  public.finance_full_reconciliations,
  public.finance_payment_reconciliations,
  public.finance_cash_movements,
  public.finance_bank_statements,
  public.finance_bank_statement_lines,
  public.finance_bank_reconciliation_entries,
  public.finance_reconcile_rules,
  public.finance_tax_report_tags,
  public.finance_tax_config_tags,
  public.finance_entry_line_tags
TO authenticated, service_role;

GRANT SELECT ON
  public.finance_v_sale_tax_lines,
  public.finance_v_session_summary,
  public.finance_v_daily_sales_report,
  public.finance_v_sales_by_payment_method,
  public.finance_v_tax_summary,
  public.finance_v_receivable_payable_lines,
  public.finance_v_accounts_receivable,
  public.finance_v_accounts_payable,
  public.finance_v_bank_statement_balances,
  public.finance_v_libro_ventas_iva,
  public.finance_v_libro_compras_iva,
  public.finance_v_declaracion_iva_mensual,
  public.finance_v_declaracion_it_mensual
TO authenticated, service_role;
