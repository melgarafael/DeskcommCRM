-- =============================================================================
-- ARM Finance - Tax Engine
-- Adapted: organization_id + fn_user_org_ids()
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS finance;

DO $$
BEGIN
  IF to_regprocedure('finance.apply_org_rls(regclass)') IS NULL
     OR to_regprocedure('finance.set_audit_fields()') IS NULL THEN
    RAISE EXCEPTION 'Falta 9300_finance_foundation.sql: correrlo antes que 9302_finance_tax_engine.sql';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'finance' AND t.typname = 'tax_calc_type_enum') THEN
    CREATE TYPE finance.tax_calc_type_enum AS ENUM ('division', 'percentage', 'group');
  END IF;
END
$$;

-- 1. tax_groups
CREATE TABLE IF NOT EXISTS finance.tax_groups (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  sequence    INTEGER     NOT NULL DEFAULT 10,
  organization_id UUID   NOT NULL REFERENCES public.organizations(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_groups_org_name
  ON finance.tax_groups (organization_id, name);

-- 2. tax_configs
CREATE TABLE IF NOT EXISTS finance.tax_configs (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 VARCHAR(100)  NOT NULL,
  rate                 DECIMAL(10,4) NOT NULL CHECK (rate > -100),
  calc_type            finance.tax_calc_type_enum NOT NULL,
  price_included       BOOLEAN       NOT NULL DEFAULT false,
  tax_group_id         UUID          REFERENCES finance.tax_groups(id),
  account_id           UUID,
  refund_account_id    UUID,
  parent_tax_id        UUID          REFERENCES finance.tax_configs(id) ON DELETE SET NULL,
  include_base_amount  BOOLEAN       NOT NULL DEFAULT false,
  is_active            BOOLEAN       NOT NULL DEFAULT true,
  sequence             INTEGER       NOT NULL DEFAULT 100,
  use_type             VARCHAR(10)   NOT NULL DEFAULT 'sale'
                         CHECK (use_type IN ('sale', 'purchase', 'none')),
  organization_id      UUID          NOT NULL REFERENCES public.organizations(id),
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by           UUID,
  CONSTRAINT ck_tax_configs_not_own_parent CHECK (parent_tax_id IS DISTINCT FROM id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_configs_org_name_use
  ON finance.tax_configs (organization_id, name, use_type);
CREATE INDEX IF NOT EXISTS ix_tax_configs_org_use_active
  ON finance.tax_configs (organization_id, use_type, is_active);
CREATE INDEX IF NOT EXISTS ix_tax_configs_parent
  ON finance.tax_configs (parent_tax_id) WHERE parent_tax_id IS NOT NULL;

-- 3. FK to chart_of_accounts (only if it exists)
DO $$
BEGIN
  IF to_regclass('finance.chart_of_accounts') IS NULL THEN
    RAISE NOTICE '9302: finance.chart_of_accounts no existe aun; FK de account_id/refund_account_id omitidas.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tax_configs_account') THEN
    ALTER TABLE finance.tax_configs
      ADD CONSTRAINT fk_tax_configs_account
      FOREIGN KEY (account_id) REFERENCES finance.chart_of_accounts(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tax_configs_refund_account') THEN
    ALTER TABLE finance.tax_configs
      ADD CONSTRAINT fk_tax_configs_refund_account
      FOREIGN KEY (refund_account_id) REFERENCES finance.chart_of_accounts(id);
  END IF;
END
$$;

-- 4. Triggers
CREATE OR REPLACE FUNCTION finance.validate_tax_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent finance.tax_configs;
  v_cur    uuid;
  v_hops   integer := 0;
  v_gorg   uuid;
BEGIN
  IF NEW.parent_tax_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM finance.tax_configs t WHERE t.id = NEW.parent_tax_id;
    IF FOUND THEN
      IF v_parent.calc_type <> 'group' THEN
        RAISE EXCEPTION 'tax_configs: el padre "%" debe tener calc_type = group', v_parent.name;
      END IF;
      IF v_parent.organization_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'tax_configs: el padre pertenece a otra organizacion';
      END IF;
      v_cur := v_parent.parent_tax_id;
      WHILE v_cur IS NOT NULL AND v_hops < 10 LOOP
        IF v_cur = NEW.id THEN
          RAISE EXCEPTION 'tax_configs: ciclo en la jerarquia de grupos';
        END IF;
        SELECT t.parent_tax_id INTO v_cur FROM finance.tax_configs t WHERE t.id = v_cur;
        v_hops := v_hops + 1;
      END LOOP;
    END IF;
  END IF;

  IF NEW.tax_group_id IS NOT NULL THEN
    SELECT g.organization_id INTO v_gorg FROM finance.tax_groups g WHERE g.id = NEW.tax_group_id;
    IF v_gorg IS NOT NULL AND v_gorg IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'tax_configs: tax_group_id pertenece a otra organizacion';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_tax_groups_audit ON finance.tax_groups;
CREATE TRIGGER trg_tax_groups_audit
  BEFORE INSERT OR UPDATE ON finance.tax_groups
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_tax_configs_a_audit ON finance.tax_configs;
CREATE TRIGGER trg_tax_configs_a_audit
  BEFORE INSERT OR UPDATE ON finance.tax_configs
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

DROP TRIGGER IF EXISTS trg_tax_configs_b_validate ON finance.tax_configs;
CREATE TRIGGER trg_tax_configs_b_validate
  BEFORE INSERT OR UPDATE ON finance.tax_configs
  FOR EACH ROW EXECUTE FUNCTION finance.validate_tax_config();

-- 5. RLS
SELECT finance.apply_org_rls('finance.tax_groups');
SELECT finance.apply_org_rls('finance.tax_configs');

-- 6. Calculation engine (unchanged business logic)

CREATE OR REPLACE FUNCTION finance._tax_leaf_rate(p_tax_id uuid, p_depth integer DEFAULT 0)
RETURNS numeric
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_type finance.tax_calc_type_enum;
  v_rate numeric;
BEGIN
  IF p_depth > 5 THEN
    RAISE EXCEPTION 'compute_tax: grupos anidados a mas de 5 niveles (ciclo?)';
  END IF;

  SELECT t.calc_type, t.rate INTO v_type, v_rate
    FROM finance.tax_configs t WHERE t.id = p_tax_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'compute_tax: impuesto % no existe o no es visible para esta organizacion', p_tax_id;
  END IF;

  IF v_type = 'group' THEN
    SELECT coalesce(sum(finance._tax_leaf_rate(c.id, p_depth + 1)), 0) INTO v_rate
      FROM finance.tax_configs c
     WHERE c.parent_tax_id = p_tax_id AND c.is_active;
  END IF;

  RETURN v_rate;
END
$$;

CREATE OR REPLACE FUNCTION finance._tax_rows(
  p_base      numeric,
  p_tax_id    uuid,
  p_is_refund boolean DEFAULT false,
  p_depth     integer DEFAULT 0
)
RETURNS TABLE (
  tax_id      uuid,
  base_amount numeric,
  tax_amount  numeric,
  account_id  uuid,
  tax_name    varchar
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tax     finance.tax_configs;
  v_child   record;
  r         record;
  v_running numeric := p_base;
  v_sub     numeric;
  v_n       integer := 0;
BEGIN
  IF p_depth > 5 THEN
    RAISE EXCEPTION 'compute_tax: grupos anidados a mas de 5 niveles (ciclo?)';
  END IF;

  SELECT * INTO v_tax FROM finance.tax_configs t WHERE t.id = p_tax_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'compute_tax: impuesto % no existe o no es visible para esta organizacion', p_tax_id;
  END IF;
  IF NOT v_tax.is_active THEN
    RAISE EXCEPTION 'compute_tax: el impuesto "%" esta inactivo', v_tax.name;
  END IF;

  IF v_tax.calc_type = 'group' THEN
    FOR v_child IN
      SELECT c.id, c.include_base_amount
        FROM finance.tax_configs c
       WHERE c.parent_tax_id = p_tax_id AND c.is_active
       ORDER BY c.sequence, c.name, c.id
    LOOP
      v_n := v_n + 1;
      v_sub := 0;
      FOR r IN SELECT * FROM finance._tax_rows(v_running, v_child.id, p_is_refund, p_depth + 1) LOOP
        v_sub       := v_sub + r.tax_amount;
        tax_id      := r.tax_id;
        base_amount := r.base_amount;
        tax_amount  := r.tax_amount;
        account_id  := r.account_id;
        tax_name    := r.tax_name;
        RETURN NEXT;
      END LOOP;
      IF v_child.include_base_amount THEN
        v_running := v_running + v_sub;
      END IF;
    END LOOP;

    IF v_n = 0 THEN
      RAISE EXCEPTION 'compute_tax: el grupo "%" no tiene hijos activos', v_tax.name;
    END IF;
  ELSE
    tax_id      := v_tax.id;
    base_amount := p_base;
    tax_amount  := round(p_base * v_tax.rate / 100, 2);
    account_id  := CASE WHEN p_is_refund
                        THEN coalesce(v_tax.refund_account_id, v_tax.account_id)
                        ELSE v_tax.account_id END;
    tax_name    := v_tax.name;
    RETURN NEXT;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION finance.compute_tax_multi(
  p_price      numeric,
  p_tax_ids    uuid[],
  p_is_refund  boolean DEFAULT false
)
RETURNS TABLE (
  base_amount  numeric,
  tax_amount   numeric,
  total_amount numeric,
  account_id   uuid,
  tax_name     varchar,
  tax_id       uuid
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tax        record;
  r            record;
  v_incl_rate  numeric := 0;
  v_base0      numeric;
  v_running    numeric;
  v_sub        numeric;
  v_is_incl    boolean;
  v_incl_sum   numeric := 0;
  v_last_incl  integer;
  a_tax_id     uuid[]    := '{}';
  a_base       numeric[] := '{}';
  a_tax        numeric[] := '{}';
  a_acc        uuid[]    := '{}';
  a_name       text[]    := '{}';
BEGIN
  IF p_price IS NULL THEN
    RAISE EXCEPTION 'compute_tax: p_price no puede ser NULL';
  END IF;
  IF p_tax_ids IS NULL OR cardinality(p_tax_ids) = 0 THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1
               FROM unnest(p_tax_ids) AS u(tid)
               LEFT JOIN finance.tax_configs t ON t.id = u.tid
              WHERE t.id IS NULL) THEN
    RAISE EXCEPTION 'compute_tax: algun impuesto de % no existe o no es visible para esta organizacion', p_tax_ids;
  END IF;

  SELECT coalesce(sum(finance._tax_leaf_rate(t.id)), 0) INTO v_incl_rate
    FROM unnest(p_tax_ids) AS u(tid)
    JOIN finance.tax_configs t ON t.id = u.tid
   WHERE t.price_included OR t.calc_type = 'division';

  IF v_incl_rate <= -100 THEN
    RAISE EXCEPTION 'compute_tax: la suma de tasas incluidas (%) es invalida', v_incl_rate;
  END IF;

  v_base0   := round(p_price / (1 + v_incl_rate / 100), 2);
  v_running := v_base0;

  FOR v_tax IN
    SELECT t.id, t.calc_type, t.price_included, t.include_base_amount
      FROM unnest(p_tax_ids) WITH ORDINALITY AS u(tid, ord)
      JOIN finance.tax_configs t ON t.id = u.tid
     ORDER BY t.sequence, u.ord
  LOOP
    v_is_incl := v_tax.price_included OR v_tax.calc_type = 'division';
    v_sub := 0;

    FOR r IN SELECT * FROM finance._tax_rows(v_running, v_tax.id, p_is_refund) LOOP
      a_tax_id := array_append(a_tax_id, r.tax_id);
      a_base   := array_append(a_base,   r.base_amount);
      a_tax    := array_append(a_tax,    r.tax_amount);
      a_acc    := array_append(a_acc,    r.account_id);
      a_name   := array_append(a_name,   r.tax_name::text);
      v_sub    := v_sub + r.tax_amount;
      IF v_is_incl THEN
        v_last_incl := cardinality(a_tax);
        v_incl_sum  := v_incl_sum + r.tax_amount;
      END IF;
    END LOOP;

    IF v_tax.include_base_amount THEN
      v_running := v_running + v_sub;
    END IF;
  END LOOP;

  IF v_incl_rate <> 0 AND v_last_incl IS NOT NULL THEN
    a_tax[v_last_incl] := a_tax[v_last_incl] + (p_price - v_base0 - v_incl_sum);
  END IF;

  RETURN QUERY
    SELECT a_base[i], a_tax[i], a_base[i] + a_tax[i], a_acc[i], a_name[i]::varchar, a_tax_id[i]
      FROM generate_subscripts(a_tax, 1) AS i
     ORDER BY i;
END
$$;

CREATE OR REPLACE FUNCTION finance.compute_tax(
  p_price      numeric,
  p_tax_id     uuid,
  p_is_refund  boolean DEFAULT false
)
RETURNS TABLE (
  base_amount  numeric,
  tax_amount   numeric,
  total_amount numeric,
  account_id   uuid,
  tax_name     varchar
)
LANGUAGE sql
STABLE
AS $$
  SELECT m.base_amount, m.tax_amount, m.total_amount, m.account_id, m.tax_name
    FROM finance.compute_tax_multi(p_price, ARRAY[p_tax_id], p_is_refund) m;
$$;

REVOKE ALL ON FUNCTION finance._tax_leaf_rate(uuid, integer) FROM public;
REVOKE ALL ON FUNCTION finance._tax_rows(numeric, uuid, boolean, integer) FROM public;
REVOKE ALL ON FUNCTION finance.compute_tax_multi(numeric, uuid[], boolean) FROM public;
REVOKE ALL ON FUNCTION finance.compute_tax(numeric, uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION finance._tax_leaf_rate(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance._tax_rows(numeric, uuid, boolean, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.compute_tax_multi(numeric, uuid[], boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION finance.compute_tax(numeric, uuid, boolean) TO authenticated, service_role;

-- 7. Seed helpers + seed_bolivia_taxes

CREATE OR REPLACE FUNCTION finance._seed_account(p_organization_id uuid, p_code text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_code IS NULL OR to_regclass('finance.chart_of_accounts') IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE 'SELECT id FROM finance.chart_of_accounts WHERE organization_id = $1 AND code = $2 LIMIT 1'
     INTO v_id USING p_organization_id, p_code;
  IF v_id IS NULL THEN
    RAISE NOTICE 'seed_bolivia_taxes: cuenta % no encontrada para organizacion %; account_id queda NULL', p_code, p_organization_id;
  END IF;
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION finance._seed_tax_group(p_organization_id uuid, p_name text, p_sequence integer)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO finance.tax_groups (organization_id, name, sequence)
  VALUES (p_organization_id, p_name, p_sequence)
  ON CONFLICT (organization_id, name) DO NOTHING;

  SELECT g.id INTO v_id FROM finance.tax_groups g
   WHERE g.organization_id = p_organization_id AND g.name = p_name;
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION finance._seed_tax(
  p_organization_id uuid,
  p_name           text,
  p_rate           numeric,
  p_calc_type      finance.tax_calc_type_enum,
  p_price_included boolean,
  p_include_base   boolean,
  p_group_id       uuid,
  p_account_code   text,
  p_use_type       text,
  p_sequence       integer
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id  uuid;
  v_acc uuid := finance._seed_account(p_organization_id, p_account_code);
BEGIN
  INSERT INTO finance.tax_configs
    (organization_id, name, rate, calc_type, price_included, include_base_amount,
     tax_group_id, account_id, refund_account_id, use_type, sequence)
  VALUES
    (p_organization_id, p_name, p_rate, p_calc_type, p_price_included, p_include_base,
     p_group_id, v_acc, v_acc, p_use_type, p_sequence)
  ON CONFLICT (organization_id, name, use_type) DO NOTHING;

  SELECT t.id INTO v_id FROM finance.tax_configs t
   WHERE t.organization_id = p_organization_id AND t.name = p_name AND t.use_type = p_use_type;

  IF v_acc IS NOT NULL THEN
    UPDATE finance.tax_configs t
       SET account_id        = coalesce(t.account_id, v_acc),
           refund_account_id = coalesce(t.refund_account_id, v_acc)
     WHERE t.id = v_id AND (t.account_id IS NULL OR t.refund_account_id IS NULL);
  END IF;

  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION finance._seed_link_children(p_group_id uuid, p_child_ids uuid[])
RETURNS void
LANGUAGE sql
AS $$
  UPDATE finance.tax_configs t
     SET parent_tax_id = p_group_id
   WHERE t.id = ANY (p_child_ids) AND t.parent_tax_id IS DISTINCT FROM p_group_id;
$$;

CREATE OR REPLACE FUNCTION finance.seed_bolivia_taxes(p_organization_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  g_iva13   uuid;
  g_iva0    uuid;
  g_it3     uuid;
  g_whh_s   uuid;
  g_whh_g   uuid;
  v_group   uuid;
  v_a       uuid;
  v_b       uuid;
  v_c       uuid;
  v_d       uuid;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'seed_bolivia_taxes: p_organization_id es obligatorio';
  END IF;

  g_iva13 := finance._seed_tax_group(p_organization_id, 'IVA 13%', 10);
  g_iva0  := finance._seed_tax_group(p_organization_id, 'IVA 0%', 20);
  g_it3   := finance._seed_tax_group(p_organization_id, 'IT 3%', 30);
  g_whh_s := finance._seed_tax_group(p_organization_id, 'Retenciones servicios', 40);
  g_whh_g := finance._seed_tax_group(p_organization_id, 'Retenciones bienes', 50);

  PERFORM finance._seed_tax(p_organization_id, 'IVA 13%', 13, 'division', true, true,
                            g_iva13, '2135', 'sale', 100);
  PERFORM finance._seed_tax(p_organization_id, 'IVA 13%', 13, 'division', true, true,
                            g_iva13, '1141', 'purchase', 300);

  PERFORM finance._seed_tax(p_organization_id, 'IVA 0%', 0, 'percentage', false, false,
                            g_iva0, NULL, 'sale', 110);
  PERFORM finance._seed_tax(p_organization_id, 'IVA 0%', 0, 'percentage', false, false,
                            g_iva0, NULL, 'purchase', 330);

  v_a := finance._seed_tax(p_organization_id, 'IT 3% (tasa)',  3, 'percentage', false, false,
                           g_it3, '2136',  'none', 140);
  v_b := finance._seed_tax(p_organization_id, 'IT 3% (gasto)', -3, 'percentage', false, false,
                           g_it3, '52091', 'none', 150);
  v_group := finance._seed_tax(p_organization_id, 'IT 3%', 3, 'group', false, false,
                               g_it3, NULL, 'sale', 160);
  PERFORM finance._seed_link_children(v_group, ARRAY[v_a, v_b]);

  v_a := finance._seed_tax(p_organization_id, 'Ret. IT servicios 3.5503% (pasivo)',   3.5503, 'percentage', false, false,
                           g_whh_s, '2137',  'none', 370);
  v_b := finance._seed_tax(p_organization_id, 'Ret. IT servicios 3.5503% (gasto)',   -3.5503, 'percentage', false, false,
                           g_whh_s, '52092', 'none', 380);
  v_c := finance._seed_tax(p_organization_id, 'Ret. IUE servicios 14.7929% (pasivo)', 14.7929, 'percentage', false, false,
                           g_whh_s, '2138',  'none', 390);
  v_d := finance._seed_tax(p_organization_id, 'Ret. IUE servicios 14.7929% (gasto)', -14.7929, 'percentage', false, false,
                           g_whh_s, '52093', 'none', 400);
  v_group := finance._seed_tax(p_organization_id, 'Ret. servicios IT+IUE 15.5%', 15.5, 'group', false, false,
                               g_whh_s, NULL, 'purchase', 410);
  PERFORM finance._seed_link_children(v_group, ARRAY[v_a, v_b, v_c, v_d]);

  v_a := finance._seed_tax(p_organization_id, 'Ret. IT bienes 3.2609% (pasivo)',   3.2609, 'percentage', false, false,
                           g_whh_g, '2137',  'none', 420);
  v_b := finance._seed_tax(p_organization_id, 'Ret. IT bienes 3.2609% (gasto)',   -3.2609, 'percentage', false, false,
                           g_whh_g, '52092', 'none', 430);
  v_c := finance._seed_tax(p_organization_id, 'Ret. IUE bienes 5.4348% (pasivo)',  5.4348, 'percentage', false, false,
                           g_whh_g, '2138',  'none', 440);
  v_d := finance._seed_tax(p_organization_id, 'Ret. IUE bienes 5.4348% (gasto)',  -5.4348, 'percentage', false, false,
                           g_whh_g, '52093', 'none', 450);
  v_group := finance._seed_tax(p_organization_id, 'Ret. bienes IT+IUE 8%', 8, 'group', false, false,
                               g_whh_g, NULL, 'purchase', 460);
  PERFORM finance._seed_link_children(v_group, ARRAY[v_a, v_b, v_c, v_d]);
END
$$;

REVOKE ALL ON FUNCTION finance._seed_account(uuid, text) FROM public;
REVOKE ALL ON FUNCTION finance._seed_tax_group(uuid, text, integer) FROM public;
REVOKE ALL ON FUNCTION finance._seed_tax(uuid, text, numeric, finance.tax_calc_type_enum, boolean, boolean, uuid, text, text, integer) FROM public;
REVOKE ALL ON FUNCTION finance._seed_link_children(uuid, uuid[]) FROM public;
REVOKE ALL ON FUNCTION finance.seed_bolivia_taxes(uuid) FROM public;
GRANT EXECUTE ON FUNCTION finance._seed_account(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION finance._seed_tax_group(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION finance._seed_tax(uuid, text, numeric, finance.tax_calc_type_enum, boolean, boolean, uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION finance._seed_link_children(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION finance.seed_bolivia_taxes(uuid) TO service_role;
