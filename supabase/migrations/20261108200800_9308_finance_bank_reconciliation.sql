-- =============================================================================
-- ARM Finance - Bank Reconciliation
-- Adapted: organization_id + fn_user_org_ids()
-- =============================================================================

-- 0. PRECHECK
DO $$
DECLARE
  r       record;
  v_miss  text := '';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('journals','id'), ('journals','organization_id'), ('journals','type'),
      ('journals','default_debit_account_id'),
      ('journal_entry_lines','id'), ('journal_entry_lines','organization_id'),
      ('journal_entry_lines','account_id'), ('journal_entry_lines','debit'),
      ('journal_entry_lines','credit'), ('journal_entry_lines','entry_id'),
      ('payments','id'), ('payments','organization_id')
    ) AS t(tbl, col)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'finance' AND c.table_name = r.tbl AND c.column_name = r.col) THEN
      v_miss := v_miss || format(' finance.%s.%s', r.tbl, r.col);
    END IF;
  END LOOP;

  IF v_miss <> '' THEN
    RAISE EXCEPTION '9308: faltan dependencias:%', v_miss;
  END IF;
END
$$;

-- 1. ENUMS
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'stmt_line_state_enum') THEN
    CREATE TYPE finance.stmt_line_state_enum AS ENUM ('pending', 'matched', 'reconciled');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'reconcile_rule_type_enum') THEN
    CREATE TYPE finance.reconcile_rule_type_enum AS ENUM ('invoice_matching', 'writeoff_suggestion', 'writeoff_button');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'match_label_type_enum') THEN
    CREATE TYPE finance.match_label_type_enum AS ENUM ('contains', 'not_contains', 'match_regex');
  END IF;
END
$$;

-- 2. bank_statements
CREATE TABLE IF NOT EXISTS finance.bank_statements (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  VARCHAR(100),
  reference             VARCHAR(255),
  journal_id            UUID          NOT NULL REFERENCES finance.journals (id),
  date                  DATE          NOT NULL DEFAULT CURRENT_DATE,
  balance_start         DECIMAL(15,2) NOT NULL DEFAULT 0,
  balance_end_real      DECIMAL(15,2),
  is_complete           BOOLEAN       NOT NULL DEFAULT false,
  organization_id       UUID          NOT NULL REFERENCES public.organizations(id),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by            UUID,
  CONSTRAINT bs_id_org_uniq UNIQUE (id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_bs_org_journal ON finance.bank_statements (organization_id, journal_id);
CREATE INDEX IF NOT EXISTS idx_bs_org_date    ON finance.bank_statements (organization_id, date);

SELECT finance.apply_org_rls('finance.bank_statements');

-- 3. bank_statement_lines
CREATE TABLE IF NOT EXISTS finance.bank_statement_lines (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id          UUID          NOT NULL REFERENCES finance.bank_statements (id) ON DELETE CASCADE,
  sequence              INTEGER       NOT NULL DEFAULT 10,
  date                  DATE          NOT NULL DEFAULT CURRENT_DATE,
  payment_ref           VARCHAR(500),
  partner_id            UUID,
  partner_name          VARCHAR(255),
  account_number        VARCHAR(64),
  transaction_type      VARCHAR(50),
  amount                DECIMAL(15,2) NOT NULL,
  state                 finance.stmt_line_state_enum NOT NULL DEFAULT 'pending',
  journal_entry_id      UUID          REFERENCES finance.journal_entries (id),
  organization_id       UUID          NOT NULL REFERENCES public.organizations(id),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by            UUID,
  CONSTRAINT bsl_id_org_uniq UNIQUE (id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_bsl_statement   ON finance.bank_statement_lines (statement_id);
CREATE INDEX IF NOT EXISTS idx_bsl_org_state ON finance.bank_statement_lines (organization_id, state);
CREATE INDEX IF NOT EXISTS idx_bsl_org_date  ON finance.bank_statement_lines (organization_id, date);

SELECT finance.apply_org_rls('finance.bank_statement_lines');

-- 4. bank_reconciliation_entries
CREATE TABLE IF NOT EXISTS finance.bank_reconciliation_entries (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_line_id     UUID          NOT NULL REFERENCES finance.bank_statement_lines (id) ON DELETE CASCADE,
  journal_entry_line_id UUID          NOT NULL REFERENCES finance.journal_entry_lines (id),
  amount                DECIMAL(15,2) NOT NULL,
  organization_id       UUID          NOT NULL REFERENCES public.organizations(id),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT bre_id_org_uniq UNIQUE (id, organization_id),
  CONSTRAINT bre_amount_nonzero CHECK (amount <> 0),
  CONSTRAINT bre_unique_pair UNIQUE (statement_line_id, journal_entry_line_id)
);

SELECT finance.apply_org_rls('finance.bank_reconciliation_entries');

-- 5. reconcile_rules
CREATE TABLE IF NOT EXISTS finance.reconcile_rules (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     VARCHAR(255)  NOT NULL,
  rule_type                finance.reconcile_rule_type_enum NOT NULL DEFAULT 'invoice_matching',
  sequence                 INTEGER       NOT NULL DEFAULT 10,
  match_partner            BOOLEAN       NOT NULL DEFAULT false,
  match_label              finance.match_label_type_enum,
  match_label_param        VARCHAR(500),
  match_amount             BOOLEAN       NOT NULL DEFAULT false,
  match_amount_min         DECIMAL(15,2),
  match_amount_max         DECIMAL(15,2),
  allow_payment_tolerance  BOOLEAN       NOT NULL DEFAULT true,
  payment_tolerance_pct    DECIMAL(5,2)  NOT NULL DEFAULT 0,
  auto_validate            BOOLEAN       NOT NULL DEFAULT false,
  writeoff_account_id      UUID          REFERENCES finance.chart_of_accounts (id),
  writeoff_label           VARCHAR(255),
  is_active                BOOLEAN       NOT NULL DEFAULT true,
  organization_id          UUID          NOT NULL REFERENCES public.organizations(id),
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by               UUID,
  CONSTRAINT rr_id_org_uniq UNIQUE (id, organization_id),
  CONSTRAINT rr_tolerance_range CHECK (payment_tolerance_pct BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_rr_org_active ON finance.reconcile_rules (organization_id) WHERE is_active;

SELECT finance.apply_org_rls('finance.reconcile_rules');

-- 6. v_bank_statement_balances
CREATE OR REPLACE VIEW finance.v_bank_statement_balances
WITH (security_invoker = true) AS
SELECT bs.id,
       bs.organization_id,
       bs.journal_id,
       bs.date,
       bs.balance_start,
       bs.balance_start + COALESCE(sum(bsl.amount), 0) AS balance_end,
       bs.balance_end_real,
       bs.balance_start + COALESCE(sum(bsl.amount), 0) - COALESCE(bs.balance_end_real, 0) AS difference,
       count(bsl.id)                                    AS line_count,
       count(bsl.id) FILTER (WHERE bsl.state = 'reconciled') AS reconciled_count,
       count(bsl.id) FILTER (WHERE bsl.state = 'pending')    AS pending_count
  FROM finance.bank_statements bs
  LEFT JOIN finance.bank_statement_lines bsl ON bsl.statement_id = bs.id
 GROUP BY bs.id;

-- 7. reconcile_statement_line
CREATE OR REPLACE FUNCTION finance.reconcile_statement_line(
  p_statement_line_id  uuid,
  p_matches            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = finance, public, extensions, pg_temp
AS $$
DECLARE
  v_line       finance.bank_statement_lines%ROWTYPE;
  v_total      decimal(15,2) := 0;
  v_match      jsonb;
  v_jel_id     uuid;
  v_amount     decimal(15,2);
  v_jel_exists boolean;
BEGIN
  SELECT * INTO v_line FROM finance.bank_statement_lines WHERE id = p_statement_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Linea de extracto % no encontrada', p_statement_line_id;
  END IF;
  IF v_line.state = 'reconciled' THEN
    RAISE EXCEPTION 'La linea % ya esta conciliada', p_statement_line_id;
  END IF;

  FOR v_match IN SELECT * FROM jsonb_array_elements(p_matches)
  LOOP
    v_jel_id := (v_match ->> 'journal_entry_line_id')::uuid;
    v_amount := (v_match ->> 'amount')::decimal(15,2);

    SELECT EXISTS(SELECT 1 FROM finance.journal_entry_lines WHERE id = v_jel_id AND organization_id = v_line.organization_id)
      INTO v_jel_exists;
    IF NOT v_jel_exists THEN
      RAISE EXCEPTION 'Linea de asiento % no encontrada para esta organizacion', v_jel_id;
    END IF;

    INSERT INTO finance.bank_reconciliation_entries (statement_line_id, journal_entry_line_id, amount, organization_id)
    VALUES (p_statement_line_id, v_jel_id, v_amount, v_line.organization_id)
    ON CONFLICT (statement_line_id, journal_entry_line_id) DO UPDATE SET amount = EXCLUDED.amount;

    v_total := v_total + v_amount;
  END LOOP;

  IF v_total = v_line.amount THEN
    UPDATE finance.bank_statement_lines SET state = 'reconciled' WHERE id = p_statement_line_id;
  ELSE
    UPDATE finance.bank_statement_lines SET state = 'matched' WHERE id = p_statement_line_id;
  END IF;

  RETURN jsonb_build_object(
    'statement_line_id', p_statement_line_id,
    'line_amount',       v_line.amount,
    'reconciled_amount', v_total,
    'fully_reconciled',  v_total = v_line.amount,
    'entries_count',     jsonb_array_length(p_matches)
  );
END
$$;

-- 8. unreconcile_statement_line
CREATE OR REPLACE FUNCTION finance.unreconcile_statement_line(p_statement_line_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = finance, public, extensions, pg_temp
AS $$
BEGIN
  DELETE FROM finance.bank_reconciliation_entries WHERE statement_line_id = p_statement_line_id;
  UPDATE finance.bank_statement_lines SET state = 'pending' WHERE id = p_statement_line_id;
END
$$;

-- 9. auto_reconcile_statement
CREATE OR REPLACE FUNCTION finance.auto_reconcile_statement(p_statement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = finance, public, extensions, pg_temp
AS $$
DECLARE
  v_stmt       finance.bank_statements%ROWTYPE;
  v_line       record;
  v_rule       record;
  v_candidate  record;
  v_matched    integer := 0;
  v_total      integer := 0;
  v_tolerance  decimal(15,2);
BEGIN
  SELECT * INTO v_stmt FROM finance.bank_statements WHERE id = p_statement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Extracto % no encontrado', p_statement_id;
  END IF;

  FOR v_line IN
    SELECT * FROM finance.bank_statement_lines
     WHERE statement_id = p_statement_id AND state = 'pending'
     ORDER BY date, sequence
  LOOP
    v_total := v_total + 1;

    FOR v_rule IN
      SELECT * FROM finance.reconcile_rules
       WHERE organization_id = v_stmt.organization_id AND is_active AND rule_type = 'invoice_matching'
       ORDER BY sequence
    LOOP
      v_tolerance := abs(v_line.amount) * v_rule.payment_tolerance_pct / 100;

      SELECT jel.id, jel.debit - jel.credit AS net_amount
        INTO v_candidate
        FROM finance.journal_entry_lines jel
        JOIN finance.journal_entries je ON je.id = jel.entry_id
       WHERE jel.organization_id = v_stmt.organization_id
         AND je.state = 'posted'
         AND abs((jel.debit - jel.credit) - v_line.amount) <= v_tolerance
         AND NOT EXISTS (
           SELECT 1 FROM finance.bank_reconciliation_entries bre
            WHERE bre.journal_entry_line_id = jel.id
         )
         AND (NOT v_rule.match_partner OR (v_line.partner_id IS NOT NULL AND jel.organization_id = v_line.organization_id))
         AND (v_rule.match_label IS NULL
              OR (v_rule.match_label = 'contains' AND v_line.payment_ref ILIKE '%' || v_rule.match_label_param || '%')
              OR (v_rule.match_label = 'not_contains' AND (v_line.payment_ref IS NULL OR v_line.payment_ref NOT ILIKE '%' || v_rule.match_label_param || '%'))
              OR (v_rule.match_label = 'match_regex' AND v_line.payment_ref ~ v_rule.match_label_param)
         )
       ORDER BY abs((jel.debit - jel.credit) - v_line.amount) ASC
       LIMIT 1;

      IF v_candidate IS NOT NULL THEN
        INSERT INTO finance.bank_reconciliation_entries (statement_line_id, journal_entry_line_id, amount, organization_id)
        VALUES (v_line.id, v_candidate.id, v_line.amount, v_stmt.organization_id)
        ON CONFLICT (statement_line_id, journal_entry_line_id) DO NOTHING;

        UPDATE finance.bank_statement_lines SET state = 'reconciled' WHERE id = v_line.id;
        v_matched := v_matched + 1;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'statement_id', p_statement_id,
    'total_lines',  v_total,
    'matched',      v_matched,
    'unmatched',    v_total - v_matched
  );
END
$$;

-- 10. PERMISOS
REVOKE ALL ON FUNCTION finance.reconcile_statement_line(uuid, jsonb)  FROM public;
REVOKE ALL ON FUNCTION finance.unreconcile_statement_line(uuid)       FROM public;
REVOKE ALL ON FUNCTION finance.auto_reconcile_statement(uuid)         FROM public;
GRANT EXECUTE ON FUNCTION finance.reconcile_statement_line(uuid, jsonb)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.unreconcile_statement_line(uuid)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.auto_reconcile_statement(uuid)         TO authenticated, service_role;

GRANT SELECT ON finance.v_bank_statement_balances TO authenticated, service_role;
