-- =============================================================================
-- ARM Finance - POS Sessions (configs, payment methods, sessions)
-- Adapted: organization_id + fn_user_org_ids()
-- =============================================================================

-- 1. pos_configs
CREATE TABLE IF NOT EXISTS finance.pos_configs (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                       VARCHAR(100) NOT NULL,
  code                       VARCHAR(10)  NOT NULL,
  cash_control               BOOLEAN NOT NULL DEFAULT true,
  default_fiscal_position_id UUID,
  journal_id                 UUID,
  is_active                  BOOLEAN NOT NULL DEFAULT true,
  organization_id            UUID NOT NULL REFERENCES public.organizations(id),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                 UUID,
  CONSTRAINT pos_configs_org_code_uniq UNIQUE (organization_id, code),
  CONSTRAINT pos_configs_id_org_uniq   UNIQUE (id, organization_id)
);

-- 2. payment_methods
CREATE TABLE IF NOT EXISTS finance.payment_methods (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   VARCHAR(100) NOT NULL,
  type                   finance.payment_method_type_enum NOT NULL,
  is_cash_count          BOOLEAN GENERATED ALWAYS AS (type = 'cash') STORED,
  journal_id             UUID,
  receivable_account_id  UUID,
  outstanding_account_id UUID,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  sequence               INTEGER NOT NULL DEFAULT 10,
  organization_id        UUID NOT NULL REFERENCES public.organizations(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             UUID,
  CONSTRAINT payment_methods_org_name_uniq UNIQUE (organization_id, name),
  CONSTRAINT payment_methods_id_org_uniq   UNIQUE (id, organization_id)
);

-- 3. pos_config_payment_methods (M2M)
CREATE TABLE IF NOT EXISTS finance.pos_config_payment_methods (
  pos_config_id     UUID NOT NULL,
  payment_method_id UUID NOT NULL,
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID,
  PRIMARY KEY (pos_config_id, payment_method_id),
  CONSTRAINT pcpm_config_fk FOREIGN KEY (pos_config_id, organization_id)
    REFERENCES finance.pos_configs (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT pcpm_method_fk FOREIGN KEY (payment_method_id, organization_id)
    REFERENCES finance.payment_methods (id, organization_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pcpm_payment_method ON finance.pos_config_payment_methods (payment_method_id);

-- 4. pos_sessions
CREATE TABLE IF NOT EXISTS finance.pos_sessions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     VARCHAR(50) NOT NULL,
  pos_config_id            UUID NOT NULL,
  user_id                  UUID NOT NULL,
  state                    finance.session_state_enum NOT NULL DEFAULT 'opening_control',
  opened_at                TIMESTAMPTZ,
  closed_at                TIMESTAMPTZ,
  opening_balance          DECIMAL(15,2) NOT NULL DEFAULT 0,
  closing_balance_expected DECIMAL(15,2),
  closing_balance_real     DECIMAL(15,2),
  closing_difference       DECIMAL(15,2)
    GENERATED ALWAYS AS (closing_balance_expected - closing_balance_real) STORED,
  opening_notes            TEXT,
  closing_notes            TEXT,
  sequence_number          INTEGER NOT NULL DEFAULT 1,
  organization_id          UUID NOT NULL REFERENCES public.organizations(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by               UUID,
  CONSTRAINT pos_sessions_org_name_uniq UNIQUE (organization_id, name),
  CONSTRAINT pos_sessions_config_fk FOREIGN KEY (pos_config_id, organization_id)
    REFERENCES finance.pos_configs (id, organization_id),
  CONSTRAINT pos_sessions_opening_nonneg CHECK (opening_balance >= 0),
  CONSTRAINT pos_sessions_closed_has_date CHECK (state <> 'closed' OR closed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_pos_sessions_config ON finance.pos_sessions (pos_config_id);
CREATE INDEX IF NOT EXISTS idx_pos_sessions_org ON finance.pos_sessions (organization_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_session
  ON finance.pos_sessions (pos_config_id)
  WHERE state IN ('opening_control', 'opened');

-- 5. Soft FKs (only if target table exists)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('finance.pos_configs',     'pos_configs_journal_fk',        'journal_id',                 'finance.journals'),
      ('finance.pos_configs',     'pos_configs_fiscal_pos_fk',     'default_fiscal_position_id', 'finance.fiscal_positions'),
      ('finance.payment_methods', 'payment_methods_journal_fk',    'journal_id',                 'finance.journals'),
      ('finance.payment_methods', 'payment_methods_receivable_fk', 'receivable_account_id',      'finance.chart_of_accounts'),
      ('finance.payment_methods', 'payment_methods_outstanding_fk','outstanding_account_id',     'finance.chart_of_accounts')
    ) AS t(tbl, fk_name, col, target)
  LOOP
    IF to_regclass(r.target) IS NULL THEN
      RAISE NOTICE 'FK % omitida: % aun no existe.', r.fk_name, r.target;
    ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.fk_name AND conrelid = r.tbl::regclass) THEN
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s (id) ON DELETE RESTRICT',
        r.tbl, r.fk_name, r.col, r.target);
    END IF;
  END LOOP;
END
$$;

-- 6. Audit triggers
DROP TRIGGER IF EXISTS trg_pos_configs_audit ON finance.pos_configs;
CREATE TRIGGER trg_pos_configs_audit BEFORE INSERT OR UPDATE ON finance.pos_configs
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_payment_methods_audit ON finance.payment_methods;
CREATE TRIGGER trg_payment_methods_audit BEFORE INSERT OR UPDATE ON finance.payment_methods
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_pos_config_payment_methods_audit ON finance.pos_config_payment_methods;
CREATE TRIGGER trg_pos_config_payment_methods_audit BEFORE INSERT OR UPDATE ON finance.pos_config_payment_methods
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_pos_sessions_audit ON finance.pos_sessions;
CREATE TRIGGER trg_pos_sessions_audit BEFORE INSERT OR UPDATE ON finance.pos_sessions
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

-- 7. RLS
SELECT finance.apply_org_rls('finance.pos_configs');
SELECT finance.apply_org_rls('finance.payment_methods');
SELECT finance.apply_org_rls('finance.pos_config_payment_methods');
SELECT finance.apply_org_rls('finance.pos_sessions');

-- 8. Functions

CREATE OR REPLACE FUNCTION finance.compute_session_expected_balance(p_session_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = finance, public, pg_temp
AS $$
DECLARE
  v_opening numeric(15,2);
  v_cash    numeric(15,2) := 0;
  v_moves   numeric(15,2) := 0;
BEGIN
  SELECT opening_balance INTO v_opening FROM finance.pos_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sesion POS % no encontrada', p_session_id USING ERRCODE = 'no_data_found';
  END IF;

  IF to_regclass('finance.sales') IS NOT NULL AND to_regclass('finance.sale_payments') IS NOT NULL THEN
    EXECUTE
      'SELECT coalesce(sum(sp.amount), 0)
         FROM finance.sale_payments sp
         JOIN finance.sales s            ON s.id  = sp.sale_id
         JOIN finance.payment_methods pm ON pm.id = sp.payment_method_id
        WHERE s.session_id = $1 AND pm.is_cash_count'
      INTO v_cash USING p_session_id;
  END IF;

  IF to_regclass('finance.cash_movements') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(sum(amount), 0) FROM finance.cash_movements WHERE session_id = $1'
      INTO v_moves USING p_session_id;
  END IF;

  RETURN v_opening + v_cash + v_moves;
END
$$;

CREATE OR REPLACE FUNCTION finance.open_session(
  p_config_id       uuid,
  p_user_id         uuid,
  p_opening_balance numeric DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = finance, public, pg_temp
AS $$
DECLARE
  v_config finance.pos_configs%ROWTYPE;
  v_seq    integer;
  v_id     uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id es obligatorio para abrir una sesion';
  END IF;
  IF p_opening_balance IS NULL OR p_opening_balance < 0 THEN
    RAISE EXCEPTION 'El saldo de apertura no puede ser nulo ni negativo (recibido: %)', p_opening_balance;
  END IF;

  SELECT * INTO v_config FROM finance.pos_configs WHERE id = p_config_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Punto de venta % no existe o no es accesible', p_config_id;
  END IF;
  IF NOT v_config.is_active THEN
    RAISE EXCEPTION 'El punto de venta "%" esta inactivo', v_config.name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM finance.pos_sessions
     WHERE pos_config_id = p_config_id AND state IN ('opening_control', 'opened')
  ) THEN
    RAISE EXCEPTION 'Ya existe una sesion abierta para el punto de venta "%"', v_config.name
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT coalesce(max(sequence_number), 0) + 1 INTO v_seq
    FROM finance.pos_sessions WHERE pos_config_id = p_config_id;

  INSERT INTO finance.pos_sessions (
    name, pos_config_id, user_id, state, opened_at, opening_balance, sequence_number, organization_id
  ) VALUES (
    'POS/' || v_config.code || '/' || lpad(v_seq::text, 4, '0'),
    p_config_id, p_user_id, 'opened', now(), p_opening_balance, v_seq, v_config.organization_id
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION finance.close_session(
  p_session_id   uuid,
  p_real_balance numeric,
  p_notes        text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = finance, public, pg_temp
AS $$
DECLARE
  v_session  finance.pos_sessions%ROWTYPE;
  v_cash_ctl boolean;
  v_drafts   integer := 0;
  v_expected numeric(15,2);
  v_real     numeric(15,2);
BEGIN
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

  IF to_regclass('finance.sales') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM finance.sales WHERE session_id = $1 AND state = ''draft'''
      INTO v_drafts USING p_session_id;
    IF v_drafts > 0 THEN
      RAISE EXCEPTION 'No se puede cerrar la sesion %: hay % venta(s) en borrador.',
        v_session.name, v_drafts;
    END IF;
  END IF;

  SELECT cash_control INTO v_cash_ctl FROM finance.pos_configs WHERE id = v_session.pos_config_id;

  v_expected := finance.compute_session_expected_balance(p_session_id);

  IF v_cash_ctl THEN
    IF p_real_balance IS NULL OR p_real_balance < 0 THEN
      RAISE EXCEPTION 'Esta caja tiene control de efectivo: el saldo real es obligatorio y no puede ser negativo';
    END IF;
    v_real := p_real_balance;
  ELSE
    v_real := v_expected;
  END IF;

  UPDATE finance.pos_sessions
     SET state                    = 'closed',
         closed_at                = now(),
         closing_balance_expected = v_expected,
         closing_balance_real     = v_real,
         closing_notes            = p_notes
   WHERE id = p_session_id;
END
$$;

REVOKE ALL ON FUNCTION finance.compute_session_expected_balance(uuid)    FROM public;
REVOKE ALL ON FUNCTION finance.open_session(uuid, uuid, numeric)         FROM public;
REVOKE ALL ON FUNCTION finance.close_session(uuid, numeric, text)        FROM public;
GRANT EXECUTE ON FUNCTION finance.compute_session_expected_balance(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.open_session(uuid, uuid, numeric)      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.close_session(uuid, numeric, text)     TO authenticated, service_role;
