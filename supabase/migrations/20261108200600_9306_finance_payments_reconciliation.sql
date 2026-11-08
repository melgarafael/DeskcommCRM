-- =============================================================================
-- ARM Finance - Payments, reconciliation, CxC/CxP views
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
      ('journal_entries','id'), ('journal_entries','organization_id'), ('journal_entries','journal_id'),
      ('journal_entries','number'), ('journal_entries','entry_date'), ('journal_entries','state'),
      ('journal_entries','partner_id'), ('journal_entries','payment_state'),
      ('journal_entry_lines','id'), ('journal_entry_lines','organization_id'), ('journal_entry_lines','entry_id'),
      ('journal_entry_lines','account_id'), ('journal_entry_lines','debit'), ('journal_entry_lines','credit'),
      ('journal_entry_lines','description'),
      ('chart_of_accounts','id'), ('journals','id'), ('payment_methods','id')
    ) AS t(tbl, col)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'finance' AND c.table_name = r.tbl AND c.column_name = r.col) THEN
      v_miss := v_miss || format(' finance.%s.%s', r.tbl, r.col);
    END IF;
  END LOOP;

  IF v_miss <> '' THEN
    RAISE EXCEPTION '9306: faltan dependencias:%', v_miss;
  END IF;
END
$$;

-- 1. finance.payments
CREATE TABLE IF NOT EXISTS finance.payments (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  number                VARCHAR(50),
  journal_entry_id      UUID          REFERENCES finance.journal_entries (id),
  partner_id            UUID          NOT NULL,
  amount                DECIMAL(15,2) NOT NULL,
  payment_type          VARCHAR(10)   NOT NULL DEFAULT 'inbound'
                        CHECK (payment_type IN ('inbound', 'outbound')),
  payment_method_id     UUID,
  journal_id            UUID          REFERENCES finance.journals (id),
  state                 VARCHAR(20)   NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft', 'in_process', 'paid', 'cancelled', 'rejected')),
  payment_date          DATE          NOT NULL DEFAULT CURRENT_DATE,
  reference             VARCHAR(255),
  memo                  TEXT,
  is_internal_transfer  BOOLEAN       NOT NULL DEFAULT false,
  paired_payment_id     UUID,
  organization_id       UUID          NOT NULL REFERENCES public.organizations(id),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by            UUID,
  CONSTRAINT payments_amount_positive CHECK (amount > 0),
  CONSTRAINT payments_id_org_uniq  UNIQUE (id, organization_id),
  CONSTRAINT payments_org_number_uniq UNIQUE (organization_id, number),
  CONSTRAINT payments_method_fk FOREIGN KEY (payment_method_id, organization_id)
    REFERENCES finance.payment_methods (id, organization_id),
  CONSTRAINT payments_paired_fk FOREIGN KEY (paired_payment_id, organization_id)
    REFERENCES finance.payments (id, organization_id),
  CONSTRAINT payments_paired_chk
    CHECK (paired_payment_id IS NULL OR (is_internal_transfer AND paired_payment_id <> id))
);

CREATE INDEX IF NOT EXISTS idx_payments_org_partner ON finance.payments (organization_id, partner_id);
CREATE INDEX IF NOT EXISTS idx_payments_journal_entry  ON finance.payments (journal_entry_id);

-- 2. finance.full_reconciliations
CREATE TABLE IF NOT EXISTS finance.full_reconciliations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(50) NOT NULL,
  organization_id UUID   NOT NULL REFERENCES public.organizations(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID,
  CONSTRAINT full_reconciliations_id_org_uniq UNIQUE (id, organization_id),
  CONSTRAINT full_reconciliations_org_name_uniq UNIQUE (organization_id, name)
);

-- 3. finance.payment_reconciliations
CREATE TABLE IF NOT EXISTS finance.payment_reconciliations (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  debit_line_id  UUID          NOT NULL REFERENCES finance.journal_entry_lines (id),
  credit_line_id UUID          NOT NULL REFERENCES finance.journal_entry_lines (id),
  amount         DECIMAL(15,2) NOT NULL,
  reconciled_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  organization_id UUID         NOT NULL REFERENCES public.organizations(id),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by     UUID,
  CONSTRAINT payment_reconciliations_amount_positive CHECK (amount > 0),
  CONSTRAINT payment_reconciliations_distinct_lines  CHECK (debit_line_id <> credit_line_id)
);

-- 4. full_reconciliation_id FK
ALTER TABLE finance.payment_reconciliations
  ADD COLUMN IF NOT EXISTS full_reconciliation_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payment_reconciliations_full_fk'
                    AND conrelid = 'finance.payment_reconciliations'::regclass) THEN
    ALTER TABLE finance.payment_reconciliations
      ADD CONSTRAINT payment_reconciliations_full_fk
      FOREIGN KEY (full_reconciliation_id, organization_id)
      REFERENCES finance.full_reconciliations (id, organization_id)
      ON DELETE SET NULL (full_reconciliation_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_payrec_debit_line  ON finance.payment_reconciliations (debit_line_id);
CREATE INDEX IF NOT EXISTS idx_payrec_credit_line ON finance.payment_reconciliations (credit_line_id);
CREATE INDEX IF NOT EXISTS idx_payrec_full        ON finance.payment_reconciliations (full_reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_payrec_org         ON finance.payment_reconciliations (organization_id);

-- 5. VALIDATION TRIGGER
CREATE OR REPLACE FUNCTION finance.check_payment_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, finance, pg_temp
AS $$
DECLARE
  v_d      finance.journal_entry_lines%ROWTYPE;
  v_c      finance.journal_entry_lines%ROWTYPE;
  v_used   numeric;
  v_posted boolean;
BEGIN
  PERFORM 1 FROM finance.journal_entry_lines
   WHERE id IN (NEW.debit_line_id, NEW.credit_line_id)
   ORDER BY id FOR UPDATE;

  SELECT * INTO v_d FROM finance.journal_entry_lines WHERE id = NEW.debit_line_id;
  SELECT * INTO v_c FROM finance.journal_entry_lines WHERE id = NEW.credit_line_id;
  IF v_d.id IS NULL OR v_c.id IS NULL THEN
    RAISE EXCEPTION 'conciliacion: linea inexistente o no visible';
  END IF;

  IF v_d.organization_id <> NEW.organization_id OR v_c.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'conciliacion: las lineas pertenecen a otra organizacion';
  END IF;
  IF v_d.account_id <> v_c.account_id THEN
    RAISE EXCEPTION 'conciliacion: ambas lineas deben ser de la misma cuenta';
  END IF;
  IF v_d.debit <= 0 OR v_c.credit <= 0 THEN
    RAISE EXCEPTION 'conciliacion: debit_line_id debe tener debito y credit_line_id credito';
  END IF;

  SELECT bool_and(je.state::text = 'posted') INTO v_posted
    FROM finance.journal_entries je WHERE je.id IN (v_d.entry_id, v_c.entry_id);
  IF v_posted IS NOT TRUE THEN
    RAISE EXCEPTION 'conciliacion: solo se concilian lineas de asientos publicados (posted)';
  END IF;

  SELECT coalesce(sum(r.amount), 0) INTO v_used
    FROM finance.payment_reconciliations r
   WHERE r.debit_line_id = NEW.debit_line_id AND r.id <> NEW.id;
  IF v_used + NEW.amount > v_d.debit THEN
    RAISE EXCEPTION 'conciliacion: excede el debito de la linea % (usado %, nuevo %, linea %)',
      v_d.id, v_used, NEW.amount, v_d.debit;
  END IF;

  SELECT coalesce(sum(r.amount), 0) INTO v_used
    FROM finance.payment_reconciliations r
   WHERE r.credit_line_id = NEW.credit_line_id AND r.id <> NEW.id;
  IF v_used + NEW.amount > v_c.credit THEN
    RAISE EXCEPTION 'conciliacion: excede el credito de la linea % (usado %, nuevo %, linea %)',
      v_c.id, v_used, NEW.amount, v_c.credit;
  END IF;

  RETURN NEW;
END
$$;

-- 6. TRIGGERS
DROP TRIGGER IF EXISTS trg_payments_audit ON finance.payments;
CREATE TRIGGER trg_payments_audit BEFORE INSERT OR UPDATE ON finance.payments
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_full_reconciliations_audit ON finance.full_reconciliations;
CREATE TRIGGER trg_full_reconciliations_audit BEFORE INSERT OR UPDATE ON finance.full_reconciliations
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_payment_reconciliations_audit ON finance.payment_reconciliations;
CREATE TRIGGER trg_payment_reconciliations_audit BEFORE INSERT OR UPDATE ON finance.payment_reconciliations
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_payment_reconciliations_check ON finance.payment_reconciliations;
CREATE TRIGGER trg_payment_reconciliations_check
  BEFORE INSERT OR UPDATE OF debit_line_id, credit_line_id, amount ON finance.payment_reconciliations
  FOR EACH ROW EXECUTE FUNCTION finance.check_payment_reconciliation();

-- 7. RLS
SELECT finance.apply_org_rls('finance.payments');
SELECT finance.apply_org_rls('finance.full_reconciliations');
SELECT finance.apply_org_rls('finance.payment_reconciliations');

-- 8. IMMUTABILITY: payment_state is the only field that can change on a posted entry
CREATE OR REPLACE FUNCTION finance.prevent_posted_modification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state::text <> 'posted' THEN
    RETURN NEW;
  END IF;

  IF NEW.state::text = 'cancelled'
     AND (to_jsonb(NEW) - 'state' - 'updated_by' - 'updated_at')
       = (to_jsonb(OLD) - 'state' - 'updated_by' - 'updated_at')
  THEN
    RETURN NEW;
  END IF;

  IF NEW.state::text = 'posted'
     AND (to_jsonb(NEW) -> 'payment_state') IS DISTINCT FROM (to_jsonb(OLD) -> 'payment_state')
     AND (to_jsonb(NEW) - 'payment_state' - 'updated_by' - 'updated_at')
       = (to_jsonb(OLD) - 'payment_state' - 'updated_by' - 'updated_at')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Registro % de %.% esta publicado (posted) y es inmutable. Solo se permite anularlo (posted -> cancelled); para corregir use nota de credito o reversion.',
    OLD.id, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- 9. HELPERS
CREATE OR REPLACE FUNCTION finance.line_residual(p_line_id UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public, finance, pg_temp
AS $$
  SELECT (l.debit - l.credit)
       - coalesce((SELECT sum(r.amount) FROM finance.payment_reconciliations r WHERE r.debit_line_id  = l.id), 0)
       + coalesce((SELECT sum(r.amount) FROM finance.payment_reconciliations r WHERE r.credit_line_id = l.id), 0)
    FROM finance.journal_entry_lines l
   WHERE l.id = p_line_id;
$$;

CREATE OR REPLACE FUNCTION finance.refresh_payment_state(p_entry_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public, finance, pg_temp
AS $$
DECLARE
  v_total numeric;
  v_open  numeric;
  v_state text;
BEGIN
  SELECT coalesce(sum(abs(l.debit - l.credit)), 0),
         coalesce(sum(abs(finance.line_residual(l.id))), 0)
    INTO v_total, v_open
    FROM finance.journal_entry_lines l
    JOIN finance.chart_of_accounts a ON a.id = l.account_id
   WHERE l.entry_id = p_entry_id
     AND a.account_type::text IN ('asset_receivable', 'liability_payable');

  v_state := CASE
    WHEN v_total = 0     THEN 'not_paid'
    WHEN v_open  = 0     THEN 'paid'
    WHEN v_open < v_total THEN 'partial'
    ELSE 'not_paid'
  END;

  UPDATE finance.journal_entries
     SET payment_state = v_state::finance.payment_state_enum
   WHERE id = p_entry_id
     AND payment_state::text IS DISTINCT FROM v_state;

  RETURN v_state;
END
$$;

-- 10. register_payment
CREATE OR REPLACE FUNCTION finance.register_payment(p_params JSONB)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, finance, extensions, pg_temp
AS $$
DECLARE
  v_org_id      uuid;
  v_partner     uuid;
  v_amount      numeric(15,2);
  v_type        text;
  v_sign        int;
  v_ctrl_type   text;
  v_date        date;
  v_year        int;
  v_method      finance.payment_methods%ROWTYPE;
  v_journal     finance.journals%ROWTYPE;
  v_journal_id  uuid;
  v_bank_acct   uuid;
  v_ctrl_acct   uuid;
  v_invoice_ids uuid[] := '{}';
  v_number      text;
  v_entry_num   text;
  v_entry_id    uuid;
  v_pay_id      uuid;
  v_pay_line    uuid;
  v_remaining   numeric(15,2);
  v_apply       numeric(15,2);
  v_debit_line  uuid;
  v_credit_line uuid;
  v_touched     uuid[] := '{}';
  v_comp        uuid[];
  v_full_id     uuid;
  r             record;
BEGIN
  v_org_id := nullif(p_params->>'organization_id', '')::uuid;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'register_payment: organization_id es obligatorio';
  END IF;

  v_partner := nullif(p_params->>'partner_id', '')::uuid;
  v_amount  := round(nullif(p_params->>'amount', '')::numeric, 2);
  v_type    := coalesce(nullif(p_params->>'payment_type', ''), 'inbound');
  v_date    := coalesce(nullif(p_params->>'payment_date', '')::date, CURRENT_DATE);
  v_year    := extract(year FROM v_date)::int;

  IF v_partner IS NULL THEN RAISE EXCEPTION 'register_payment: partner_id es obligatorio'; END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'register_payment: amount debe ser mayor a 0'; END IF;
  IF v_type NOT IN ('inbound', 'outbound') THEN RAISE EXCEPTION 'register_payment: payment_type invalido: %', v_type; END IF;
  IF coalesce((p_params->>'is_internal_transfer')::boolean, false) THEN
    RAISE EXCEPTION 'register_payment: las transferencias internas no estan soportadas por esta funcion';
  END IF;

  v_sign      := CASE WHEN v_type = 'inbound' THEN 1 ELSE -1 END;
  v_ctrl_type := CASE WHEN v_type = 'inbound' THEN 'asset_receivable' ELSE 'liability_payable' END;

  IF jsonb_typeof(p_params->'invoice_entry_ids') = 'array' THEN
    SELECT coalesce(array_agg(x::uuid), '{}') INTO v_invoice_ids
      FROM jsonb_array_elements_text(p_params->'invoice_entry_ids') x;
  END IF;

  IF nullif(p_params->>'payment_method_id', '') IS NOT NULL THEN
    SELECT * INTO v_method FROM finance.payment_methods
     WHERE id = (p_params->>'payment_method_id')::uuid AND organization_id = v_org_id AND is_active;
    IF v_method.id IS NULL THEN
      RAISE EXCEPTION 'register_payment: metodo de pago inexistente o inactivo';
    END IF;
  END IF;

  v_journal_id := coalesce(nullif(p_params->>'journal_id', '')::uuid, v_method.journal_id);
  IF v_journal_id IS NULL THEN
    RAISE EXCEPTION 'register_payment: falta journal_id (ni el metodo de pago tiene diario)';
  END IF;
  SELECT * INTO v_journal FROM finance.journals
   WHERE id = v_journal_id AND organization_id = v_org_id AND is_active;
  IF v_journal.id IS NULL OR v_journal.type::text NOT IN ('bank', 'cash') THEN
    RAISE EXCEPTION 'register_payment: el diario debe existir, estar activo y ser de tipo banco o caja';
  END IF;

  v_bank_acct := coalesce(
    nullif(p_params->>'bank_account_id', '')::uuid,
    CASE WHEN v_type = 'inbound' THEN v_journal.default_debit_account_id
         ELSE v_journal.default_credit_account_id END);
  IF v_bank_acct IS NULL THEN
    RAISE EXCEPTION 'register_payment: el diario % no tiene cuenta por defecto; enviar bank_account_id', v_journal.code;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_org_id::text || v_partner::text, 0));

  v_ctrl_acct := nullif(p_params->>'counterpart_account_id', '')::uuid;
  IF v_ctrl_acct IS NULL THEN
    SELECT l.account_id INTO v_ctrl_acct
      FROM finance.journal_entry_lines l
      JOIN finance.journal_entries je ON je.id = l.entry_id
      JOIN finance.chart_of_accounts a ON a.id = l.account_id
     WHERE l.organization_id = v_org_id AND je.partner_id = v_partner
       AND je.state::text = 'posted'
       AND a.account_type::text = v_ctrl_type
       AND v_sign * (l.debit - l.credit) > 0
       AND v_sign * finance.line_residual(l.id) > 0
       AND (cardinality(v_invoice_ids) = 0 OR je.id = ANY (v_invoice_ids))
     ORDER BY je.entry_date, je.number, l.id
     LIMIT 1;
  END IF;
  IF v_ctrl_acct IS NULL THEN
    SELECT a.id INTO v_ctrl_acct FROM finance.chart_of_accounts a
     WHERE a.organization_id = v_org_id AND a.is_active AND a.account_type::text = v_ctrl_type
     ORDER BY a.code LIMIT 1;
  END IF;
  IF v_ctrl_acct IS NULL THEN
    RAISE EXCEPTION 'register_payment: no hay cuenta % en el plan de cuentas', v_ctrl_type;
  END IF;

  v_number    := finance.next_sequence(v_org_id, 'payment', v_year);
  v_entry_num := finance.next_sequence(v_org_id, 'journal_entry', v_year);

  INSERT INTO finance.journal_entries (organization_id, journal_id, number, entry_date, state, partner_id)
  VALUES (v_org_id, v_journal_id, v_entry_num, v_date, 'draft', v_partner)
  RETURNING id INTO v_entry_id;

  IF v_type = 'inbound' THEN
    INSERT INTO finance.journal_entry_lines (organization_id, entry_id, account_id, debit, credit, description)
    VALUES (v_org_id, v_entry_id, v_bank_acct, v_amount, 0, 'Pago ' || v_number);
    INSERT INTO finance.journal_entry_lines (organization_id, entry_id, account_id, debit, credit, description)
    VALUES (v_org_id, v_entry_id, v_ctrl_acct, 0, v_amount, 'Pago ' || v_number)
    RETURNING id INTO v_pay_line;
  ELSE
    INSERT INTO finance.journal_entry_lines (organization_id, entry_id, account_id, debit, credit, description)
    VALUES (v_org_id, v_entry_id, v_ctrl_acct, v_amount, 0, 'Pago ' || v_number)
    RETURNING id INTO v_pay_line;
    INSERT INTO finance.journal_entry_lines (organization_id, entry_id, account_id, debit, credit, description)
    VALUES (v_org_id, v_entry_id, v_bank_acct, 0, v_amount, 'Pago ' || v_number);
  END IF;

  PERFORM finance._post_entry(v_entry_id, 'not_paid');

  INSERT INTO finance.payments (
    number, journal_entry_id, partner_id, amount, payment_type, payment_method_id, journal_id,
    state, payment_date, reference, memo, organization_id)
  VALUES (
    v_number, v_entry_id, v_partner, v_amount, v_type, v_method.id, v_journal_id,
    'paid', v_date, nullif(p_params->>'reference', ''), nullif(p_params->>'memo', ''), v_org_id)
  RETURNING id INTO v_pay_id;

  v_remaining := v_amount;
  FOR r IN
    SELECT l.id AS line_id, je.id AS entry_id,
           (v_sign * finance.line_residual(l.id))::numeric(15,2) AS open_amount
      FROM finance.journal_entry_lines l
      JOIN finance.journal_entries je ON je.id = l.entry_id
     WHERE l.organization_id = v_org_id AND je.partner_id = v_partner
       AND je.state::text = 'posted'
       AND l.account_id = v_ctrl_acct
       AND je.id <> v_entry_id
       AND v_sign * (l.debit - l.credit) > 0
       AND v_sign * finance.line_residual(l.id) > 0
       AND (cardinality(v_invoice_ids) = 0 OR je.id = ANY (v_invoice_ids))
     ORDER BY je.entry_date, je.number, l.id
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_apply := least(v_remaining, r.open_amount);

    IF v_type = 'inbound' THEN
      v_debit_line := r.line_id;  v_credit_line := v_pay_line;
    ELSE
      v_debit_line := v_pay_line; v_credit_line := r.line_id;
    END IF;

    INSERT INTO finance.payment_reconciliations (debit_line_id, credit_line_id, amount, organization_id)
    VALUES (v_debit_line, v_credit_line, v_apply, v_org_id);

    v_remaining := v_remaining - v_apply;
    IF NOT (r.entry_id = ANY (v_touched)) THEN
      v_touched := array_append(v_touched, r.entry_id);
    END IF;
  END LOOP;

  FOREACH v_entry_id IN ARRAY v_touched LOOP
    PERFORM finance.refresh_payment_state(v_entry_id);
  END LOOP;

  IF cardinality(v_touched) > 0 THEN
    WITH RECURSIVE comp(line_id) AS (
      SELECT v_pay_line
      UNION
      SELECT CASE WHEN pr.debit_line_id = c.line_id THEN pr.credit_line_id ELSE pr.debit_line_id END
        FROM comp c
        JOIN finance.payment_reconciliations pr
          ON pr.organization_id = v_org_id
         AND (pr.debit_line_id = c.line_id OR pr.credit_line_id = c.line_id)
    )
    SELECT array_agg(line_id) INTO v_comp FROM comp;

    IF NOT EXISTS (SELECT 1 FROM unnest(v_comp) AS u(line_id) WHERE finance.line_residual(u.line_id) <> 0) THEN
      INSERT INTO finance.full_reconciliations (name, organization_id)
      VALUES ('A' || upper(left(replace(gen_random_uuid()::text, '-', ''), 12)), v_org_id)
      RETURNING id INTO v_full_id;

      UPDATE finance.payment_reconciliations
         SET full_reconciliation_id = v_full_id
       WHERE organization_id = v_org_id
         AND full_reconciliation_id IS NULL
         AND (debit_line_id = ANY (v_comp) OR credit_line_id = ANY (v_comp));
    END IF;
  END IF;

  RETURN v_pay_id;
END
$$;

REVOKE ALL ON FUNCTION finance.register_payment(JSONB)   FROM public;
REVOKE ALL ON FUNCTION finance.refresh_payment_state(UUID) FROM public;
REVOKE ALL ON FUNCTION finance.line_residual(UUID)       FROM public;
GRANT EXECUTE ON FUNCTION finance.register_payment(JSONB)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.refresh_payment_state(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.line_residual(UUID)       TO authenticated, service_role;

-- 11. VIEWS CxC / CxP
CREATE OR REPLACE VIEW finance.v_receivable_payable_lines
WITH (security_invoker = true) AS
SELECT
  l.id            AS line_id,
  l.organization_id,
  je.id           AS entry_id,
  je.number       AS entry_number,
  je.entry_date         AS entry_date,
  je.partner_id,
  je.payment_state::text AS payment_state,
  l.account_id,
  a.code          AS account_code,
  a.account_type::text AS account_type,
  (l.debit - l.credit) AS balance,
  (l.debit - l.credit)
    - coalesce(rd.amt, 0) + coalesce(rc.amt, 0) AS residual
FROM finance.journal_entry_lines l
JOIN finance.journal_entries   je ON je.id = l.entry_id
JOIN finance.chart_of_accounts a  ON a.id  = l.account_id
LEFT JOIN LATERAL (SELECT sum(r.amount) AS amt FROM finance.payment_reconciliations r
                    WHERE r.debit_line_id = l.id)  rd ON true
LEFT JOIN LATERAL (SELECT sum(r.amount) AS amt FROM finance.payment_reconciliations r
                    WHERE r.credit_line_id = l.id) rc ON true
WHERE je.state::text = 'posted'
  AND a.account_type::text IN ('asset_receivable', 'liability_payable');

CREATE OR REPLACE VIEW finance.v_accounts_receivable
WITH (security_invoker = true) AS
SELECT
  organization_id,
  partner_id,
  entry_id        AS invoice_entry_id,
  entry_number    AS invoice_number,
  entry_date      AS invoice_date,
  line_id,
  account_id,
  balance                AS total,
  balance - residual     AS paid,
  residual               AS balance_remaining,
  (residual <> 0)        AS is_open,
  payment_state
FROM finance.v_receivable_payable_lines
WHERE account_type = 'asset_receivable';

CREATE OR REPLACE VIEW finance.v_accounts_payable
WITH (security_invoker = true) AS
SELECT
  organization_id,
  partner_id,
  entry_id        AS invoice_entry_id,
  entry_number    AS invoice_number,
  entry_date      AS invoice_date,
  line_id,
  account_id,
  -balance               AS total,
  -(balance - residual)  AS paid,
  -residual              AS balance_remaining,
  (residual <> 0)        AS is_open,
  payment_state
FROM finance.v_receivable_payable_lines
WHERE account_type = 'liability_payable';

GRANT SELECT ON finance.v_receivable_payable_lines, finance.v_accounts_receivable, finance.v_accounts_payable
  TO authenticated, service_role;
