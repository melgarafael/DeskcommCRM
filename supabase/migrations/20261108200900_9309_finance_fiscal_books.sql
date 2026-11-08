-- =============================================================================
-- ARM Finance - Fiscal Books (Bolivia SIN)
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
      ('tax_configs','id'), ('tax_configs','organization_id'), ('tax_configs','name'), ('tax_configs','rate'),
      ('sales','id'), ('sales','organization_id'), ('sales','session_id'), ('sales','state'),
      ('sales','total_amount'), ('sales','tax_amount'),
      ('sale_lines','sale_id'), ('sale_lines','quantity'), ('sale_lines','unit_price'),
      ('journal_entries','id'), ('journal_entries','organization_id'),
      ('journal_entry_lines','id'), ('journal_entry_lines','entry_id'),
      ('journal_entry_lines','account_id'), ('journal_entry_lines','debit'),
      ('journal_entry_lines','credit'), ('journal_entry_lines','tax_id')
    ) AS t(tbl, col)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'finance' AND c.table_name = r.tbl AND c.column_name = r.col) THEN
      v_miss := v_miss || format(' finance.%s.%s', r.tbl, r.col);
    END IF;
  END LOOP;

  IF v_miss <> '' THEN
    RAISE EXCEPTION '9309: faltan dependencias:%', v_miss;
  END IF;
END
$$;

-- 1. tax_report_tags
CREATE TABLE IF NOT EXISTS finance.tax_report_tags (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(50)   NOT NULL,
  name        VARCHAR(255)  NOT NULL,
  description TEXT,
  report_type VARCHAR(10)   NOT NULL CHECK (report_type IN ('lcv', 'lci', 'both')),
  sign        SMALLINT      NOT NULL DEFAULT 1 CHECK (sign IN (-1, 1)),
  sequence    INTEGER       NOT NULL DEFAULT 10,
  organization_id UUID      NOT NULL REFERENCES public.organizations(id),
  CONSTRAINT trt_org_code_uniq UNIQUE (organization_id, code)
);

SELECT finance.apply_org_rls('finance.tax_report_tags');

-- 2. tax_config_tags (M2M)
CREATE TABLE IF NOT EXISTS finance.tax_config_tags (
  tax_config_id UUID NOT NULL REFERENCES finance.tax_configs (id) ON DELETE CASCADE,
  tag_id        UUID NOT NULL REFERENCES finance.tax_report_tags (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  PRIMARY KEY (tax_config_id, tag_id)
);

SELECT finance.apply_org_rls('finance.tax_config_tags');

-- 3. entry_line_tags
CREATE TABLE IF NOT EXISTS finance.entry_line_tags (
  entry_line_id UUID NOT NULL REFERENCES finance.journal_entry_lines (id) ON DELETE CASCADE,
  tag_id        UUID NOT NULL REFERENCES finance.tax_report_tags (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  PRIMARY KEY (entry_line_id, tag_id)
);

SELECT finance.apply_org_rls('finance.entry_line_tags');

-- 4. seed_fiscal_tags
CREATE OR REPLACE FUNCTION finance.seed_fiscal_tags(p_organization_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = finance, public, extensions, pg_temp
AS $$
BEGIN
  -- Tags LCV (Libro de Ventas IVA)
  INSERT INTO finance.tax_report_tags (code, name, description, report_type, sign, sequence, organization_id) VALUES
    ('LCV_TOTAL',       'Importe Total de la Venta',         'Columna 8 LCV - monto total facturado',                'lcv', 1, 10, p_organization_id),
    ('LCV_ICE',         'Importe ICE/IEHD/IPJ/Tasas',        'Columna 9 LCV - impuestos especificos (no aplica)',    'lcv', 1, 20, p_organization_id),
    ('LCV_EXENTO',      'Importe Exento',                    'Columna 10 LCV - ventas tasa cero o exentas',          'lcv', 1, 30, p_organization_id),
    ('LCV_DESCUENTO',   'Descuentos/Bonificaciones/Rebajas', 'Columna 11 LCV - descuentos otorgados',               'lcv',-1, 40, p_organization_id),
    ('LCV_BASE_CF',     'Importe Base para Debito Fiscal',   'Columna 12 LCV = Total - ICE - Exento + Desc',        'lcv', 1, 50, p_organization_id),
    ('LCV_DEBITO',      'Debito Fiscal IVA 13%',             'Columna 13 LCV - IVA 13% sobre la base',              'lcv', 1, 60, p_organization_id)
  ON CONFLICT (organization_id, code) DO NOTHING;

  -- Tags LCI (Libro de Compras IVA)
  INSERT INTO finance.tax_report_tags (code, name, description, report_type, sign, sequence, organization_id) VALUES
    ('LCI_TOTAL',       'Importe Total de la Compra',        'Columna 8 LCI - monto total de la factura de compra',  'lci', 1, 10, p_organization_id),
    ('LCI_NO_CF',       'Importe No Sujeto a Credito Fiscal','Columna 9 LCI - montos que no generan CF',             'lci', 1, 20, p_organization_id),
    ('LCI_SUBTOTAL',    'Subtotal',                          'Columna 10 LCI = Total - No sujeto a CF',              'lci', 1, 30, p_organization_id),
    ('LCI_DESCUENTO',   'Descuentos/Bonificaciones/Rebajas', 'Columna 11 LCI - descuentos obtenidos',                'lci',-1, 40, p_organization_id),
    ('LCI_BASE_CF',     'Importe Base para Credito Fiscal',  'Columna 12 LCI = Subtotal - Descuentos',               'lci', 1, 50, p_organization_id),
    ('LCI_CREDITO',     'Credito Fiscal IVA 13%',            'Columna 13 LCI - IVA 13% recuperable',                 'lci', 1, 60, p_organization_id)
  ON CONFLICT (organization_id, code) DO NOTHING;

  -- Tags compartidos
  INSERT INTO finance.tax_report_tags (code, name, description, report_type, sign, sequence, organization_id) VALUES
    ('IT_3_PASIVO',     'IT 3% por Pagar',                   'Impuesto a las Transacciones - pasivo',                'both', 1, 70, p_organization_id),
    ('IT_3_GASTO',      'IT 3% Gasto',                       'Impuesto a las Transacciones - gasto deducible',       'both',-1, 80, p_organization_id)
  ON CONFLICT (organization_id, code) DO NOTHING;

  -- Vincular IVA 13% venta con tags LCV
  INSERT INTO finance.tax_config_tags (tax_config_id, tag_id, organization_id)
  SELECT tc.id, trt.id, p_organization_id
    FROM finance.tax_configs tc, finance.tax_report_tags trt
   WHERE tc.organization_id = p_organization_id AND tc.name = 'IVA 13%' AND tc.use_type = 'sale'
     AND trt.organization_id = p_organization_id AND trt.code = 'LCV_DEBITO'
  ON CONFLICT DO NOTHING;

  -- Vincular IVA 13% compra con tags LCI
  INSERT INTO finance.tax_config_tags (tax_config_id, tag_id, organization_id)
  SELECT tc.id, trt.id, p_organization_id
    FROM finance.tax_configs tc, finance.tax_report_tags trt
   WHERE tc.organization_id = p_organization_id AND tc.name = 'IVA 13%' AND tc.use_type = 'purchase'
     AND trt.organization_id = p_organization_id AND trt.code = 'LCI_CREDITO'
  ON CONFLICT DO NOTHING;

  -- Vincular IT 3% con tags
  INSERT INTO finance.tax_config_tags (tax_config_id, tag_id, organization_id)
  SELECT tc.id, trt.id, p_organization_id
    FROM finance.tax_configs tc, finance.tax_report_tags trt
   WHERE tc.organization_id = p_organization_id AND tc.name = 'IT 3% (tasa)'
     AND trt.organization_id = p_organization_id AND trt.code = 'IT_3_PASIVO'
  ON CONFLICT DO NOTHING;

  INSERT INTO finance.tax_config_tags (tax_config_id, tag_id, organization_id)
  SELECT tc.id, trt.id, p_organization_id
    FROM finance.tax_configs tc, finance.tax_report_tags trt
   WHERE tc.organization_id = p_organization_id AND tc.name = 'IT 3% (gasto)'
     AND trt.organization_id = p_organization_id AND trt.code = 'IT_3_GASTO'
  ON CONFLICT DO NOTHING;
END
$$;

-- 5. v_libro_ventas_iva
CREATE OR REPLACE VIEW finance.v_libro_ventas_iva
WITH (security_invoker = true) AS
SELECT
  row_number() OVER (PARTITION BY s.organization_id, date_trunc('month', s.created_at AT TIME ZONE 'America/La_Paz')
                     ORDER BY s.created_at) AS nro,
  s.organization_id,
  date_trunc('month', s.created_at AT TIME ZONE 'America/La_Paz')::date AS periodo,
  (s.created_at AT TIME ZONE 'America/La_Paz')::date AS fecha_factura,
  s.client_id,
  s.id AS sale_id,
  je.number AS nro_factura,
  NULL::varchar AS nro_autorizacion,
  NULL::varchar AS codigo_control,
  s.total_amount AS importe_total,
  0::decimal(15,2) AS importe_ice,
  0::decimal(15,2) AS importe_exento,
  COALESCE((SELECT sum(sl.quantity * sl.unit_price * sl.discount_pct / 100)
            FROM finance.sale_lines sl WHERE sl.sale_id = s.id), 0)::decimal(15,2) AS descuentos,
  (s.total_amount - s.tax_amount)::decimal(15,2) AS base_debito_fiscal,
  s.tax_amount AS debito_fiscal_iva
FROM finance.sales s
LEFT JOIN finance.journal_entries je ON je.id = s.journal_entry_id
WHERE finance._sale_is_valid(s.state::text);

-- 6. v_libro_compras_iva
CREATE OR REPLACE VIEW finance.v_libro_compras_iva
WITH (security_invoker = true) AS
SELECT
  row_number() OVER (PARTITION BY je.organization_id, date_trunc('month', je.entry_date)
                     ORDER BY je.entry_date, je.number) AS nro,
  je.organization_id,
  date_trunc('month', je.entry_date)::date AS periodo,
  je.entry_date AS fecha_factura,
  je.partner_id,
  je.number AS nro_factura,
  NULL::varchar AS nro_autorizacion,
  NULL::varchar AS nro_dui_dim,
  COALESCE(sum(jel.debit), 0)::decimal(15,2) AS importe_total,
  0::decimal(15,2) AS importe_no_sujeto_cf,
  COALESCE(sum(jel.debit), 0)::decimal(15,2) AS subtotal,
  0::decimal(15,2) AS descuentos,
  COALESCE(sum(CASE WHEN jel.tax_id IS NULL THEN jel.debit ELSE 0 END), 0)::decimal(15,2) AS base_credito_fiscal,
  COALESCE(sum(CASE WHEN tc.name ILIKE '%IVA%' THEN jel.debit ELSE 0 END), 0)::decimal(15,2) AS credito_fiscal_iva
FROM finance.journal_entries je
JOIN finance.journal_entry_lines jel ON jel.entry_id = je.id
LEFT JOIN finance.tax_configs tc ON tc.id = jel.tax_id
WHERE je.entry_type = 'in_invoice'
  AND je.state = 'posted'
GROUP BY je.id, je.organization_id, je.entry_date, je.number, je.partner_id;

-- 7. v_declaracion_iva_mensual
CREATE OR REPLACE VIEW finance.v_declaracion_iva_mensual
WITH (security_invoker = true) AS
SELECT
  COALESCE(v.organization_id, c.organization_id) AS organization_id,
  COALESCE(v.periodo, c.periodo) AS periodo,
  COALESCE(v.total_debito, 0) AS debito_fiscal,
  COALESCE(c.total_credito, 0) AS credito_fiscal,
  COALESCE(v.total_debito, 0) - COALESCE(c.total_credito, 0) AS iva_a_pagar,
  COALESCE(v.total_base, 0) AS base_ventas,
  COALESCE(c.total_base, 0) AS base_compras,
  COALESCE(v.num_facturas, 0) AS facturas_ventas,
  COALESCE(c.num_facturas, 0) AS facturas_compras
FROM (
  SELECT organization_id, periodo,
         sum(debito_fiscal_iva) AS total_debito,
         sum(base_debito_fiscal) AS total_base,
         count(*) AS num_facturas
    FROM finance.v_libro_ventas_iva
   GROUP BY organization_id, periodo
) v
FULL OUTER JOIN (
  SELECT organization_id, periodo,
         sum(credito_fiscal_iva) AS total_credito,
         sum(base_credito_fiscal) AS total_base,
         count(*) AS num_facturas
    FROM finance.v_libro_compras_iva
   GROUP BY organization_id, periodo
) c ON c.organization_id = v.organization_id AND c.periodo = v.periodo;

-- 8. v_declaracion_it_mensual
CREATE OR REPLACE VIEW finance.v_declaracion_it_mensual
WITH (security_invoker = true) AS
SELECT
  organization_id,
  periodo,
  sum(base_debito_fiscal) AS base_imponible,
  (sum(base_debito_fiscal) * 0.03)::decimal(15,2) AS it_determinado,
  0::decimal(15,2) AS credito_iue_compensable,
  (sum(base_debito_fiscal) * 0.03)::decimal(15,2) AS it_a_pagar
FROM finance.v_libro_ventas_iva
GROUP BY organization_id, periodo;

-- 9. PERMISOS
REVOKE ALL ON FUNCTION finance.seed_fiscal_tags(uuid) FROM public;
GRANT EXECUTE ON FUNCTION finance.seed_fiscal_tags(uuid) TO authenticated, service_role;

GRANT SELECT ON
  finance.v_libro_ventas_iva,
  finance.v_libro_compras_iva,
  finance.v_declaracion_iva_mensual,
  finance.v_declaracion_it_mensual
TO authenticated, service_role;
