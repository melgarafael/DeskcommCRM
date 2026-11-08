-- =============================================================================
-- ARM Finance - Atomic sale (journal entries, sales, lines, payments,
-- create_sale_atomic, void_sale)
-- Adapted: organization_id + fn_user_org_ids()
-- =============================================================================

-- 0. PRE-REQUISITOS
DO $$
DECLARE
  v_missing text := '';
BEGIN
  IF to_regclass('finance.chart_of_accounts') IS NULL THEN v_missing := v_missing || ' chart_of_accounts(9301)'; END IF;
  IF to_regclass('finance.journals')          IS NULL THEN v_missing := v_missing || ' journals(9301)'; END IF;
  IF to_regclass('finance.tax_configs')       IS NULL THEN v_missing := v_missing || ' tax_configs(9302)'; END IF;
  IF to_regclass('finance.pos_sessions')      IS NULL THEN v_missing := v_missing || ' pos_sessions(9303)'; END IF;
  IF to_regclass('finance.pos_configs')       IS NULL THEN v_missing := v_missing || ' pos_configs(9303)'; END IF;
  IF to_regclass('finance.payment_methods')   IS NULL THEN v_missing := v_missing || ' payment_methods(9303)'; END IF;
  IF to_regclass('finance.pos_config_payment_methods') IS NULL THEN v_missing := v_missing || ' pos_config_payment_methods(9303)'; END IF;
  IF to_regprocedure('finance.next_sequence(uuid,character varying,integer,uuid)') IS NULL THEN v_missing := v_missing || ' next_sequence(9304)'; END IF;
  IF to_regprocedure('finance.compute_entry_hash(jsonb,character varying)') IS NULL THEN v_missing := v_missing || ' compute_entry_hash(9304)'; END IF;
  IF to_regprocedure('finance.prevent_posted_modification()') IS NULL THEN v_missing := v_missing || ' prevent_posted_modification(9304)'; END IF;
  IF to_regprocedure('finance.compute_tax_multi(numeric,uuid[],boolean)') IS NULL THEN v_missing := v_missing || ' compute_tax_multi(9302)'; END IF;
  IF to_regprocedure('finance.compute_session_expected_balance(uuid)') IS NULL THEN v_missing := v_missing || ' compute_session_expected_balance(9303)'; END IF;
  IF v_missing <> '' THEN
    RAISE EXCEPTION '9305: faltan prerequisitos de migraciones previas:%', v_missing;
  END IF;
END
$$;

-- UNIQUE(id, organization_id) on prior tables for composite FKs
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('finance.journals',     'journals_id_org_key'),
      ('finance.pos_sessions', 'pos_sessions_id_org_key'),
      ('finance.tax_configs',  'tax_configs_id_org_key')
    ) AS t(tbl, cname)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.cname AND conrelid = r.tbl::regclass) THEN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (id, organization_id)', r.tbl, r.cname);
    END IF;
  END LOOP;
END
$$;

-- 1. journal_entries
CREATE TABLE IF NOT EXISTS finance.journal_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number            VARCHAR(50) NOT NULL,
  journal_id        UUID NOT NULL,
  entry_type        finance.move_type_enum NOT NULL,
  entry_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  state             finance.entry_state_enum NOT NULL DEFAULT 'draft',
  payment_state     finance.payment_state_enum DEFAULT 'not_paid',
  partner_id        UUID,
  currency_code     VARCHAR(3) NOT NULL DEFAULT 'BOB',
  amount_untaxed    DECIMAL(15,2) NOT NULL DEFAULT 0,
  amount_tax        DECIMAL(15,2) NOT NULL DEFAULT 0,
  amount_total      DECIMAL(15,2) NOT NULL DEFAULT 0,
  reversed_entry_id UUID,
  hash_seq          BIGINT,
  hash_data         JSONB,
  previous_hash     VARCHAR(64),
  hash_chain        VARCHAR(64),
  pos_session_id    UUID,
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID,
  CONSTRAINT journal_entries_number_org_key UNIQUE (number, organization_id),
  CONSTRAINT journal_entries_id_org_key     UNIQUE (id, organization_id),
  CONSTRAINT journal_entries_journal_fk
    FOREIGN KEY (journal_id, organization_id) REFERENCES finance.journals (id, organization_id),
  CONSTRAINT journal_entries_reversed_fk
    FOREIGN KEY (reversed_entry_id, organization_id) REFERENCES finance.journal_entries (id, organization_id),
  CONSTRAINT journal_entries_session_fk
    FOREIGN KEY (pos_session_id, organization_id) REFERENCES finance.pos_sessions (id, organization_id),
  CONSTRAINT journal_entries_not_self_reversal CHECK (reversed_entry_id IS DISTINCT FROM id),
  CONSTRAINT journal_entries_posted_has_hash   CHECK (state <> 'posted' OR hash_chain IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_org_journal_date
  ON finance.journal_entries (organization_id, journal_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_session
  ON finance.journal_entries (pos_session_id) WHERE pos_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_reversed
  ON finance.journal_entries (reversed_entry_id) WHERE reversed_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_hash_seq
  ON finance.journal_entries (journal_id, hash_seq) WHERE hash_seq IS NOT NULL;

-- 2. journal_entry_lines
CREATE TABLE IF NOT EXISTS finance.journal_entry_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     UUID NOT NULL,
  account_id   UUID NOT NULL,
  debit        DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit       DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description  VARCHAR(500),
  partner_id   UUID,
  tax_id       UUID,
  quantity     DECIMAL(15,4) DEFAULT 1,
  product_name VARCHAR(255),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID,
  CONSTRAINT jel_entry_fk
    FOREIGN KEY (entry_id, organization_id) REFERENCES finance.journal_entries (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT jel_account_fk
    FOREIGN KEY (account_id, organization_id) REFERENCES finance.chart_of_accounts (id, organization_id),
  CONSTRAINT jel_tax_fk
    FOREIGN KEY (tax_id, organization_id) REFERENCES finance.tax_configs (id, organization_id),
  CONSTRAINT jel_debit_xor_credit CHECK (debit = 0 OR credit = 0)
);

CREATE INDEX IF NOT EXISTS idx_jel_entry   ON finance.journal_entry_lines (entry_id);
CREATE INDEX IF NOT EXISTS idx_jel_account ON finance.journal_entry_lines (organization_id, account_id);

-- 3. sales / sale_lines / sale_payments
CREATE TABLE IF NOT EXISTS finance.sales (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number            VARCHAR(50) NOT NULL,
  session_id        UUID NOT NULL,
  journal_entry_id  UUID,
  client_id         UUID,
  total_amount      DECIMAL(15,2) NOT NULL CHECK (total_amount >= 0),
  tax_amount        DECIMAL(15,2) NOT NULL,
  paid_amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
  change_amount     DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
  state             VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (state IN ('draft', 'paid', 'done', 'invoiced', 'cancelled')),
  fiscal_position_id UUID,
  void_reason       TEXT,
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID,
  CONSTRAINT sales_number_org_key UNIQUE (number, organization_id),
  CONSTRAINT sales_id_org_key     UNIQUE (id, organization_id),
  CONSTRAINT sales_session_fk
    FOREIGN KEY (session_id, organization_id) REFERENCES finance.pos_sessions (id, organization_id),
  CONSTRAINT sales_entry_fk
    FOREIGN KEY (journal_entry_id, organization_id) REFERENCES finance.journal_entries (id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_session ON finance.sales (session_id);
CREATE INDEX IF NOT EXISTS idx_sales_entry   ON finance.sales (journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_org_created ON finance.sales (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS finance.sale_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id       UUID NOT NULL,
  product_id    UUID,
  product_name  VARCHAR(255) NOT NULL,
  quantity      DECIMAL(15,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price    DECIMAL(15,2) NOT NULL CHECK (unit_price >= 0),
  discount_pct  DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  tax_config_id UUID,
  line_total    DECIMAL(15,2) GENERATED ALWAYS AS
                  (quantity * unit_price * (1 - discount_pct / 100)) STORED,
  tax_amount    DECIMAL(15,2) NOT NULL DEFAULT 0,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID,
  CONSTRAINT sale_lines_sale_fk
    FOREIGN KEY (sale_id, organization_id) REFERENCES finance.sales (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT sale_lines_tax_fk
    FOREIGN KEY (tax_config_id, organization_id) REFERENCES finance.tax_configs (id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_sale_lines_sale ON finance.sale_lines (sale_id);

CREATE TABLE IF NOT EXISTS finance.sale_payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id           UUID NOT NULL,
  payment_method_id UUID NOT NULL,
  amount            DECIMAL(15,2) NOT NULL CHECK (amount <> 0),
  reference         VARCHAR(100),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID,
  CONSTRAINT sale_payments_sale_fk
    FOREIGN KEY (sale_id, organization_id) REFERENCES finance.sales (id, organization_id),
  CONSTRAINT sale_payments_method_fk
    FOREIGN KEY (payment_method_id, organization_id) REFERENCES finance.payment_methods (id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_sale_payments_sale   ON finance.sale_payments (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_method ON finance.sale_payments (payment_method_id);

-- Soft FK to fiscal_positions (same pattern as 003)
DO $$
BEGIN
  IF to_regclass('finance.fiscal_positions') IS NULL THEN
    RAISE NOTICE 'FK sales_fiscal_pos_fk omitida: finance.fiscal_positions aun no existe.';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'sales_fiscal_pos_fk' AND conrelid = 'finance.sales'::regclass) THEN
    ALTER TABLE finance.sales
      ADD CONSTRAINT sales_fiscal_pos_fk FOREIGN KEY (fiscal_position_id)
      REFERENCES finance.fiscal_positions (id) ON DELETE RESTRICT;
  END IF;
END
$$;

-- 4. TRIGGERS + RLS
DROP TRIGGER IF EXISTS trg_journal_entries_a_audit ON finance.journal_entries;
CREATE TRIGGER trg_journal_entries_a_audit BEFORE INSERT OR UPDATE ON finance.journal_entries
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_journal_entry_lines_audit ON finance.journal_entry_lines;
CREATE TRIGGER trg_journal_entry_lines_audit BEFORE INSERT OR UPDATE ON finance.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_sales_audit ON finance.sales;
CREATE TRIGGER trg_sales_audit BEFORE INSERT OR UPDATE ON finance.sales
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_sale_lines_audit ON finance.sale_lines;
CREATE TRIGGER trg_sale_lines_audit BEFORE INSERT OR UPDATE ON finance.sale_lines
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_sale_payments_audit ON finance.sale_payments;
CREATE TRIGGER trg_sale_payments_audit BEFORE INSERT OR UPDATE ON finance.sale_payments
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

SELECT finance.apply_org_rls('finance.journal_entries');
SELECT finance.apply_org_rls('finance.journal_entry_lines');
SELECT finance.apply_org_rls('finance.sales');
SELECT finance.apply_org_rls('finance.sale_lines');
SELECT finance.apply_org_rls('finance.sale_payments');

REVOKE DELETE ON finance.journal_entries      FROM authenticated;
REVOKE DELETE ON finance.journal_entry_lines  FROM authenticated;

-- 5. IMMUTABILITY
CREATE OR REPLACE FUNCTION finance.validate_entry_post()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_n      integer;
  v_debit  numeric(15,2);
  v_credit numeric(15,2);
BEGIN
  IF NEW.state::text = 'posted' AND OLD.state::text <> 'posted' THEN
    SELECT count(*), coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
      INTO v_n, v_debit, v_credit
      FROM finance.journal_entry_lines l
     WHERE l.entry_id = NEW.id;

    IF v_n < 2 THEN
      RAISE EXCEPTION 'Asiento %: se necesitan al menos 2 lineas para publicarlo (tiene %)', NEW.number, v_n
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_debit <> v_credit OR v_debit = 0 THEN
      RAISE EXCEPTION 'Asiento %: partida doble invalida (debe % / haber %)', NEW.number, v_debit, v_credit
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION finance.prevent_nondraft_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state::text <> 'draft' THEN
    RAISE EXCEPTION 'Asiento % esta en estado "%" y no se puede borrar; use reversion (nota de credito).',
      OLD.number, OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_journal_entries_b_immutable ON finance.journal_entries;
CREATE TRIGGER trg_journal_entries_b_immutable BEFORE UPDATE ON finance.journal_entries
  FOR EACH ROW EXECUTE FUNCTION finance.prevent_posted_modification();

DROP TRIGGER IF EXISTS trg_journal_entries_c_validate_post ON finance.journal_entries;
CREATE TRIGGER trg_journal_entries_c_validate_post BEFORE UPDATE ON finance.journal_entries
  FOR EACH ROW EXECUTE FUNCTION finance.validate_entry_post();

DROP TRIGGER IF EXISTS trg_journal_entries_no_delete ON finance.journal_entries;
CREATE TRIGGER trg_journal_entries_no_delete BEFORE DELETE ON finance.journal_entries
  FOR EACH ROW EXECUTE FUNCTION finance.prevent_nondraft_delete();

CREATE OR REPLACE FUNCTION finance.guard_posted_entry_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids   uuid[] := '{}';
  v_id    uuid;
  v_state text;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_ids := v_ids || NEW.entry_id; END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_ids := v_ids || OLD.entry_id; END IF;

  FOR v_id IN SELECT DISTINCT x FROM unnest(v_ids) AS x
  LOOP
    SELECT e.state::text INTO v_state FROM finance.journal_entries e WHERE e.id = v_id;
    IF v_state = 'posted' THEN
      RAISE EXCEPTION 'Las lineas del asiento % no se pueden modificar: el asiento esta publicado (posted).', v_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_jel_guard_posted ON finance.journal_entry_lines;
CREATE TRIGGER trg_jel_guard_posted BEFORE INSERT OR UPDATE OR DELETE ON finance.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION finance.guard_posted_entry_lines();

-- 6. DEFERRED double-entry validation
CREATE OR REPLACE FUNCTION finance.check_entry_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids    uuid[] := '{}';
  v_id     uuid;
  v_number varchar;
  v_debit  numeric;
  v_credit numeric;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_ids := v_ids || NEW.entry_id; END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_ids := v_ids || OLD.entry_id; END IF;

  FOR v_id IN SELECT DISTINCT x FROM unnest(v_ids) AS x
  LOOP
    SELECT e.number INTO v_number FROM finance.journal_entries e WHERE e.id = v_id;
    CONTINUE WHEN NOT FOUND;

    SELECT coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
      INTO v_debit, v_credit
      FROM finance.journal_entry_lines l
     WHERE l.entry_id = v_id;

    IF v_debit <> v_credit THEN
      RAISE EXCEPTION 'Asiento %: partida doble descuadrada (debe % <> haber %)', v_number, v_debit, v_credit
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_jel_double_entry ON finance.journal_entry_lines;
CREATE CONSTRAINT TRIGGER trg_jel_double_entry
  AFTER INSERT OR UPDATE OR DELETE ON finance.journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.check_entry_balanced();

-- 7. _post_entry
CREATE OR REPLACE FUNCTION finance._post_entry(
  p_entry_id      uuid,
  p_payment_state finance.payment_state_enum
)
RETURNS void
LANGUAGE plpgsql
SET search_path = finance, public, extensions, pg_temp
AS $$
DECLARE
  v_e     finance.journal_entries%ROWTYPE;
  v_seq   bigint;
  v_prev  varchar;
  v_data  jsonb;
BEGIN
  SELECT * INTO v_e FROM finance.journal_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '_post_entry: asiento % no existe o no es accesible', p_entry_id;
  END IF;
  IF v_e.state <> 'draft' THEN
    RAISE EXCEPTION '_post_entry: el asiento % no esta en borrador (estado %)', v_e.number, v_e.state;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('finance.hash_chain:' || v_e.journal_id::text, 0));

  SELECT je.hash_seq, je.hash_chain INTO v_seq, v_prev
    FROM finance.journal_entries je
   WHERE je.journal_id      = v_e.journal_id
     AND je.organization_id = v_e.organization_id
     AND je.hash_seq IS NOT NULL
   ORDER BY je.hash_seq DESC
   LIMIT 1;

  v_seq  := coalesce(v_seq, 0) + 1;
  v_prev := coalesce(v_prev, '');

  v_data := jsonb_build_object(
    'number',            v_e.number,
    'journal_id',        v_e.journal_id,
    'entry_type',        v_e.entry_type::text,
    'entry_date',        v_e.entry_date,
    'partner_id',        v_e.partner_id,
    'currency_code',     v_e.currency_code,
    'amount_untaxed',    v_e.amount_untaxed::text,
    'amount_tax',        v_e.amount_tax::text,
    'amount_total',      v_e.amount_total::text,
    'reversed_entry_id', v_e.reversed_entry_id,
    'pos_session_id',    v_e.pos_session_id,
    'lines', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'account_id',   l.account_id,
               'debit',        l.debit::text,
               'credit',       l.credit::text,
               'description',  l.description,
               'partner_id',   l.partner_id,
               'tax_id',       l.tax_id,
               'quantity',     l.quantity::text,
               'product_name', l.product_name
             ) ORDER BY l.account_id, l.debit, l.credit, l.description, l.product_name, l.tax_id), '[]'::jsonb)
        FROM finance.journal_entry_lines l
       WHERE l.entry_id = v_e.id)
  );

  UPDATE finance.journal_entries
     SET state         = 'posted',
         payment_state = p_payment_state,
         hash_seq      = v_seq,
         hash_data     = v_data,
         previous_hash = v_prev,
         hash_chain    = finance.compute_entry_hash(v_data, v_prev)
   WHERE id = v_e.id;
END
$$;

-- 8. create_sale_atomic
CREATE OR REPLACE FUNCTION finance.create_sale_atomic(p_params jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = finance, public, extensions, pg_temp
AS $$
DECLARE
  v_session_id  uuid;
  v_client_id   uuid;
  v_session     finance.pos_sessions%ROWTYPE;
  v_config      finance.pos_configs%ROWTYPE;
  v_journal     finance.journals%ROWTYPE;
  v_org_id      uuid;
  v_today       date := (now() AT TIME ZONE 'America/La_Paz')::date;
  v_year        integer := extract(year FROM (now() AT TIME ZONE 'America/La_Paz'))::integer;

  v_sale_id     uuid;
  v_entry_id    uuid;
  v_number      text;

  v_l           record;
  v_t           record;
  v_p           record;
  v_pm          finance.payment_methods%ROWTYPE;
  v_line_id     uuid;
  v_line_total  numeric(15,2);
  v_name        text;
  v_qty         numeric;
  v_price       numeric;
  v_disc        numeric;
  v_taxid       uuid;
  v_first       boolean;
  v_base        numeric;
  v_tax         numeric;
  v_sum_base    numeric := 0;
  v_sum_tax     numeric := 0;
  v_total       numeric := 0;
  v_rev_rows    jsonb := '[]'::jsonb;
  v_tax_rows    jsonb := '[]'::jsonb;

  v_pays        jsonb := '[]'::jsonb;
  v_amt         numeric;
  v_acc         uuid;
  v_jacc        uuid;
  v_paid_in     numeric := 0;
  v_cash_in     numeric := 0;
  v_change      numeric;
  v_left        numeric;
  v_cut         numeric;
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RAISE EXCEPTION 'create_sale_atomic: p_params debe ser un objeto JSON';
  END IF;
  v_session_id := nullif(p_params->>'session_id', '')::uuid;
  v_client_id  := nullif(p_params->>'client_id', '')::uuid;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'create_sale_atomic: session_id es obligatorio';
  END IF;
  IF jsonb_typeof(p_params->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_params->'lines') = 0 THEN
    RAISE EXCEPTION 'create_sale_atomic: lines debe ser un arreglo con al menos una linea';
  END IF;
  IF jsonb_typeof(p_params->'payments') IS DISTINCT FROM 'array' OR jsonb_array_length(p_params->'payments') = 0 THEN
    RAISE EXCEPTION 'create_sale_atomic: payments debe ser un arreglo con al menos un pago';
  END IF;

  -- a) Open session (FOR UPDATE serializes sales + closing)
  SELECT * INTO v_session FROM finance.pos_sessions WHERE id = v_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sesion POS % no existe o no es accesible', v_session_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_session.state <> 'opened' THEN
    RAISE EXCEPTION 'La sesion % no esta abierta (estado %)', v_session.name, v_session.state;
  END IF;
  v_org_id := v_session.organization_id;

  SELECT * INTO v_config FROM finance.pos_configs
   WHERE id = v_session.pos_config_id AND organization_id = v_org_id;

  IF v_config.journal_id IS NOT NULL THEN
    SELECT * INTO v_journal FROM finance.journals
     WHERE id = v_config.journal_id AND organization_id = v_org_id AND is_active;
  ELSE
    SELECT * INTO v_journal FROM finance.journals
     WHERE organization_id = v_org_id AND type = 'sale' AND is_active
     ORDER BY code LIMIT 1;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No hay diario de ventas activo para el punto de venta "%"', v_config.name;
  END IF;
  IF v_journal.type <> 'sale' THEN
    RAISE EXCEPTION 'El diario "%" del POS no es de tipo ventas', v_journal.name;
  END IF;
  IF v_journal.default_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'El diario "%" no tiene cuenta de ingresos (default_credit_account_id)', v_journal.name;
  END IF;

  -- b) Sale with REC number
  v_number := finance.next_sequence(v_org_id, 'receipt', v_year, v_config.id);

  INSERT INTO finance.sales (number, session_id, client_id, total_amount, tax_amount, state,
                             fiscal_position_id, organization_id)
  VALUES (v_number, v_session.id, v_client_id, 0, 0, 'draft',
          v_config.default_fiscal_position_id, v_org_id)
  RETURNING id INTO v_sale_id;

  -- c) + d) Lines and taxes
  FOR v_l IN
    SELECT t.e, t.ord FROM jsonb_array_elements(p_params->'lines') WITH ORDINALITY AS t(e, ord) ORDER BY t.ord
  LOOP
    v_name  := nullif(btrim(v_l.e->>'product_name'), '');
    v_qty   := coalesce((v_l.e->>'quantity')::numeric, 1);
    v_price := (v_l.e->>'unit_price')::numeric;
    v_disc  := coalesce((v_l.e->>'discount_pct')::numeric, 0);
    v_taxid := nullif(v_l.e->>'tax_config_id', '')::uuid;

    IF v_name IS NULL THEN
      RAISE EXCEPTION 'Linea %: product_name es obligatorio', v_l.ord;
    END IF;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Linea % (%): la cantidad debe ser mayor a 0', v_l.ord, v_name;
    END IF;
    IF v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION 'Linea % (%): unit_price es obligatorio y no puede ser negativo', v_l.ord, v_name;
    END IF;
    IF v_disc < 0 OR v_disc > 100 THEN
      RAISE EXCEPTION 'Linea % (%): discount_pct debe estar entre 0 y 100', v_l.ord, v_name;
    END IF;

    INSERT INTO finance.sale_lines (sale_id, product_id, product_name, quantity, unit_price,
                                    discount_pct, tax_config_id, organization_id)
    VALUES (v_sale_id, nullif(v_l.e->>'product_id', '')::uuid, v_name, v_qty, v_price,
            v_disc, v_taxid, v_org_id)
    RETURNING id, line_total INTO v_line_id, v_line_total;

    v_base  := v_line_total;
    v_tax   := 0;
    v_first := true;
    IF v_taxid IS NOT NULL THEN
      FOR v_t IN SELECT * FROM finance.compute_tax_multi(v_line_total, ARRAY[v_taxid], false) LOOP
        IF v_first THEN
          v_base  := v_t.base_amount;
          v_first := false;
        END IF;
        v_tax := v_tax + v_t.tax_amount;
        IF v_t.tax_amount <> 0 THEN
          IF v_t.account_id IS NULL THEN
            RAISE EXCEPTION 'Linea % (%): el impuesto "%" no tiene cuenta contable', v_l.ord, v_name, v_t.tax_name;
          END IF;
          v_tax_rows := v_tax_rows || jsonb_build_object(
            'tax_id', v_t.tax_id, 'account_id', v_t.account_id,
            'tax_name', v_t.tax_name, 'amount', v_t.tax_amount);
        END IF;
      END LOOP;
    END IF;

    UPDATE finance.sale_lines SET tax_amount = v_tax WHERE id = v_line_id;

    v_sum_base := v_sum_base + v_base;
    v_sum_tax  := v_sum_tax  + v_tax;

    v_rev_rows := v_rev_rows || jsonb_build_object(
      'credit', v_base, 'description', left(v_name, 500), 'product_name', left(v_name, 255),
      'quantity', v_qty, 'tax_id', v_taxid);
  END LOOP;

  v_total := v_sum_base + v_sum_tax;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'El total de la venta debe ser mayor a 0 (es %)', v_total;
  END IF;

  -- g) Payments: validate and compute change
  FOR v_p IN
    SELECT t.e, t.ord FROM jsonb_array_elements(p_params->'payments') WITH ORDINALITY AS t(e, ord) ORDER BY t.ord
  LOOP
    v_amt := (v_p.e->>'amount')::numeric;
    IF v_amt IS NULL OR v_amt <= 0 OR v_amt <> round(v_amt, 2) THEN
      RAISE EXCEPTION 'Pago %: amount debe ser mayor a 0 con maximo 2 decimales', v_p.ord;
    END IF;

    SELECT * INTO v_pm FROM finance.payment_methods
     WHERE id = nullif(v_p.e->>'payment_method_id', '')::uuid AND organization_id = v_org_id AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pago %: metodo de pago inexistente o inactivo', v_p.ord;
    END IF;
    IF v_pm.type = 'pay_later' THEN
      RAISE EXCEPTION 'Pago %: "%" es venta a credito (pay_later), no soportada en esta version', v_p.ord, v_pm.name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM finance.pos_config_payment_methods x
                    WHERE x.pos_config_id = v_config.id AND x.payment_method_id = v_pm.id) THEN
      RAISE EXCEPTION 'Pago %: el metodo "%" no esta habilitado en el punto de venta "%"',
        v_p.ord, v_pm.name, v_config.name;
    END IF;

    SELECT j.default_debit_account_id INTO v_jacc
      FROM finance.journals j
     WHERE j.id = v_pm.journal_id AND j.organization_id = v_org_id;
    v_acc := CASE WHEN v_pm.type = 'cash'
                  THEN coalesce(v_jacc, v_pm.outstanding_account_id, v_pm.receivable_account_id)
                  ELSE coalesce(v_pm.outstanding_account_id, v_jacc, v_pm.receivable_account_id)
             END;
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Pago %: el metodo "%" no tiene cuenta contable (diario/outstanding/receivable)', v_p.ord, v_pm.name;
    END IF;

    v_pays := v_pays || jsonb_build_object(
      'payment_method_id', v_pm.id, 'amount', v_amt, 'is_cash', v_pm.is_cash_count,
      'account_id', v_acc, 'name', v_pm.name, 'reference', left(v_p.e->>'reference', 100));
    v_paid_in := v_paid_in + v_amt;
    IF v_pm.is_cash_count THEN v_cash_in := v_cash_in + v_amt; END IF;
  END LOOP;

  v_change := v_paid_in - v_total;
  IF v_change < 0 THEN
    RAISE EXCEPTION 'Pago insuficiente: total % y recibido % (faltan %)', v_total, v_paid_in, -v_change;
  END IF;
  IF v_change > v_cash_in THEN
    RAISE EXCEPTION 'Sobrepago de % no se puede devolver: el vuelto solo puede salir de pagos en efectivo (efectivo recibido %)',
      v_change, v_cash_in;
  END IF;

  -- e) Journal entry out_receipt (draft, published at end)
  INSERT INTO finance.journal_entries (number, journal_id, entry_type, entry_date, state, payment_state,
                                       partner_id, currency_code, amount_untaxed, amount_tax, amount_total,
                                       pos_session_id, organization_id)
  VALUES (v_number, v_journal.id, 'out_receipt', v_today, 'draft', 'not_paid',
          v_client_id, 'BOB', v_sum_base, v_sum_tax, v_total, v_session.id, v_org_id)
  RETURNING id INTO v_entry_id;

  -- CREDIT revenue lines
  INSERT INTO finance.journal_entry_lines (entry_id, account_id, debit, credit, description, partner_id,
                                           tax_id, quantity, product_name, organization_id)
  SELECT v_entry_id, v_journal.default_credit_account_id, 0, r.credit, r.description, v_client_id,
         r.tax_id, r.quantity, r.product_name, v_org_id
    FROM jsonb_to_recordset(v_rev_rows)
         AS r(credit numeric, description text, product_name text, quantity numeric, tax_id uuid)
   WHERE r.credit > 0;

  -- Tax lines aggregated by (tax, account)
  INSERT INTO finance.journal_entry_lines (entry_id, account_id, debit, credit, description, partner_id,
                                           tax_id, quantity, organization_id)
  SELECT v_entry_id, x.account_id, greatest(-x.amount, 0), greatest(x.amount, 0),
         left(x.tax_name, 500), v_client_id, x.tax_id, 1, v_org_id
    FROM (SELECT g.tax_id, g.account_id, g.tax_name, sum(g.amount) AS amount
            FROM jsonb_to_recordset(v_tax_rows)
                 AS g(tax_id uuid, account_id uuid, tax_name text, amount numeric)
           GROUP BY g.tax_id, g.account_id, g.tax_name) x
   WHERE x.amount <> 0;

  -- f) Net payments + DEBIT cash/bank
  v_left := v_change;
  FOR v_p IN
    SELECT t.e, t.ord FROM jsonb_array_elements(v_pays) WITH ORDINALITY AS t(e, ord) ORDER BY t.ord DESC
  LOOP
    v_amt := (v_p.e->>'amount')::numeric;
    IF (v_p.e->>'is_cash')::boolean AND v_left > 0 THEN
      v_cut  := least(v_left, v_amt);
      v_amt  := v_amt - v_cut;
      v_left := v_left - v_cut;
    END IF;

    IF v_amt > 0 THEN
      INSERT INTO finance.sale_payments (sale_id, payment_method_id, amount, reference, organization_id)
      VALUES (v_sale_id, (v_p.e->>'payment_method_id')::uuid, v_amt, v_p.e->>'reference', v_org_id);

      INSERT INTO finance.journal_entry_lines (entry_id, account_id, debit, credit, description, partner_id,
                                               quantity, organization_id)
      VALUES (v_entry_id, (v_p.e->>'account_id')::uuid, v_amt, 0, left('Cobro ' || (v_p.e->>'name'), 500),
              v_client_id, 1, v_org_id);
    END IF;
  END LOOP;

  -- h) + i) Post entry (state + hash) and mark sale paid
  PERFORM finance._post_entry(v_entry_id, 'paid');

  UPDATE finance.sales
     SET total_amount     = v_total,
         tax_amount       = v_sum_tax,
         paid_amount      = v_total,
         change_amount    = v_change,
         journal_entry_id = v_entry_id,
         state            = 'paid'
   WHERE id = v_sale_id;

  -- j) Update session expected balance
  UPDATE finance.pos_sessions
     SET closing_balance_expected = finance.compute_session_expected_balance(v_session.id)
   WHERE id = v_session.id;

  RETURN v_sale_id;
END
$$;

COMMENT ON FUNCTION finance.create_sale_atomic(jsonb) IS
  'Registra una venta POS completa en una transaccion: venta + lineas + impuestos + asiento out_receipt (partida doble, hash) + pagos. Devuelve sales.id.';

-- 9. void_sale
CREATE OR REPLACE FUNCTION finance.void_sale(p_sale_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = finance, public, extensions, pg_temp
AS $$
DECLARE
  v_sale     finance.sales%ROWTYPE;
  v_session  finance.pos_sessions%ROWTYPE;
  v_orig     finance.journal_entries%ROWTYPE;
  v_number   text;
  v_new_id   uuid;
  v_today    date := (now() AT TIME ZONE 'America/La_Paz')::date;
  v_year     integer := extract(year FROM (now() AT TIME ZONE 'America/La_Paz'))::integer;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'void_sale: el motivo de anulacion es obligatorio';
  END IF;

  SELECT * INTO v_sale FROM finance.sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta % no existe o no es accesible', p_sale_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_sale.state = 'cancelled' THEN
    RAISE EXCEPTION 'La venta % ya esta anulada', v_sale.number;
  END IF;
  IF v_sale.state = 'invoiced' THEN
    RAISE EXCEPTION 'La venta % esta facturada: anule la factura con su nota de credito fiscal', v_sale.number;
  END IF;
  IF v_sale.state NOT IN ('paid', 'done') OR v_sale.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'La venta % esta en estado "%" y no se puede anular', v_sale.number, v_sale.state;
  END IF;

  SELECT * INTO v_session FROM finance.pos_sessions WHERE id = v_sale.session_id FOR UPDATE;
  IF v_session.state <> 'opened' THEN
    RAISE EXCEPTION 'La sesion % de la venta % ya no esta abierta (estado %): el arqueo esta congelado',
      v_session.name, v_sale.number, v_session.state;
  END IF;

  SELECT * INTO v_orig FROM finance.journal_entries WHERE id = v_sale.journal_entry_id;
  IF NOT FOUND OR v_orig.state <> 'posted' THEN
    RAISE EXCEPTION 'El asiento de la venta % no esta publicado', v_sale.number;
  END IF;
  IF EXISTS (SELECT 1 FROM finance.journal_entries WHERE reversed_entry_id = v_orig.id) THEN
    RAISE EXCEPTION 'El asiento % ya fue revertido', v_orig.number;
  END IF;

  v_number := finance.next_sequence(v_sale.organization_id, 'credit_note', v_year, v_session.pos_config_id);

  INSERT INTO finance.journal_entries (number, journal_id, entry_type, entry_date, state, payment_state,
                                       partner_id, currency_code, amount_untaxed, amount_tax, amount_total,
                                       reversed_entry_id, pos_session_id, organization_id)
  VALUES (v_number, v_orig.journal_id, 'out_refund', v_today, 'draft', 'not_paid',
          v_orig.partner_id, v_orig.currency_code,
          -v_orig.amount_untaxed, -v_orig.amount_tax, -v_orig.amount_total,
          v_orig.id, v_orig.pos_session_id, v_orig.organization_id)
  RETURNING id INTO v_new_id;

  INSERT INTO finance.journal_entry_lines (entry_id, account_id, debit, credit, description, partner_id,
                                           tax_id, quantity, product_name, organization_id)
  SELECT v_new_id, l.account_id, l.credit, l.debit,
         left('Anulacion ' || v_sale.number || coalesce(': ' || l.description, ''), 500),
         l.partner_id, l.tax_id, l.quantity, l.product_name, l.organization_id
    FROM finance.journal_entry_lines l
   WHERE l.entry_id = v_orig.id;

  PERFORM finance._post_entry(v_new_id, 'paid');

  INSERT INTO finance.sale_payments (sale_id, payment_method_id, amount, reference, organization_id)
  SELECT sp.sale_id, sp.payment_method_id, -sp.amount, left('ANULACION ' || v_sale.number, 100), sp.organization_id
    FROM finance.sale_payments sp
   WHERE sp.sale_id = v_sale.id AND sp.amount > 0;

  UPDATE finance.sales
     SET state = 'cancelled', void_reason = p_reason
   WHERE id = v_sale.id;

  UPDATE finance.pos_sessions
     SET closing_balance_expected = finance.compute_session_expected_balance(v_session.id)
   WHERE id = v_session.id;

  RETURN v_new_id;
END
$$;

COMMENT ON FUNCTION finance.void_sale(uuid, text) IS
  'Anula una venta: crea nota de credito (out_refund) con el asiento original invertido, la vincula por reversed_entry_id y marca la venta cancelled. Devuelve el id del asiento de reverso.';

-- 10. PERMISSIONS
REVOKE ALL ON FUNCTION finance._post_entry(uuid, finance.payment_state_enum) FROM public;
REVOKE ALL ON FUNCTION finance.create_sale_atomic(jsonb)                     FROM public;
REVOKE ALL ON FUNCTION finance.void_sale(uuid, text)                         FROM public;
GRANT EXECUTE ON FUNCTION finance._post_entry(uuid, finance.payment_state_enum) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.create_sale_atomic(jsonb)                     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.void_sale(uuid, text)                         TO authenticated, service_role;
