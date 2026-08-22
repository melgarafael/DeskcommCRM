import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { isBillingEnabled } from "@/lib/asaas/config";
import { ensureAsaasCustomer } from "@/lib/asaas/customers";
import { createOrganizationSubscription } from "@/lib/asaas/subscriptions";

/** Normaliza o nome da empresa para um slug candidato (citext unique no DB). */
function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "org";
}

type ProvisionUser = {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};

/**
 * Provisiona o tenant de um usuário recém-confirmado via signup self-service:
 * cria a organização (status `active`, `onboarded_at` null → cai no onboarding)
 * e a membership `admin` do usuário.
 *
 * Idempotente: se o usuário já tem membership ativa (link de confirmação
 * clicado duas vezes, ou usuário que entrou antes por convite), não faz nada.
 *
 * Service role é intencional aqui — o usuário ainda não pertence a nenhuma org,
 * então RLS bloquearia os INSERTs. A fonte confiável é o JWT já validado por
 * `verifyOtp` no caller (nunca o body).
 */
export async function ensureTenantForUser(
  user: ProvisionUser,
): Promise<{ provisioned: boolean; organizationId?: string }> {
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  if (existing) return { provisioned: false, organizationId: existing.organization_id };

  const orgName =
    (user.user_metadata?.org_name as string | undefined)?.trim() ||
    user.email?.split("@")[0] ||
    "Minha empresa";
  const base = slugify(orgName);

  // ponytail: check-then-insert tem janela de corrida se o mesmo link for
  // confirmado 2x em paralelo (pior caso: org duplicada órfã). Advisory lock
  // por user_id se isso aparecer na prática.
  let org: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 3 && !org; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await admin
      .from("organizations")
      .insert({
        slug,
        display_name: orgName,
        legal_name: orgName,
        status: "active",
        created_by: user.id,
      })
      .select("id, slug")
      .single();
    if (data) {
      org = data;
    } else if (error && error.code !== "23505") {
      throw new Error(`signup provisioning: org insert failed: ${error.message}`);
    }
  }
  if (!org) throw new Error("signup provisioning: slug exhausted after 3 attempts");

  const { error: memberError } = await admin.from("user_organizations").insert({
    user_id: user.id,
    organization_id: org.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (memberError && memberError.code !== "23505") {
    throw new Error(`signup provisioning: membership insert failed: ${memberError.message}`);
  }

  void audit({
    action: "tenant.created_by_signup",
    actorUserId: user.id,
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    bypassedRls: true,
    metadata: { slug: org.slug },
  });

  // Assinatura Asaas — só quando a instância roda BILLING_MODE=asaas E o
  // signup escolheu um plano (Fase 4 do pivot ADR-0002). Self-host nunca
  // executa este bloco: plan_id nunca chega no user_metadata de quem usa o
  // formulário sem seletor de plano (billing_plans vazio → SignupForm nem
  // renderiza o campo).
  const planId = user.user_metadata?.plan_id as string | undefined;
  if (planId && isBillingEnabled()) {
    const cnpj = user.user_metadata?.cnpj as string | undefined;
    try {
      if (!cnpj) throw new Error("cnpj ausente no metadata do signup");
      const { data: planRow } = await admin
        .from("billing_plans")
        .select("id, price_cents, billing_interval")
        .eq("id", planId)
        .eq("is_active", true)
        .maybeSingle();
      if (!planRow) throw new Error(`plano ${planId} não encontrado ou inativo`);

      const asaasCustomerId = await ensureAsaasCustomer({
        organizationId: org.id,
        legalName: orgName,
        email: user.email,
        cnpj,
      });
      await createOrganizationSubscription({
        organizationId: org.id,
        planId: planRow.id,
        asaasCustomerId,
        priceCents: planRow.price_cents,
        billingInterval: planRow.billing_interval as "monthly" | "yearly",
      });
    } catch (err) {
      // A organização NUNCA fica travada por uma falha de rede/config da
      // Asaas no instante exato do cadastro (invariante: o signup é o
      // caminho mais barato de abandono do produto inteiro). Falha aberta na
      // AÇÃO (org segue active) e fechada na INFORMAÇÃO (aviso concreto na
      // Central, não um log que só quem sabe SQL acha).
      const motivo = (err as Error).message;
      logger.error("[signup] falha ao criar assinatura Asaas", {
        organization_id: org.id,
        plan_id: planId,
        error: motivo,
      });
      await admin.from("agent_inbox_items").insert({
        organization_id: org.id,
        kind: "billing_subscription_pending",
        title: "Assinatura de cobrança não foi criada",
        body: `O cadastro escolheu um plano pago, mas a assinatura na Asaas não pôde ser criada (${motivo}). A organização continua ativa; configure a cobrança manualmente em Configurações > Billing ou pelo console admin.`,
        ref_kind: "organization",
        ref_id: org.id,
      });
    }
  }

  return { provisioned: true, organizationId: org.id };
}
