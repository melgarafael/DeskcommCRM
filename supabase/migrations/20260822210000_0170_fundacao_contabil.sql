-- 0170 — FUNDAÇÃO DO MÓDULO CONTÁBIL (Genesisia Contabilidade)
--
-- Parte do pivot ADR-0002: além do CRM de vendas, o escritório contábil que
-- assina a Genesisia gerencia as EMPRESAS QUE ELE ATENDE — conceito novo, e
-- deliberadamente NÃO uma extensão de `contacts` (pessoa física, com CPF e
-- CHECK próprio) nem de `crm_leads` (funil de vendas do próprio escritório).
-- `accounting_client_companies` é entidade jurídica (CNPJ) que o TENANT
-- (o escritório) administra como cliente dele — dois graus de tenancy.
--
-- Escopo desta fundação: Contábil apenas (empresas-cliente, plano de contas,
-- lançamentos em partida dobrada). Fiscal (NFe/SPED/SEFAZ) e Pessoal
-- (folha/eSocial) ficam de fora — exigem integração com sistemas do governo,
-- fora do escopo deste pivot.
--
-- ═══ PARTIDA DOBRADA: A GARANTIA MORA NO INVARIANTE, NÃO NO CHECK ═══
--
-- `debit_cents=0 XOR credit_cents=0` é validável por linha (CHECK simples).
-- `sum(debit) = sum(credit)` por lançamento NÃO é — precisaria de um trigger
-- de agregação disparado em toda linha, e a doutrina de migrations não
-- proíbe trigger de validação (só proíbe trigger que faz HTTP). Mesmo assim,
-- esta fundação NÃO traz esse trigger: fica como teste de invariante
-- (tests/invariants/), que é onde o time de engenharia decide a política de
-- erro (rejeitar no INSERT vs. permitir rascunho desbalanceado até o posting)
-- — decisão de produto, não de schema. Dívida declarada, não escondida.

CREATE TABLE IF NOT EXISTS "public"."accounting_client_companies" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "legal_name" text NOT NULL,
    "trade_name" text,
    "cnpj" text NOT NULL,
    "tax_regime" text,
    "status" text DEFAULT 'active'::text NOT NULL,
    "created_by_user_id" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "accounting_client_companies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_client_companies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "accounting_client_companies_org_cnpj_key" UNIQUE ("organization_id", "cnpj")
);

ALTER TABLE "public"."accounting_client_companies" OWNER TO "postgres";
COMMENT ON TABLE "public"."accounting_client_companies" IS 'Empresas atendidas pelo escritório contábil (tenant). Entidade jurídica distinta de contacts (pessoa física) e crm_leads (funil de vendas do próprio escritório).';

CREATE INDEX IF NOT EXISTS "idx_accounting_client_companies_org" ON "public"."accounting_client_companies" USING btree ("organization_id");

CREATE TABLE IF NOT EXISTS "public"."accounting_chart_of_accounts" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "client_company_id" uuid NOT NULL,
    "code" text NOT NULL,
    "name" text NOT NULL,
    "account_type" text NOT NULL,
    "parent_id" uuid,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "accounting_chart_of_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_chart_of_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "accounting_chart_of_accounts_client_company_id_fkey" FOREIGN KEY ("client_company_id") REFERENCES "public"."accounting_client_companies"("id") ON DELETE CASCADE,
    CONSTRAINT "accounting_chart_of_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."accounting_chart_of_accounts"("id") ON DELETE RESTRICT,
    CONSTRAINT "accounting_chart_of_accounts_company_code_key" UNIQUE ("client_company_id", "code"),
    -- Vocabulário FECHADO de propósito: são as 5 classes clássicas da
    -- contabilidade de partida dobrada, estáveis há séculos — o oposto do
    -- vocabulário aberto de `status`/`kind` usado em todo o resto do produto
    -- (doutrina DIRC: CHECK só quando o vocabulário não muda por decisão
    -- comercial de terceiro, como a Asaas).
    CONSTRAINT "accounting_chart_of_accounts_account_type_check" CHECK (("account_type" = ANY (ARRAY['asset'::text, 'liability'::text, 'equity'::text, 'revenue'::text, 'expense'::text])))
);

ALTER TABLE "public"."accounting_chart_of_accounts" OWNER TO "postgres";
COMMENT ON TABLE "public"."accounting_chart_of_accounts" IS 'Plano de contas por empresa-cliente. parent_id ON DELETE RESTRICT: apagar uma conta com filhas quebraria a hierarquia em silêncio.';

CREATE INDEX IF NOT EXISTS "idx_accounting_chart_of_accounts_company" ON "public"."accounting_chart_of_accounts" USING btree ("client_company_id");

CREATE TABLE IF NOT EXISTS "public"."accounting_journal_entries" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "client_company_id" uuid NOT NULL,
    "entry_date" date NOT NULL,
    "description" text NOT NULL,
    "status" text DEFAULT 'draft'::text NOT NULL,
    "created_by_user_id" uuid,
    "posted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "accounting_journal_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_journal_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "accounting_journal_entries_client_company_id_fkey" FOREIGN KEY ("client_company_id") REFERENCES "public"."accounting_client_companies"("id") ON DELETE CASCADE
    -- `status` (draft/posted/reconciled) é vocabulário aberto DE PROPÓSITO:
    -- fluxo de conciliação bancária é roadmap futuro e provavelmente traz
    -- status novo; CHECK aqui quebraria update.sh de clone no primeiro status
    -- inédito, mesmo raciocínio de organization_subscriptions.status.
);

ALTER TABLE "public"."accounting_journal_entries" OWNER TO "postgres";
COMMENT ON TABLE "public"."accounting_journal_entries" IS 'Cabeçalho do lançamento contábil. status vocabulário aberto (sem CHECK) — ver doutrina DIRC no cabeçalho da migration 0170.';

CREATE INDEX IF NOT EXISTS "idx_accounting_journal_entries_company_date" ON "public"."accounting_journal_entries" USING btree ("client_company_id", "entry_date" DESC);

CREATE TABLE IF NOT EXISTS "public"."accounting_journal_entry_lines" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "journal_entry_id" uuid NOT NULL,
    "account_id" uuid NOT NULL,
    "debit_cents" bigint DEFAULT 0 NOT NULL,
    "credit_cents" bigint DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "accounting_journal_entry_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_journal_entry_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."accounting_journal_entries"("id") ON DELETE CASCADE,
    CONSTRAINT "accounting_journal_entry_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounting_chart_of_accounts"("id") ON DELETE RESTRICT,
    CONSTRAINT "accounting_journal_entry_lines_debit_or_credit_check" CHECK ((("debit_cents" >= 0) AND ("credit_cents" >= 0) AND (("debit_cents" = 0) <> ("credit_cents" = 0))))
);

ALTER TABLE "public"."accounting_journal_entry_lines" OWNER TO "postgres";
COMMENT ON TABLE "public"."accounting_journal_entry_lines" IS 'Linhas de partida dobrada. CHECK garante débito XOR crédito por linha; sum(debit)=sum(credit) por lançamento é invariante de teste (tests/invariants/), não de schema — ver cabeçalho da migration 0170.';

CREATE INDEX IF NOT EXISTS "idx_accounting_journal_entry_lines_entry" ON "public"."accounting_journal_entry_lines" USING btree ("journal_entry_id");
CREATE INDEX IF NOT EXISTS "idx_accounting_journal_entry_lines_account" ON "public"."accounting_journal_entry_lines" USING btree ("account_id");

-- Timeline da empresa-cliente — mesmo padrão polimórfico já validado de
-- crm_lead_activities, trocando lead_id por client_company_id. Consumidor
-- concreto: painel da empresa-cliente (Fase 5 do app), como timeline.
CREATE TABLE IF NOT EXISTS "public"."accounting_client_company_activities" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "client_company_id" uuid NOT NULL,
    "source_module" text NOT NULL,
    "source_id" uuid,
    "type" text NOT NULL,
    "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "performed_at" timestamp with time zone DEFAULT now() NOT NULL,
    "performed_by_user_id" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "accounting_client_company_activities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_client_company_activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "accounting_client_company_activities_client_company_id_fkey" FOREIGN KEY ("client_company_id") REFERENCES "public"."accounting_client_companies"("id") ON DELETE CASCADE
);

ALTER TABLE "public"."accounting_client_company_activities" OWNER TO "postgres";
COMMENT ON TABLE "public"."accounting_client_company_activities" IS 'Timeline da empresa-cliente — mesmo padrão de crm_lead_activities.';

CREATE INDEX IF NOT EXISTS "idx_accounting_client_company_activities_company" ON "public"."accounting_client_company_activities" USING btree ("client_company_id", "performed_at" DESC);

ALTER TABLE "public"."accounting_client_companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."accounting_chart_of_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."accounting_journal_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."accounting_journal_entry_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."accounting_client_company_activities" ENABLE ROW LEVEL SECURITY;

-- RBAC de verdade, não isolamento só-tenancy (doutrina da migration 0150 —
-- vigiada por tests/invariants/rbac-config-ia-canais.test.ts, que reprova
-- QUALQUER tabela nova com policy `ALL` sem `fn_role_at_least` no corpo).
-- Leitura: qualquer membro do tenant (viewer+). Escrita: manager+ — dado
-- financeiro do escritório não é edição de agent/viewer, mesmo critério que
-- a matriz da spec 13 aplica a `pipelines (config)`.
DROP POLICY IF EXISTS "tenant_isolation_accounting_client_companies_all" ON "public"."accounting_client_companies";
DROP POLICY IF EXISTS "accounting_client_companies_select" ON "public"."accounting_client_companies";
CREATE POLICY "accounting_client_companies_select" ON "public"."accounting_client_companies" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
DROP POLICY IF EXISTS "accounting_client_companies_write" ON "public"."accounting_client_companies";
CREATE POLICY "accounting_client_companies_write" ON "public"."accounting_client_companies" FOR ALL USING (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"())) WITH CHECK (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"()));

DROP POLICY IF EXISTS "tenant_isolation_accounting_chart_of_accounts_all" ON "public"."accounting_chart_of_accounts";
DROP POLICY IF EXISTS "accounting_chart_of_accounts_select" ON "public"."accounting_chart_of_accounts";
CREATE POLICY "accounting_chart_of_accounts_select" ON "public"."accounting_chart_of_accounts" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
DROP POLICY IF EXISTS "accounting_chart_of_accounts_write" ON "public"."accounting_chart_of_accounts";
CREATE POLICY "accounting_chart_of_accounts_write" ON "public"."accounting_chart_of_accounts" FOR ALL USING (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"())) WITH CHECK (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"()));

DROP POLICY IF EXISTS "tenant_isolation_accounting_journal_entries_all" ON "public"."accounting_journal_entries";
DROP POLICY IF EXISTS "accounting_journal_entries_select" ON "public"."accounting_journal_entries";
CREATE POLICY "accounting_journal_entries_select" ON "public"."accounting_journal_entries" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
DROP POLICY IF EXISTS "accounting_journal_entries_write" ON "public"."accounting_journal_entries";
CREATE POLICY "accounting_journal_entries_write" ON "public"."accounting_journal_entries" FOR ALL USING (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"())) WITH CHECK (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"()));

DROP POLICY IF EXISTS "tenant_isolation_accounting_client_company_activities_all" ON "public"."accounting_client_company_activities";
DROP POLICY IF EXISTS "accounting_client_company_activities_select" ON "public"."accounting_client_company_activities";
CREATE POLICY "accounting_client_company_activities_select" ON "public"."accounting_client_company_activities" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
DROP POLICY IF EXISTS "accounting_client_company_activities_write" ON "public"."accounting_client_company_activities";
CREATE POLICY "accounting_client_company_activities_write" ON "public"."accounting_client_company_activities" FOR ALL USING (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"())) WITH CHECK (((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"()));

DROP POLICY IF EXISTS "tenant_isolation_accounting_journal_entry_lines_all" ON "public"."accounting_journal_entry_lines";
DROP POLICY IF EXISTS "accounting_journal_entry_lines_select" ON "public"."accounting_journal_entry_lines";
CREATE POLICY "accounting_journal_entry_lines_select" ON "public"."accounting_journal_entry_lines" FOR SELECT USING (("journal_entry_id" IN ( SELECT "aje"."id" FROM "public"."accounting_journal_entries" "aje" WHERE (("aje"."organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()))));
DROP POLICY IF EXISTS "accounting_journal_entry_lines_write" ON "public"."accounting_journal_entry_lines";
CREATE POLICY "accounting_journal_entry_lines_write" ON "public"."accounting_journal_entry_lines" FOR ALL USING (("journal_entry_id" IN ( SELECT "aje"."id" FROM "public"."accounting_journal_entries" "aje" WHERE (("aje"."organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("aje"."organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"()))) WITH CHECK (("journal_entry_id" IN ( SELECT "aje"."id" FROM "public"."accounting_journal_entries" "aje" WHERE (("aje"."organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("aje"."organization_id", 'manager'::"text")) OR "public"."fn_is_platform_admin"())));

NOTIFY pgrst, 'reload schema';
