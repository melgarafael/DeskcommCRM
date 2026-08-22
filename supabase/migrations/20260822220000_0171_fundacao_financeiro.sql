-- 0171 — FUNDAÇÃO DO MÓDULO FINANCEIRO (Genesisia Contabilidade)
--
-- Parte do pivot ADR-0002, sobre a fundação Contábil da migration 0170.
-- Contas a pagar/receber por empresa-cliente. journal_entry_id é nullable e
-- ON DELETE SET NULL (não CASCADE): apagar o lançamento contábil de uma
-- baixa não pode apagar o registro financeiro que a originou — seria o
-- anti-pattern "cascade fantasma" do CLAUDE.md.
--
-- Fluxo de caixa (Fase 6 do plano) é FUNÇÃO, não tabela: doutrina DIRC
-- "Calcular" — total pago/recebido num período é agregação simples sobre
-- linhas já existentes, manter isso como tabela derivada duplicaria dado que
-- fica dessincronizado no primeiro UPDATE de status esquecido.

CREATE TABLE IF NOT EXISTS "public"."accounting_payables" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "client_company_id" uuid NOT NULL,
    "description" text NOT NULL,
    "amount_cents" bigint NOT NULL,
    "due_date" date NOT NULL,
    "paid_at" timestamp with time zone,
    "status" text DEFAULT 'open'::text NOT NULL,
    "journal_entry_id" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "accounting_payables_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_payables_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "accounting_payables_client_company_id_fkey" FOREIGN KEY ("client_company_id") REFERENCES "public"."accounting_client_companies"("id") ON DELETE CASCADE,
    CONSTRAINT "accounting_payables_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."accounting_journal_entries"("id") ON DELETE SET NULL,
    CONSTRAINT "accounting_payables_amount_cents_check" CHECK (("amount_cents" > 0))
);

ALTER TABLE "public"."accounting_payables" OWNER TO "postgres";
COMMENT ON TABLE "public"."accounting_payables" IS 'Contas a pagar por empresa-cliente. status vocabulário aberto (sem CHECK). journal_entry_id ON DELETE SET NULL: perder o lançamento não apaga o registro financeiro.';

CREATE INDEX IF NOT EXISTS "idx_accounting_payables_company_due" ON "public"."accounting_payables" USING btree ("client_company_id", "due_date");

CREATE TABLE IF NOT EXISTS "public"."accounting_receivables" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "client_company_id" uuid NOT NULL,
    "description" text NOT NULL,
    "amount_cents" bigint NOT NULL,
    "due_date" date NOT NULL,
    "paid_at" timestamp with time zone,
    "status" text DEFAULT 'open'::text NOT NULL,
    "journal_entry_id" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "accounting_receivables_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_receivables_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "accounting_receivables_client_company_id_fkey" FOREIGN KEY ("client_company_id") REFERENCES "public"."accounting_client_companies"("id") ON DELETE CASCADE,
    CONSTRAINT "accounting_receivables_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."accounting_journal_entries"("id") ON DELETE SET NULL,
    CONSTRAINT "accounting_receivables_amount_cents_check" CHECK (("amount_cents" > 0))
);

ALTER TABLE "public"."accounting_receivables" OWNER TO "postgres";
COMMENT ON TABLE "public"."accounting_receivables" IS 'Contas a receber por empresa-cliente. Mesmo raciocínio de accounting_payables.';

CREATE INDEX IF NOT EXISTS "idx_accounting_receivables_company_due" ON "public"."accounting_receivables" USING btree ("client_company_id", "due_date");

ALTER TABLE "public"."accounting_payables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."accounting_receivables" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "accounting_payables_select" ON "public"."accounting_payables" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
CREATE POLICY "accounting_payables_write" ON "public"."accounting_payables" FOR ALL USING (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"())) WITH CHECK (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"()));

CREATE POLICY "accounting_receivables_select" ON "public"."accounting_receivables" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
CREATE POLICY "accounting_receivables_write" ON "public"."accounting_receivables" FOR ALL USING (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"())) WITH CHECK (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"()));

-- Fluxo de caixa: soma de baixas dentro do período, por empresa-cliente.
-- security invoker (default) — roda com o papel de quem chama, então a RLS
-- das duas tabelas de origem se aplica normalmente; nenhuma elevação de
-- privilégio aqui, ao contrário das security definer de auditoria/fila.
CREATE OR REPLACE FUNCTION "public"."fn_cash_flow_summary"("p_client_company_id" uuid, "p_period_start" date, "p_period_end" date)
RETURNS TABLE("total_received_cents" bigint, "total_paid_cents" bigint, "net_cents" bigint)
LANGUAGE "sql" STABLE
AS $$
  select
    coalesce((select sum(amount_cents) from public.accounting_receivables
      where client_company_id = p_client_company_id
        and status = 'paid'
        and paid_at::date between p_period_start and p_period_end), 0) as total_received_cents,
    coalesce((select sum(amount_cents) from public.accounting_payables
      where client_company_id = p_client_company_id
        and status = 'paid'
        and paid_at::date between p_period_start and p_period_end), 0) as total_paid_cents,
    coalesce((select sum(amount_cents) from public.accounting_receivables
      where client_company_id = p_client_company_id
        and status = 'paid'
        and paid_at::date between p_period_start and p_period_end), 0)
    - coalesce((select sum(amount_cents) from public.accounting_payables
      where client_company_id = p_client_company_id
        and status = 'paid'
        and paid_at::date between p_period_start and p_period_end), 0) as net_cents;
$$;

REVOKE EXECUTE ON FUNCTION "public"."fn_cash_flow_summary"(uuid, date, date) FROM "public", "anon";
GRANT EXECUTE ON FUNCTION "public"."fn_cash_flow_summary"(uuid, date, date) TO "authenticated";

NOTIFY pgrst, 'reload schema';
