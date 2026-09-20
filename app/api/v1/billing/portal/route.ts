import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { billingConfiguration, createStripePortal } from "@/lib/billing/stripe";

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
    return fail("service_unavailable", "Cobrança indisponível.", 503, { requestId });
  }
  if (request.headers.get("origin") !== config.origin)
    return fail("forbidden", "Origem inválida.", 403, { requestId });
  if (
    !z
      .object({})
      .strict()
      .safeParse(await request.json().catch(() => null)).success
  )
    return fail("invalid_request", "Pedido inválido.", 400, { requestId });
  try {
    const {
      rows: [subscription],
    } = await getRequestPool().query<{ provider: string; provider_customer_id: string | null }>(
      "select provider,provider_customer_id from org_subscriptions where organization_id=$1",
      [auth.org.orgId],
    );
    if (!subscription?.provider_customer_id || subscription.provider !== "stripe")
      return fail(
        "conflict",
        "Esta empresa ainda não possui uma conta de cobrança vinculada.",
        409,
        { requestId },
      );
    const session = await createStripePortal(subscription.provider_customer_id);
    void audit({
      action: "billing.portal_opened",
      organizationId: auth.org.orgId,
      actorUserId: auth.user.id,
      resourceType: "org_subscriptions",
      resourceId: auth.org.orgId,
      requestId,
      bypassedRls: true,
    });
    return ok(session, { requestId });
  } catch {
    return fail(
      "service_unavailable",
      "Não foi possível abrir a gestão da assinatura. Tente novamente.",
      503,
      { requestId },
    );
  }
}
