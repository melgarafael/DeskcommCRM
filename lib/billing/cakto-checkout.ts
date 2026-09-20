import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { subscriptionPlan } from "./plans";
import { caktoConfiguration, caktoCheckoutUrl, verifyCaktoOffer } from "./cakto";

export async function createCaktoCheckout(request: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "billing" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite();
  if (denied) return denied;
  if (auth.user.support)
    return fail("forbidden", "A cobrança deve ser gerenciada pelo administrador da empresa.", 403, {
      requestId,
    });
  let config;
  try {
    if (process.env.BILLING_ENABLED !== "true") throw new Error();
    config = caktoConfiguration();
  } catch {
    return fail(
      "service_unavailable",
      "A cobrança ainda não está disponível nesta instalação.",
      503,
      { requestId },
    );
  }
  if (request.headers.get("origin") !== config.origin)
    return fail("forbidden", "Origem inválida.", 403, { requestId });
  const parsed = z
    .object({ plan_id: z.string() })
    .strict()
    .safeParse(await request.json().catch(() => null));
  const plan = parsed.success ? subscriptionPlan(parsed.data.plan_id) : null;
  if (!plan) return fail("invalid_request", "Escolha um plano disponível.", 400, { requestId });
  const db = await Promise.resolve()
    .then(() => getRequestPool().connect())
    .catch(() => null);
  if (!db)
    return fail("service_unavailable", "Não foi possível acessar a cobrança.", 503, { requestId });
  try {
    await verifyCaktoOffer(plan.id);
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `billing:${auth.org.orgId}`,
    ]);
    const {
      rows: [current],
    } = await db.query("select * from org_subscriptions where organization_id=$1 for update", [
      auth.org.orgId,
    ]);
    // A hosted link cannot expire a previously opened provider checkout. Never rotate
    // a pending attempt automatically; support must reconcile it before replacement.
    if (
      current &&
      (current.provider !== "cakto" ||
        current.provider_subscription_id ||
        current.plan_id !== plan.id ||
        !current.checkout_attempt_id)
    ) {
      await db.query("rollback");
      return fail(
        "conflict",
        "Já existe uma assinatura ou pagamento em andamento. Gerencie o plano existente ou contate o suporte.",
        409,
        { requestId },
      );
    }
    const attempt = current?.checkout_attempt_id ?? randomUUID();
    const url = caktoCheckoutUrl(plan.id, attempt);
    if (!current)
      await db.query(
        "insert into org_subscriptions(organization_id,provider,plan_id,checkout_attempt_id,checkout_session_id,checkout_url,status) values($1,'cakto',$2,$3,$3,$4,'pending')",
        [auth.org.orgId, plan.id, attempt, url],
      );
    await db.query("commit");
    if (!current)
      void audit({
        action: "billing.checkout_created",
        organizationId: auth.org.orgId,
        actorUserId: auth.user.id,
        resourceType: "org_subscriptions",
        resourceId: auth.org.orgId,
        requestId,
        bypassedRls: true,
        metadata: { provider: "cakto", plan_id: plan.id, checkout_attempt_id: attempt },
      });
    return ok({ url }, { requestId });
  } catch {
    await db.query("rollback").catch(() => undefined);
    return fail(
      "service_unavailable",
      "Não foi possível conferir o pagamento. Tente novamente.",
      503,
      { requestId },
    );
  } finally {
    db.release();
  }
}
