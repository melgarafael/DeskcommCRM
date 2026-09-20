import { SUBSCRIPTION_PLANS, subscriptionPlan, type SubscriptionPlanId } from "./plans";

export interface SubscriptionSnapshot {
  provider: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  plan_id: string | null;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end: Date | string | null;
  checkout_session_id: string | null;
  checkout_expires_at: Date | string | null;
}

/** Only server-confirmed subscription data can label a plan active. */
export function subscriptionView(subscription: SubscriptionSnapshot | undefined, now = Date.now()) {
  const plan = subscriptionPlan(subscription?.plan_id ?? "");
  const bound = Boolean(subscription?.provider_subscription_id);
  const pending = subscription?.status === "pending";
  const terminal = ["canceled", "incomplete_expired"].includes(subscription?.status ?? "");
  const paidThrough = subscription?.current_period_end
    ? new Date(subscription.current_period_end).getTime()
    : NaN;
  const active =
    bound && ["active", "trialing"].includes(subscription?.status ?? "") && paidThrough > now;
  const caktoBound = subscription?.provider === "cakto" && bound;
  const checkoutPending =
    Boolean(subscription?.plan_id) &&
    (!bound || terminal || pending) &&
    ((subscription?.provider === "cakto" && !bound) ||
      ((!bound || pending) && !subscription?.checkout_session_id) ||
      new Date(subscription?.checkout_expires_at ?? 0).getTime() > now);
  const allowedPlanIds: SubscriptionPlanId[] =
    caktoBound || (bound && !terminal && !pending)
      ? []
      : checkoutPending
        ? plan
          ? [plan.id]
          : []
        : SUBSCRIPTION_PLANS.map((item) => item.id);
  const message = active
    ? subscription?.cancel_at_period_end
      ? "Renovação cancelada. Seu plano permanece disponível até o fim do período pago."
      : "Sua assinatura está ativa."
    : caktoBound
      ? "Sua assinatura precisa de confirmação. Atualize a página ou contate o suporte."
      : bound && !terminal && !pending
        ? "Sua assinatura precisa de atenção. Abra a gestão para conferir o pagamento."
        : terminal
          ? "Sua assinatura foi encerrada. Seus recursos existentes foram preservados."
          : checkoutPending
            ? "O pagamento ainda não foi confirmado. Você pode continuar com o plano escolhido."
            : "Escolha o plano que combina com sua equipe.";
  return {
    plan,
    active,
    message,
    allowedPlanIds,
    caktoBound,
    canManage: subscription?.provider === "stripe" && Boolean(subscription.provider_customer_id),
  };
}
