import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { subscriptionPlan } from "@/lib/billing/plans";
import {
  billingConfiguration,
  createStripeCheckout,
  BillingUnavailable,
} from "@/lib/billing/stripe";

export async function POST(request: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "billing" });
  if (!auth.ok) return auth.response;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  if (auth.user.support)
    return fail("forbidden", "A cobrança deve ser gerenciada pelo administrador da empresa.", 403, {
      requestId,
    });
  let config;
  try {
    config = billingConfiguration();
  } catch {
    return fail("service_unavailable", new BillingUnavailable().message, 503, { requestId });
  }
  if (request.headers.get("origin") !== config.origin)
    return fail("forbidden", "Origem inválida.", 403, { requestId });
  const parsed = z
    .object({ plan_id: z.string() })
    .strict()
    .safeParse(await request.json().catch(() => null));
  const plan = parsed.success ? subscriptionPlan(parsed.data.plan_id) : null;
  if (!plan) return fail("invalid_request", "Escolha um plano disponível.", 400, { requestId });
  const db = await getRequestPool()
    .connect()
    .catch(() => null);
  if (!db)
    return fail(
      "service_unavailable",
      "Não foi possível acessar a cobrança. Tente novamente.",
      503,
    );
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `billing:${auth.org.orgId}`,
    ]);
    await db.query(
      "insert into org_subscriptions(organization_id) values($1) on conflict do nothing",
      [auth.org.orgId],
    );
    const {
      rows: [current],
    } = await db.query("select * from org_subscriptions where organization_id=$1 for update", [
      auth.org.orgId,
    ]);
    if (
      current.provider_subscription_id &&
      !["canceled", "incomplete_expired"].includes(current.status)
    ) {
      await db.query("rollback");
      return fail(
        "conflict",
        "Esta empresa já possui uma assinatura. Gerencie o plano existente.",
        409,
        { requestId },
      );
    }
    if (current.checkout_url && new Date(current.checkout_expires_at).getTime() > Date.now()) {
      await db.query("commit");
      if (current.plan_id !== plan.id)
        return fail(
          "conflict",
          "Existe um pagamento em andamento para outro plano. Conclua ou aguarde sua expiração.",
          409,
          { requestId },
        );
      return ok({ url: current.checkout_url }, { requestId });
    }
    const replacingSubscription =
      Boolean(current.provider_subscription_id) &&
      ["canceled", "incomplete_expired"].includes(current.status);
    const retryingUnconfirmedCheckout = !current.checkout_session_id && !replacingSubscription;
    // Stripe can prune idempotency keys after 24h. Never replay an ambiguous
    // request beyond a conservative 23h window without provider reconciliation.
    if (
      current.plan_id &&
      retryingUnconfirmedCheckout &&
      (!Number.isFinite(new Date(current.updated_at).getTime()) ||
        Date.now() - new Date(current.updated_at).getTime() >= 23 * 60 * 60 * 1000)
    ) {
      await db.query("rollback");
      return fail(
        "conflict",
        "O pagamento anterior precisa ser conferido antes de iniciar outro. Entre em contato com o suporte.",
        409,
        { requestId },
      );
    }
    // Persist the attempt before calling Stripe. An ambiguous failure must reuse its key.
    const attempt =
      current.checkout_session_id || replacingSubscription
        ? randomUUID()
        : current.checkout_attempt_id;
    if (current.plan_id && current.plan_id !== plan.id && retryingUnconfirmedCheckout) {
      await db.query("rollback");
      return fail(
        "conflict",
        "Tente novamente o plano escolhido anteriormente para recuperar o pagamento pendente.",
        409,
        { requestId },
      );
    }
    await db.query(
      "update org_subscriptions set plan_id=$2,checkout_attempt_id=$3,checkout_session_id=null,checkout_url=null,checkout_expires_at=null,updated_at=now() where organization_id=$1 and (plan_id is distinct from $2 or checkout_attempt_id is distinct from $3)",
      [auth.org.orgId, plan.id, attempt],
    );
    await db.query("commit");
    const session = await createStripeCheckout({
      organizationId: auth.org.orgId,
      planId: plan.id,
      customerId: current.provider_customer_id ?? undefined,
      attemptId: attempt,
    });
    const saved = await db.query(
      "update org_subscriptions set checkout_session_id=$2,checkout_url=$3,checkout_expires_at=to_timestamp($4),updated_at=now() where organization_id=$1 and checkout_attempt_id=$5 and checkout_session_id is distinct from $2",
      [auth.org.orgId, session.id, session.url, session.expires_at, attempt],
    );
    if (saved.rowCount)
      void audit({
        action: "billing.checkout_created",
        organizationId: auth.org.orgId,
        actorUserId: auth.user.id,
        resourceType: "org_subscriptions",
        resourceId: auth.org.orgId,
        requestId,
        bypassedRls: true,
        metadata: {
          provider: "stripe",
          plan_id: plan.id,
          checkout_session_id: session.id,
          checkout_attempt_id: attempt,
        },
      });
    return ok({ url: session.url }, { requestId });
  } catch {
    await db.query("rollback").catch(() => undefined);
    return fail(
      "service_unavailable",
      "Não foi possível abrir o pagamento. Sua assinatura não foi alterada. Tente novamente.",
      503,
      { requestId },
    );
  } finally {
    db.release();
  }
}
