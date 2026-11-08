-- =============================================================================
-- ARM Finance - Chart of Accounts + Journals + Bolivia seed
-- Adapted: organization_id + fn_user_org_ids()
-- =============================================================================

-- 1. chart_of_accounts
CREATE TABLE IF NOT EXISTS finance.chart_of_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(20)  NOT NULL,
  name          VARCHAR(255) NOT NULL,
  account_type  finance.account_type_enum NOT NULL,
  parent_id     UUID,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  reconcile     BOOLEAN NOT NULL DEFAULT false,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID,
  CONSTRAINT chart_of_accounts_code_org_key UNIQUE (code, organization_id),
  CONSTRAINT chart_of_accounts_id_org_key   UNIQUE (id, organization_id),
  CONSTRAINT chart_of_accounts_parent_fk
    FOREIGN KEY (parent_id, organization_id) REFERENCES finance.chart_of_accounts (id, organization_id),
  CONSTRAINT chart_of_accounts_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT chart_of_accounts_reconcile_chk
    CHECK (account_type NOT IN ('asset_receivable', 'liability_payable') OR reconcile)
);

CREATE INDEX IF NOT EXISTS chart_of_accounts_parent_idx ON finance.chart_of_accounts (parent_id);
CREATE INDEX IF NOT EXISTS chart_of_accounts_org_type_idx ON finance.chart_of_accounts (organization_id, account_type);

DROP TRIGGER IF EXISTS trg_chart_of_accounts_audit ON finance.chart_of_accounts;
CREATE TRIGGER trg_chart_of_accounts_audit
  BEFORE INSERT OR UPDATE ON finance.chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

SELECT finance.apply_org_rls('finance.chart_of_accounts');

-- 2. journals
CREATE TABLE IF NOT EXISTS finance.journals (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        VARCHAR(255) NOT NULL,
  type                        finance.journal_type_enum NOT NULL,
  code                        VARCHAR(5) NOT NULL,
  default_debit_account_id    UUID,
  default_credit_account_id   UUID,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  organization_id             UUID NOT NULL REFERENCES public.organizations(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                  UUID,
  CONSTRAINT journals_code_org_key UNIQUE (code, organization_id),
  CONSTRAINT journals_debit_account_fk
    FOREIGN KEY (default_debit_account_id, organization_id) REFERENCES finance.chart_of_accounts (id, organization_id),
  CONSTRAINT journals_credit_account_fk
    FOREIGN KEY (default_credit_account_id, organization_id) REFERENCES finance.chart_of_accounts (id, organization_id)
);

CREATE INDEX IF NOT EXISTS journals_org_type_idx ON finance.journals (organization_id, type);

DROP TRIGGER IF EXISTS trg_journals_audit ON finance.journals;
CREATE TRIGGER trg_journals_audit
  BEFORE INSERT OR UPDATE ON finance.journals
  FOR EACH ROW EXECUTE FUNCTION finance.set_audit_fields();

SELECT finance.apply_org_rls('finance.journals');

-- 3. seed_bolivia_chart(p_organization_id)
CREATE OR REPLACE FUNCTION finance.seed_bolivia_chart(p_organization_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'p_organization_id es obligatorio';
  END IF;

  INSERT INTO finance.chart_of_accounts (code, name, account_type, reconcile, organization_id)
  SELECT v.code, v.name, v.account_type::finance.account_type_enum, v.reconcile, p_organization_id
    FROM (VALUES
    ('1111', 'Bancos', 'asset_cash', false),
    ('1112', 'Fondo fijo', 'asset_cash', false),
    ('1114', 'Inversiones Temporales', 'asset_cash', false),
    ('1121', 'Cuentas por Cobrar Comerciales', 'asset_receivable', true),
    ('11211', 'Cuentas por Cobrar Comerciales - PoS', 'asset_receivable', true),
    ('1122', 'Otras Cuentas por Cobrar', 'asset_receivable', true),
    ('1123', 'Cuentas por Cobrar a Empresas Relacionadas', 'asset_receivable', true),
    ('1124', 'Anticipo a Proveedores', 'asset_prepayments', false),
    ('1125', 'Provisión para Cuentas Incobrables', 'asset_receivable', true),
    ('1131', 'Inventarios de Productos Terminados', 'asset_current', false),
    ('1132', 'Inventarios de Productos en Proceso', 'asset_current', false),
    ('1133', 'Inventarios de Materia Prima', 'asset_current', false),
    ('11341', 'Inventario en Tránsito Entrante', 'asset_current', false),
    ('11342', 'Inventario en Tránsito Saliente', 'asset_current', false),
    ('1135', 'Inventario - Provisión para Obsolescencias', 'asset_current', false),
    ('1141', 'Crédito Fiscal IVA', 'asset_current', false),
    ('1142', 'Impuestos por Recuperar', 'asset_receivable', true),
    ('1143', 'Pagos Anticipados', 'asset_current', false),
    ('1144', 'Otros Activos Corrientes', 'asset_current', false),
    ('1211', 'Cuentas por Cobrar Comerciales - Largo Plazo', 'asset_receivable', true),
    ('1212', 'Otras Cuentas por Cobrar - Largo Plazo', 'asset_receivable', true),
    ('1213', 'Cuentas por Cobrar Empresas Relacionadas y/o Vinculadas Largo Plazo', 'asset_receivable', true),
    ('1221', 'Inventarios de Repuestos', 'asset_non_current', true),
    ('1222', 'Otros Inventarios', 'asset_non_current', true),
    ('1231', 'Terrenos', 'asset_fixed', false),
    ('1232', 'Edificios', 'asset_fixed', false),
    ('12321', 'Depreciación Acumulada Edificios', 'asset_fixed', false),
    ('1233', 'Maquinaria', 'asset_fixed', false),
    ('12331', 'Depreciación Acumulada Maquinaria', 'asset_fixed', false),
    ('1234', 'Vehículos', 'asset_fixed', false),
    ('12341', 'Depreciación Acumulada Vehículos', 'asset_fixed', false),
    ('1235', 'Muebles y Enseres', 'asset_fixed', false),
    ('12351', 'Depreciación Acumulada Muebles y Enseres', 'asset_fixed', false),
    ('1236', 'Equipos de Computación', 'asset_fixed', false),
    ('12361', 'Depreciación Acumulada Equipos de Computación', 'asset_fixed', false),
    ('124', 'Propiedades de Inversión', 'asset_non_current', false),
    ('1251', 'Patentes y Marcas', 'asset_non_current', false),
    ('12511', 'Amortización Acumulada Patentes y Marcas', 'asset_non_current', false),
    ('1252', 'Derechos de Llave', 'asset_non_current', false),
    ('12521', 'Amortización Acumulada Derechos de Llave', 'asset_non_current', false),
    ('126', 'Inversiones Permanentes', 'asset_non_current', false),
    ('127', 'Otros Activos No Corrientes', 'asset_non_current', false),
    ('2111', 'Préstamos Bancarios', 'liability_current', false),
    ('2112', 'Otros Pasivos Financieros', 'liability_current', false),
    ('2113', 'Intereses por Pagar', 'liability_current', false),
    ('2121', 'Cuentas por Pagar Comerciales', 'liability_payable', true),
    ('2122', 'Documentos por Pagar Corto Plazo', 'liability_payable', true),
    ('2123', 'Cuentas por Pagar a Empresas Relacionadas', 'liability_payable', true),
    ('2131', 'Aportes y Retenciones a Corto Plazo', 'liability_current', false),
    ('2132', 'Sueldos por Pagar', 'liability_current', false),
    ('2133', 'Beneficios Sociales por Pagar', 'liability_current', false),
    ('2134', 'Cargos Sociales', 'liability_current', false),
    ('2135', 'Débito Fiscal IVA', 'liability_current', false),
    ('2136', 'Impuesto a las Transacciones por Pagar', 'liability_current', true),
    ('2137', 'Retenciones IT por Pagar', 'liability_current', false),
    ('2138', 'Retenciones IUE por Pagar', 'liability_current', false),
    ('2139', 'Otros Impuestos por Pagar', 'liability_current', false),
    ('21399', 'Impuestos por Pagar', 'liability_payable', true),
    ('214', 'Provisiones', 'liability_current', false),
    ('215', 'Ingresos Diferidos', 'liability_current', false),
    ('216', 'Otros Pasivos Corrientes', 'liability_current', false),
    ('2211', 'Préstamos Bancarios a Largo Plazo', 'liability_current', false),
    ('2212', 'Otros Pasivos Financieros a Largo Plazo', 'liability_current', false),
    ('2221', 'Documentos por Pagar a Largo Plazo', 'liability_payable', true),
    ('2222', 'Cuentas por Pagar a Empresas Relacionadas a Largo Plazo', 'liability_non_current', false),
    ('223', 'Provisión para Beneficios Sociales (Indemnizaciones al Personal)', 'liability_non_current', false),
    ('224', 'Otros Pasivos No Corrientes', 'liability_non_current', false),
    ('3101', 'Capital Social Pagado', 'equity', false),
    ('3102', 'Aportes por Capitalizar', 'equity', false),
    ('3103', 'Ajuste de Capital', 'equity', false),
    ('3201', 'Reserva Legal', 'equity', false),
    ('3202', 'Otras Reservas', 'equity', false),
    ('3203', 'Ajuste de Reservas Patrimoniales', 'equity', false),
    ('331', 'Resultados Acumulados', 'equity', false),
    ('332', 'Resultados de la Gestión', 'equity_unaffected', false),
    ('4101', 'Ventas', 'income', false),
    ('4102', 'Devoluciones, Rebajas y Descuentos de Bienes y/o Servicios', 'income', false),
    ('4201', 'Intereses Sobre Depósitos Bancarios', 'income', false),
    ('4202', 'Intereses de Inversiones Temporales', 'income', false),
    ('4203', 'Otros Ingresos Financieros', 'income', false),
    ('4301', 'Ajuste por Inflación y Tenencia de Bienes', 'income', false),
    ('4302', 'Ingresos por Venta de Valores', 'income', false),
    ('4303', 'Ganancia Cambiaria', 'income', false),
    ('4304', 'Otros Ingresos', 'income_other', false),
    ('5101', 'Costos de Productos', 'expense', false),
    ('5102', 'Fletes y Transportes de Productos', 'expense', false),
    ('5103', 'Devolución en Compras', 'expense', false),
    ('5104', 'Descuentos Sobre Compras', 'expense', false),
    ('5105', 'Costo de Productos Dañados', 'expense', false),
    ('5201', 'Gastos de Comercialización - Sueldos y Salarios', 'expense', false),
    ('5202', 'Gastos de Comercialización - Beneficios Sociales', 'expense', false),
    ('5203', 'Gastos de Comercialización - Comisiones Sobre Ventas', 'expense', false),
    ('5204', 'Gastos de Comercialización - Viáticos', 'expense', false),
    ('5205', 'Gastos de Comercialización - Pasajes', 'expense', false),
    ('5206', 'Gastos de Comercialización - Publicidad', 'expense', false),
    ('5207', 'Gastos de Comercialización - Depreciación de Bienes de Uso', 'expense', false),
    ('5208', 'Gastos de Comercialización - Pérdida en Cuentas Incobrables', 'expense', false),
    ('5209', 'Otros Gastos de Comercialización', 'expense', false),
    ('52091', 'Impuesto a las Transacciones', 'expense', false),
    ('52092', 'Retenciones IT', 'expense', false),
    ('52093', 'Retenciones IUE', 'expense', false),
    ('53001', 'Gastos de Administración - Sueldos y Salarios', 'expense', false),
    ('53002', 'Gastos de Administración - Beneficios Sociales', 'expense', false),
    ('53003', 'Gastos de Administración - Provisión Aguinaldos', 'expense', false),
    ('53004', 'Gastos de Administración - Provisión Indemnizaciones', 'expense', false),
    ('53005', 'Gastos de Administración - Viáticos', 'expense', false),
    ('53006', 'Gastos de Administración - Pasajes', 'expense', false),
    ('53007', 'Gastos de Administración - Servicios Básicos', 'expense', false),
    ('53008', 'Gastos de Administración - Materiales y Suministros', 'expense', false),
    ('53009', 'Gastos de Administración - Fletes y Transporte', 'expense', false),
    ('53010', 'Gastos de Administración - Mantenimiento y Reparación', 'expense', false),
    ('53011', 'Gastos de Administración - Depreciación de Bienes de Uso', 'expense', false),
    ('53012', 'Gastos de Administración - Alquileres', 'expense', false),
    ('53013', 'Gastos de Administración - Seguros', 'expense', false),
    ('53014', 'Gastos de Administración - Servicio de Seguridad', 'expense', false),
    ('53015', 'Gastos de Administración - Gastos Generales', 'expense', false),
    ('53016', 'Otros Gastos de Administración', 'expense', false),
    ('5401', 'Intereses Sobre Préstamos Bancarios', 'expense', false),
    ('5402', 'Intereses Sobre Otras Obligaciones Financieras', 'expense', false),
    ('5403', 'Otros Intereses', 'expense', false),
    ('5404', 'Comisiones Bancarias', 'expense', false),
    ('5405', 'Otros Gastos Financieros', 'expense', false),
    ('550', 'Otros Gastos de Operación', 'expense', false),
    ('5601', 'Ajuste por Inflación y Tenencia de Bienes', 'expense_depreciation', false),
    ('5602', 'Pérdida Cambiaria', 'expense', false),
    ('5603', 'Otros Gastos', 'expense', false),
    ('570', 'Impuesto Sobre las Utilidades de las Empresas', 'expense', false)
    ) AS v(code, name, account_type, reconcile)
  ON CONFLICT (code, organization_id) DO NOTHING;

  UPDATE finance.chart_of_accounts c
     SET parent_id = (
           SELECT x.id
             FROM finance.chart_of_accounts x
            WHERE x.organization_id = c.organization_id
              AND x.code <> c.code
              AND c.code LIKE x.code || '%'
            ORDER BY length(x.code) DESC
            LIMIT 1)
   WHERE c.organization_id = p_organization_id
     AND c.parent_id IS NULL;

  INSERT INTO finance.journals (name, type, code, default_debit_account_id, default_credit_account_id, organization_id)
  SELECT j.name, j.type::finance.journal_type_enum, j.code, d.id, cr.id, p_organization_id
    FROM (VALUES
      ('Ventas',  'sale',     'VEN', '1121', '4101'),
      ('Compras', 'purchase', 'COM', '5101', '2121'),
      ('Caja',    'cash',     'CAJ', '1112', '1112'),
      ('Banco',   'bank',     'BCO', '1111', '1111'),
      ('General', 'general',  'GEN', NULL,   NULL)
    ) AS j(name, type, code, debit_code, credit_code)
    LEFT JOIN finance.chart_of_accounts d
           ON d.organization_id = p_organization_id AND d.code = j.debit_code
    LEFT JOIN finance.chart_of_accounts cr
           ON cr.organization_id = p_organization_id AND cr.code = j.credit_code
  ON CONFLICT (code, organization_id) DO NOTHING;
END
$fn$;

REVOKE ALL ON FUNCTION finance.seed_bolivia_chart(UUID) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION finance.seed_bolivia_chart(UUID) TO service_role;
