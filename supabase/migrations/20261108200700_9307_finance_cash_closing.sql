-- =============================================================================
-- ARM Finance - Cash movements, session closing, reporting views
-- Adapted: organization_id + fn_user_org_ids()
-- =============================================================================

-- 0. PRECHECK
DO $$
DECLARE
  r       record;
  v_miss  text := '';
  v_cols  text;
BEGIN
  IF to_regclass('finance.pos_sessions') IS NULL OR to_regclass('finance.payment_methods') IS NULL THEN
    RAISE EXCEPTION '9307: falta 9303 (pos_sessions/payment_methods)';
  END IF;
  IF to_regprocedure('finance.compute_tax_multi(numeric, uuid[], boolean)') IS NULL THEN
    RAISE EXCEPTION '9307: falta 9302 (tax_engine)';
  END IF;
  IF to_regprocedure('finance.next_sequence(uuid, varchar, integer)') IS NULL
     OR to_regprocedure('finance.compute_entry_hash(jsonb, varchar)') IS NULL THEN
    RAISE EXCEPTION '9307: falta 9304 (sequences/immutability)';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('sales',               ARRAY['id','organization_id','session_id','state','total_amount','tax_amount','created_at']),
      ('sale_lines',          ARRAY['sale_id','quantity','unit_price','discount_pct','tax_config_id']),
      ('sale_payments',       ARRAY['sale_id','payment_method_id','amount']),
      ('journal_entries',     ARRAY['id','organization_id','journal_id','number','entry_type','entry_date','state',
                                    'hash_seq','hash_data','previous_hash','hash_chain']),
      ('journal_entry_lines', ARRAY['entry_id','organization_id','account_id','debit','credit','description','tax_id'])
    ) AS t(tbl, cols)
  LOOP
    IF to_regclass('finance.' || r.tbl) IS NULL THEN
      v_miss := v_miss || format(E'\n  tabla finance.%s no existe', r.tbl);
    ELSE
      SELECT string_agg(c, ', ') INTO v_cols
        FROM unnest(r.cols) AS c
       WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                          WHERE ic.table_schema = 'finance' AND ic.table_name = r.tbl AND ic.column_name = c);
      IF v_cols IS NOT NULL THEN
        v_miss := v_miss || format(E'\n  finance.%s: faltan columnas %s', r.tbl, v_cols);
      END IF;
    END IF;
  END LOOP;

  IF v_miss <> '' THEN
    RAISE EXCEPTION '9307: esquema de ventas/asientos no cumple el contrato:%', v_miss;
  END IF;
END
$$;

-- 1. finance.cash_movements
CREATE TABLE IF NOT EXISTS finance.cash_movements (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID          NOT NULL REFERENCES finance.pos_sessions (id),
  amount          DECIMAL(15,2) NOT NULL,
  reason          VARCHAR(255)  NOT NULL,
  user_id         UUID          NOT NULL DEFAULT auth.uid(),
  organization_id UUID          NOT NULL REFERENCES public.organizations(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by      UUID,
  CONSTRAINT cash_movements_amount_nonzero CHECK (amount <> 0),
  CONSTRAINT cash_movements_reason_nonblank CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON finance.cash_movements (session_id);
CREATE INDEX IF NOT EXISTS idx_cash_movements_org     ON finance.cash_movements (organization_id);

-- Guard: only allow movements on 'opened' sessions of the same org
CREATE OR REPLACE FUNCTION finance.cash_movements_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_session uuid;
  v_state   finance.session_state_enum;
  v_org     uuid;
BEGIN
  v_session := CASE WHEN TG_OP = 'DELETE' THEN OLD.session_id ELSE NEW.session_id END;

  IF TG_OP = 'UPDATE' AND NEW.session_id IS DISTINCT FROM OLD.session_id THEN
    RAISE EXCEPTION 'No se puede mover un movimiento de caja a otra sesion';
  END IF;

  SELECT ps.state, ps.organization_id INTO v_state, v_org
    FROM finance.pos_sessions ps WHERE ps.id = v_session;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sesion POS % no existe o no es accesible', v_session;
  END IF;
  IF v_state <> 'opened' THEN
    RAISE EXCEPTION 'La sesion esta en estado "%": solo se pueden registrar movimientos de caja en sesiones abiertas', v_state;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'organization_id del movimiento no coincide con el de la sesion';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS trg_cash_movements_audit ON finance.cash_movements;
CREATE TRIGGER trg_cash_movements_audit BEFORE INSERT OR UPDATE ON finance.cash_movements
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_cash_movements_guard ON finance.cash_movements;
CREATE TRIGGER trg_cash_movements_guard BEFORE INSERT OR UPDATE OR DELETE ON finance.cash_movements
  FOR EACH ROW EXECUTE FUNCTION finance.cash_movements_guard();

SELECT finance.apply_org_rls('finance.cash_movements');

-- 2. Link consolidated entry to session
ALTER TABLE finance.journal_entries
  ADD COLUMN IF NOT EXISTS pos_session_id UUID REFERENCES finance.pos_sessions (id);

CREATE INDEX IF NOT EXISTS idx_journal_entries_pos_session
  ON finance.journal_entries (pos_session_id) WHERE pos_session_id IS NOT NULL;

-- 3. Helper: valid sale states
CREATE OR REPLACE FUNCTION finance._sale_is_valid(p_state text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_state NOT IN ('draft', 'cancelled', 'voided');
$$;

-- 4. compute_session_expected_balance (replaces soft version from 9303)
CREATE OR REPLACE FUNCTION finance.compute_session_expected_balance(p_session_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = finance, public, pg_temp
AS $$
DECLARE
  v_opening numeric(15,2);
  v_cash    numeric(15,2);
  v_moves   numeric(15,2);
BEGIN
  SELECT opening_balance INTO v_opening FROM finance.pos_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sesion POS % no encontrada', p_session_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT coalesce(sum(sp.amount), 0) INTO v_cash
    FROM finance.sale_payments sp
    JOIN finance.sales s            ON s.id  = sp.sale_id
    JOIN finance.payment_methods pm ON pm.id = sp.payment_method_id
   WHERE s.session_id = p_session_id
     AND pm.type = 'cash'
     AND finance._sale_is_valid(s.state::text);

  SELECT coalesce(sum(cm.amount), 0) INTO v_moves
    FROM finance.cash_movements cm WHERE cm.session_id = p_session_id;

  RETURN v_opening + v_cash + v_moves;
END
$$;

-- 5. REPORTING VIEWS

-- 5.1 Tax lines per sale line (feeds v_tax_summary and closing)
CREATE OR REPLACE VIEW finance.v_sale_tax_lines
WITH (security_invoker = true) AS
SELECT s.organization_id,
       s.id         AS sale_id,
       s.session_id,
       (s.created_at AT TIME ZONE 'America/La_Paz')::date AS sale_date,
       t.tax_id,
       t.tax_name,
       t.account_id,
       t.base_amount,
       t.tax_amount
  FROM finance.sales s
  JOIN finance.sale_lines sl ON sl.sale_id = s.id
 CROSS JOIN LATERAL finance.compute_tax_multi(
         round(sl.quantity::numeric * sl.unit_price * (1 - coalesce(sl.discount_pct, 0) / 100), 2),
         CASE WHEN sl.tax_config_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[sl.tax_config_id] END
       ) t
 WHERE finance._sale_is_valid(s.state::text);

-- 5.2 Session summary
CREATE OR REPLACE VIEW finance.v_session_summary
WITH (security_invoker = true) AS
SELECT ps.id        AS session_id,
       ps.organization_id,
       ps.name      AS session_name,
       ps.state,
       pc.name      AS config_name,
       ps.user_id,
       ps.opened_at,
       ps.closed_at,
       coalesce(sa.sales_count, 0)             AS sales_count,
       coalesce(sa.total_sales, 0)::numeric(15,2) AS total_sales,
       coalesce(sa.total_tax, 0)::numeric(15,2)   AS total_tax,
       coalesce(pay.by_method, '{}'::jsonb)    AS total_payments_by_method,
       ps.opening_balance,
       coalesce(ps.closing_balance_expected,
                finance.compute_session_expected_balance(ps.id)) AS expected_balance,
       ps.closing_balance_real AS real_balance,
       ps.closing_difference   AS difference
  FROM finance.pos_sessions ps
  JOIN finance.pos_configs  pc ON pc.id = ps.pos_config_id
  LEFT JOIN LATERAL (
         SELECT count(*)::integer AS sales_count,
                sum(s.total_amount) AS total_sales,
                sum(s.tax_amount)   AS total_tax
           FROM finance.sales s
          WHERE s.session_id = ps.id AND finance._sale_is_valid(s.state::text)
       ) sa ON true
  LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(x.name, x.amount) AS by_method
           FROM (SELECT pm.name, sum(sp.amount) AS amount
                   FROM finance.sale_payments sp
                   JOIN finance.sales s            ON s.id  = sp.sale_id
                   JOIN finance.payment_methods pm ON pm.id = sp.payment_method_id
                  WHERE s.session_id = ps.id AND finance._sale_is_valid(s.state::text)
                  GROUP BY pm.name) x
       ) pay ON true;

-- 5.3 Daily sales
CREATE OR REPLACE VIEW finance.v_daily_sales_report
WITH (security_invoker = true) AS
SELECT s.organization_id,
       (s.created_at AT TIME ZONE 'America/La_Paz')::date AS date,
       sum(s.total_amount)::numeric(15,2)                 AS total_sales,
       sum(s.tax_amount)::numeric(15,2)                   AS total_tax,
       count(*)::integer                                  AS count_transactions,
       round(avg(s.total_amount), 2)                      AS avg_ticket
  FROM finance.sales s
 WHERE finance._sale_is_valid(s.state::text)
 GROUP BY s.organization_id, (s.created_at AT TIME ZONE 'America/La_Paz')::date;

-- 5.4 Sales by payment method and period
CREATE OR REPLACE VIEW finance.v_sales_by_payment_method
WITH (security_invoker = true) AS
SELECT s.organization_id,
       date_trunc('month', s.created_at AT TIME ZONE 'America/La_Paz')::date AS period,
       pm.id   AS payment_method_id,
       pm.name AS payment_method,
       pm.type AS payment_method_type,
       sum(sp.amount)::numeric(15,2) AS total_amount,
       count(*)::integer             AS count_transactions
  FROM finance.sale_payments sp
  JOIN finance.sales s            ON s.id  = sp.sale_id
  JOIN finance.payment_methods pm ON pm.id = sp.payment_method_id
 WHERE finance._sale_is_valid(s.state::text)
 GROUP BY s.organization_id,
          date_trunc('month', s.created_at AT TIME ZONE 'America/La_Paz')::date,
          pm.id, pm.name, pm.type;

-- 5.5 Tax summary
CREATE OR REPLACE VIEW finance.v_tax_summary
WITH (security_invoker = true) AS
SELECT l.organization_id,
       date_trunc('month', l.sale_date)::date AS period,
       l.tax_id,
       l.tax_name,
       tc.rate                                AS tax_rate,
       sum(l.base_amount)::numeric(15,2)      AS total_base,
       sum(l.tax_amount)::numeric(15,2)       AS total_tax_amount
  FROM finance.v_sale_tax_lines l
  JOIN finance.tax_configs tc ON tc.id = l.tax_id
 GROUP BY l.organization_id, date_trunc('month', l.sale_date)::date, l.tax_id, l.tax_name, tc.rate;

-- 6. close_session_full
CREATE OR REPLACE FUNCTION finance.close_session_full(
  p_session_id   uuid,
  p_real_balance numeric,
  p_notes        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = finance, public, extensions, pg_temp
AS $$
DECLARE
  v_session      finance.pos_sessions%ROWTYPE;
  v_config       finance.pos_configs%ROWTYPE;
  v_drafts       integer;
  v_expected     numeric(15,2);
  v_real         numeric(15,2);
  v_sales_count  integer;
  v_total_sales  numeric(15,2);
  v_total_tax    numeric(15,2);
  v_total_pay    numeric(15,2) := 0;
  v_tax_net      numeric(15,2) := 0;
  v_income       numeric(15,2);
  v_income_acct  uuid;
  v_lines        jsonb := '[]'::jsonb;
  v_debit        numeric(15,2);
  v_credit       numeric(15,2);
  r              record;
  v_date         date;
  v_number       text;
  v_entry_id     uuid;
  v_hash_seq     bigint;
  v_prev_hash    varchar;
  v_hash_data    jsonb;
  v_by_method    jsonb;
  v_moves        numeric(15,2);
  v_closed_at    timestamptz;
  v_diff         numeric(15,2);
BEGIN
  -- a) Validate state
  SELECT * INTO v_session FROM finance.pos_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sesion POS % no existe o no es accesible', p_session_id;
  END IF;
  IF v_session.state = 'closed' THEN
    RAISE EXCEPTION 'La sesion % ya esta cerrada', v_session.name;
  END IF;
  IF v_session.state <> 'opened' THEN
    RAISE EXCEPTION 'La sesion % esta en estado "%" y no se puede cerrar', v_session.name, v_session.state;
  END IF;

  SELECT count(*) INTO v_drafts
    FROM finance.sales s WHERE s.session_id = p_session_id AND s.state::text = 'draft';
  IF v_drafts > 0 THEN
    RAISE EXCEPTION 'No se puede cerrar la sesion %: hay % venta(s) en borrador.',
      v_session.name, v_drafts;
  END IF;

  SELECT * INTO v_config FROM finance.pos_configs WHERE id = v_session.pos_config_id;

  -- b) Expected and real balance
  v_expected := finance.compute_session_expected_balance(p_session_id);

  IF v_config.cash_control THEN
    IF p_real_balance IS NULL OR p_real_balance < 0 THEN
      RAISE EXCEPTION 'Esta caja tiene control de efectivo: el saldo real es obligatorio y no puede ser negativo';
    END IF;
    v_real := p_real_balance;
  ELSE
    v_real := v_expected;
  END IF;

  -- c) Save expected/real and transition to closing_control
  UPDATE finance.pos_sessions
     SET state                    = 'closing_control',
         closing_balance_expected = v_expected,
         closing_balance_real     = v_real,
         closing_notes            = p_notes
   WHERE id = p_session_id;

  SELECT count(*), coalesce(sum(s.total_amount), 0), coalesce(sum(s.tax_amount), 0)
    INTO v_sales_count, v_total_sales, v_total_tax
    FROM finance.sales s
   WHERE s.session_id = p_session_id AND finance._sale_is_valid(s.state::text);

  -- d) Consolidated journal entry
  IF v_sales_count > 0 THEN
    IF v_config.journal_id IS NULL THEN
      RAISE EXCEPTION 'El punto de venta "%" no tiene diario de ventas (journal_id)', v_config.name;
    END IF;
    SELECT j.default_credit_account_id INTO v_income_acct
      FROM finance.journals j WHERE j.id = v_config.journal_id;
    IF v_income_acct IS NULL THEN
      RAISE EXCEPTION 'El diario de ventas del POS "%" no tiene cuenta de ingresos (default_credit_account_id)', v_config.name;
    END IF;

    -- DR: payments grouped by method
    FOR r IN
      SELECT x.name, x.account_id, x.amount
        FROM (
          SELECT pm.name,
                 CASE pm.type::text
                   WHEN 'pay_later' THEN pm.receivable_account_id
                   WHEN 'cash'      THEN coalesce(j.default_debit_account_id, pm.outstanding_account_id)
                   ELSE                  coalesce(pm.outstanding_account_id, j.default_debit_account_id)
                 END AS account_id,
                 sum(sp.amount) AS amount
            FROM finance.sale_payments sp
            JOIN finance.sales s            ON s.id  = sp.sale_id
            JOIN finance.payment_methods pm ON pm.id = sp.payment_method_id
            LEFT JOIN finance.journals j    ON j.id  = pm.journal_id
           WHERE s.session_id = p_session_id AND finance._sale_is_valid(s.state::text)
           GROUP BY pm.id, j.id
        ) x
       WHERE x.amount <> 0
       ORDER BY x.name
    LOOP
      IF r.account_id IS NULL THEN
        RAISE EXCEPTION 'El metodo de pago "%" no tiene cuenta contable configurada', r.name;
      END IF;
      v_total_pay := v_total_pay + r.amount;
      v_lines := v_lines || jsonb_build_object(
        'account_id', r.account_id,
        'debit',      greatest(r.amount, 0),
        'credit',     greatest(-r.amount, 0),
        'description', 'Cobros ' || r.name,
        'tax_id',     NULL);
    END LOOP;

    IF v_total_pay <> v_total_sales THEN
      RAISE EXCEPTION 'Sesion %: cobros (Bs %) <> total ventas (Bs %)',
        v_session.name, v_total_pay, v_total_sales;
    END IF;

    -- CR/DR: taxes by tax and account
    FOR r IN
      SELECT l.tax_id, l.account_id, max(l.tax_name) AS tax_name, sum(l.tax_amount) AS amount
        FROM finance.v_sale_tax_lines l
       WHERE l.session_id = p_session_id
       GROUP BY l.tax_id, l.account_id
      HAVING sum(l.tax_amount) <> 0
       ORDER BY max(l.tax_name), l.tax_id
    LOOP
      IF r.account_id IS NULL THEN
        RAISE EXCEPTION 'El impuesto "%" tiene monto pero no tiene cuenta contable', r.tax_name;
      END IF;
      v_tax_net := v_tax_net + r.amount;
      v_lines := v_lines || jsonb_build_object(
        'account_id', r.account_id,
        'debit',      greatest(-r.amount, 0),
        'credit',     greatest(r.amount, 0),
        'description', r.tax_name,
        'tax_id',     r.tax_id);
    END LOOP;

    -- CR: income = total sales - net taxes
    v_income := v_total_sales - v_tax_net;
    IF v_income <> 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', v_income_acct,
        'debit',      greatest(-v_income, 0),
        'credit',     greatest(v_income, 0),
        'description', 'Ventas ' || v_session.name,
        'tax_id',     NULL);
    END IF;

    -- Double-entry validation
    SELECT coalesce(sum((e->>'debit')::numeric), 0), coalesce(sum((e->>'credit')::numeric), 0)
      INTO v_debit, v_credit
      FROM jsonb_array_elements(v_lines) e;
    IF v_debit <> v_credit THEN
      RAISE EXCEPTION 'Asiento de cierre descuadrado: debe % <> haber %', v_debit, v_credit;
    END IF;

    v_date   := (now() AT TIME ZONE 'America/La_Paz')::date;
    v_number := finance.next_sequence(v_session.organization_id, 'journal_entry',
                                      extract(year FROM v_date)::integer);

    INSERT INTO finance.journal_entries
      (organization_id, journal_id, number, entry_type, entry_date, state, pos_session_id)
    VALUES
      (v_session.organization_id, v_config.journal_id, v_number, 'entry', v_date, 'draft', p_session_id)
    RETURNING id INTO v_entry_id;

    INSERT INTO finance.journal_entry_lines
      (entry_id, organization_id, account_id, debit, credit, description, tax_id)
    SELECT v_entry_id, v_session.organization_id,
           (e->>'account_id')::uuid, (e->>'debit')::numeric, (e->>'credit')::numeric,
           e->>'description', (e->>'tax_id')::uuid
      FROM jsonb_array_elements(v_lines) e;

    -- Post with hash chain
    PERFORM pg_advisory_xact_lock(hashtextextended(v_config.journal_id::text, 0));

    SELECT je.hash_seq, je.hash_chain INTO v_hash_seq, v_prev_hash
      FROM finance.journal_entries je
     WHERE je.organization_id = v_session.organization_id AND je.journal_id = v_config.journal_id
       AND je.hash_chain IS NOT NULL
     ORDER BY je.hash_seq DESC
     LIMIT 1;

    v_hash_data := jsonb_build_object(
      'number',          v_number,
      'date',            v_date,
      'journal_id',      v_config.journal_id,
      'organization_id', v_session.organization_id,
      'ref',             v_session.name,
      'lines', (SELECT jsonb_agg(jsonb_build_object(
                          'account_id', e->>'account_id',
                          'debit',      round((e->>'debit')::numeric, 2)::text,
                          'credit',     round((e->>'credit')::numeric, 2)::text)
                        ORDER BY ord)
                  FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS t(e, ord)));

    UPDATE finance.journal_entries
       SET state         = 'posted',
           hash_seq      = coalesce(v_hash_seq, 0) + 1,
           hash_data     = v_hash_data,
           previous_hash = coalesce(v_prev_hash, ''),
           hash_chain    = finance.compute_entry_hash(v_hash_data, coalesce(v_prev_hash, ''))
     WHERE id = v_entry_id;
  END IF;

  -- e) Close session
  v_closed_at := now();
  UPDATE finance.pos_sessions
     SET state = 'closed', closed_at = v_closed_at
   WHERE id = p_session_id
  RETURNING closing_difference INTO v_diff;

  -- f) Return summary
  SELECT coalesce(jsonb_object_agg(x.name, x.amount), '{}'::jsonb) INTO v_by_method
    FROM (SELECT pm.name, sum(sp.amount) AS amount
            FROM finance.sale_payments sp
            JOIN finance.sales s            ON s.id  = sp.sale_id
            JOIN finance.payment_methods pm ON pm.id = sp.payment_method_id
           WHERE s.session_id = p_session_id AND finance._sale_is_valid(s.state::text)
           GROUP BY pm.name) x;

  SELECT coalesce(sum(cm.amount), 0) INTO v_moves
    FROM finance.cash_movements cm WHERE cm.session_id = p_session_id;

  RETURN jsonb_build_object(
    'session_id',             p_session_id,
    'session_name',           v_session.name,
    'state',                  'closed',
    'opened_at',              v_session.opened_at,
    'closed_at',              v_closed_at,
    'opening_balance',        v_session.opening_balance,
    'sales_count',            v_sales_count,
    'total_sales',            v_total_sales,
    'total_tax',              v_total_tax,
    'payments_by_method',     v_by_method,
    'cash_movements_total',   v_moves,
    'expected_balance',       v_expected,
    'real_balance',           v_real,
    'difference',             v_diff,
    'journal_entry_id',       v_entry_id,
    'journal_entry_number',   v_number,
    'notes',                  p_notes);
END
$$;

-- 7. PERMISSIONS
REVOKE ALL ON FUNCTION finance.compute_session_expected_balance(uuid)         FROM public;
REVOKE ALL ON FUNCTION finance.close_session_full(uuid, numeric, text)        FROM public;
REVOKE ALL ON FUNCTION finance._sale_is_valid(text)                           FROM public;
REVOKE ALL ON FUNCTION finance.cash_movements_guard()                         FROM public;
GRANT EXECUTE ON FUNCTION finance.compute_session_expected_balance(uuid)      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.close_session_full(uuid, numeric, text)     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance._sale_is_valid(text)                        TO authenticated, service_role;

GRANT SELECT ON finance.v_sale_tax_lines, finance.v_session_summary, finance.v_daily_sales_report,
                finance.v_sales_by_payment_method, finance.v_tax_summary
  TO authenticated, service_role;
