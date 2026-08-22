-- 0168 — FUNDAÇÃO DE BILLING (Asaas). Schema só; nenhuma integração ainda.
--
-- Parte do pivot ADR-0002 (docs/adr/0002-pivot-saas-pago.md): a instância hospedada
-- Genesisia Contabilidade cobra por assinatura via Asaas. O self-host continua sem
-- nenhuma dependência disto — estas tabelas só passam a ser escritas quando
-- BILLING_MODE=asaas (fora de escopo desta migration; ver Fase 2/3 do plano).
--
-- ═══ FONTE DA VERDADE ═══
--
-- A Asaas é quem decide se um pagamento aconteceu. Este schema é ESPELHO de
-- leitura + trava de acesso, nunca calculadora de preço nem autoridade de
-- cobrança — o mesmo motivo por trás do anti-pattern "trigger faz HTTP"
-- (CLAUDE.md #9): a request handler do tenant (`app/app/layout.tsx`) não pode
-- depender de rede síncrona à Asaas para decidir se a página carrega. O que a
-- Asaas confirma por webhook grava aqui; a UI e a RLS leem só daqui.
--
-- ═══ VOCABULÁRIO ABERTO EM `status` (doutrina DIRC/CLAUDE.md 117-122) ═══
--
-- `organization_subscriptions.status` e `billing_invoices.status` NÃO levam
-- CHECK: são o espelho local dos status que a Asaas emite (`ACTIVE`, `OVERDUE`,
-- `CONFIRMED`, ...) mapeados para vocabulário próprio, e a Asaas pode introduzir
-- um status novo a qualquer momento. Um CHECK aqui faria o `update.sh` de um
-- clone com billing ligado quebrar no primeiro status que a Asaas inventar
-- depois do deploy. `billing_plans.code` segue o mesmo raciocínio: catálogo
-- comercial muda de nome com frequência maior que release de schema.
--
-- ═══ ESCRITA SÓ VIA SERVICE_ROLE ═══
--
-- `organization_subscriptions` e `billing_invoices` não recebem policy de
-- INSERT/UPDATE/DELETE para `authenticated` — só o webhook (service_role,
-- bypassa RLS) grava status de pagamento. Um admin do tenant não pode se
-- autopromover a "pago" escrevendo direto na tabela; só lê, via a mesma policy
-- admin-only de `api_tokens_admin_only`.

CREATE TABLE IF NOT EXISTS "public"."billing_plans" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "code" text NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "price_cents" bigint NOT NULL,
    "currency" text DEFAULT 'BRL'::text NOT NULL,
    "billing_interval" text NOT NULL,
    "features" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "billing_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_plans_code_key" UNIQUE ("code"),
    CONSTRAINT "billing_plans_billing_interval_check" CHECK (("billing_interval" = ANY (ARRAY['monthly'::text, 'yearly'::text])))
);

ALTER TABLE "public"."billing_plans" OWNER TO "postgres";

COMMENT ON TABLE "public"."billing_plans" IS 'Catálogo global de planos pagos (Genesisia Contabilidade / Asaas). Sem organization_id, mesmo padrão de ai_pricing. Escrito por platform_admin ou migration; lido por qualquer autenticado (precisa aparecer no signup e na tela de billing).';

CREATE TABLE IF NOT EXISTS "public"."organization_subscriptions" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "plan_id" uuid NOT NULL,
    "asaas_customer_id" text NOT NULL,
    "asaas_subscription_id" text,
    "status" text DEFAULT 'incomplete'::text NOT NULL,
    "current_period_end" timestamp with time zone,
    "trial_ends_at" timestamp with time zone,
    "canceled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "organization_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_subscriptions_asaas_subscription_id_key" UNIQUE ("asaas_subscription_id"),
    CONSTRAINT "organization_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "organization_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."billing_plans"("id")
);

ALTER TABLE "public"."organization_subscriptions" OWNER TO "postgres";

COMMENT ON TABLE "public"."organization_subscriptions" IS 'Espelho local da assinatura Asaas de cada tenant. Asaas é fonte da verdade; aqui só o último status que o webhook confirmou. Uma organização tem no máximo uma linha ativa (aplicação garante; não há índice parcial único ainda porque o fluxo de troca de plano não está definido).';

CREATE INDEX IF NOT EXISTS "idx_organization_subscriptions_org" ON "public"."organization_subscriptions" USING btree ("organization_id");

CREATE TABLE IF NOT EXISTS "public"."billing_invoices" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "subscription_id" uuid,
    "asaas_payment_id" text NOT NULL,
    "status" text NOT NULL,
    "amount_cents" bigint NOT NULL,
    "currency" text DEFAULT 'BRL'::text NOT NULL,
    "due_date" date,
    "paid_at" timestamp with time zone,
    "invoice_url" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_invoices_asaas_payment_id_key" UNIQUE ("asaas_payment_id"),
    CONSTRAINT "billing_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "billing_invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."organization_subscriptions"("id") ON DELETE SET NULL
);

ALTER TABLE "public"."billing_invoices" OWNER TO "postgres";

COMMENT ON TABLE "public"."billing_invoices" IS 'Espelho de cobranças individuais (faturas/Pix/boleto) reportadas pelo webhook Asaas. subscription_id nullable + ON DELETE SET NULL: perder a assinatura não pode apagar o histórico financeiro (anti-pattern "cascade fantasma", CLAUDE.md #7).';

CREATE INDEX IF NOT EXISTS "idx_billing_invoices_org" ON "public"."billing_invoices" USING btree ("organization_id", "created_at" DESC);

-- Alargamento puro do CHECK existente (doutrina de migrations item 2: idempotente
-- sempre que possível). Sem backfill: aceitar um valor novo não invalida linha
-- nenhuma já gravada. Reaproveita webhook_events_log em vez de tabela nova —
-- mesmo padrão já usado por WAHA e Nuvemshop para o corpo cru do webhook.
--
-- A lista precisa citar TODOS os provedores já aceitos, não só os do dump
-- original: o apêndice do baseline (migration 0151) já ampliou este CHECK para
-- incluir meta_cloud e zernio. Repetir só waha/nuvemshop/generic aqui apagaria
-- os dois na cadeia de migrations (que roda em sequência a partir do dump) —
-- este ALTER precisa ser a lista completa + asaas, não um diff contra o dump.
ALTER TABLE "public"."webhook_events_log" DROP CONSTRAINT IF EXISTS "webhook_events_log_provider_check";
ALTER TABLE "public"."webhook_events_log" ADD CONSTRAINT "webhook_events_log_provider_check" CHECK (("provider" = ANY (ARRAY['waha'::text, 'nuvemshop'::text, 'generic'::text, 'meta_cloud'::text, 'zernio'::text, 'asaas'::text])));

ALTER TABLE "public"."billing_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."organization_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."billing_invoices" ENABLE ROW LEVEL SECURITY;

-- Catálogo é público para autenticado (precisa aparecer no signup, antes de o
-- usuário ter organização) — mesmo padrão de "ai_pricing_public_read". Sem
-- policy de escrita: seed via migration/platform-admin com service_role.
DROP POLICY IF EXISTS "billing_plans_public_read" ON "public"."billing_plans";
CREATE POLICY "billing_plans_public_read" ON "public"."billing_plans" FOR SELECT TO "authenticated" USING (("is_active" = true) OR "public"."fn_is_platform_admin"());

-- Admin-only, mesmo padrão de "api_tokens_admin_only": fn_role_at_least já
-- resolve a associação ao tenant (usuário fora da org => role nula => false),
-- então uma única policy cobre isolamento E papel. Sem WITH CHECK: não há
-- policy de escrita para authenticated (só service_role, que bypassa RLS).
DROP POLICY IF EXISTS "organization_subscriptions_admin_read" ON "public"."organization_subscriptions";
CREATE POLICY "organization_subscriptions_admin_read" ON "public"."organization_subscriptions" FOR SELECT USING (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));

DROP POLICY IF EXISTS "billing_invoices_admin_read" ON "public"."billing_invoices";
CREATE POLICY "billing_invoices_admin_read" ON "public"."billing_invoices" FOR SELECT USING (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));

NOTIFY pgrst, 'reload schema';
