/** Commercial catalogue. Prices are BRL cents per month; never provider identifiers. */
export const SUBSCRIPTION_PLANS = [
  {
    id: "essencial",
    name: "Essencial",
    description: "Para começar a atender com organização e IA.",
    monthly_price_cents: 19700,
    currency: "BRL",
    seats: 2,
    channels: 1,
    agents: 2,
    ai_credit_cents: 3000,
  },
  {
    id: "crescer",
    name: "Crescer",
    description: "Para unir a equipe, os canais e as oportunidades.",
    monthly_price_cents: 39700,
    currency: "BRL",
    seats: 5,
    channels: 3,
    agents: 5,
    ai_credit_cents: 8000,
  },
  {
    id: "escala",
    name: "Escala",
    description: "Para uma operação maior, com mais pessoas e agentes.",
    monthly_price_cents: 79700,
    currency: "BRL",
    seats: 15,
    channels: 8,
    agents: 15,
    ai_credit_cents: 18000,
  },
] as const;

export type SubscriptionPlanId = (typeof SUBSCRIPTION_PLANS)[number]["id"];
export function subscriptionPlan(id: string) {
  return SUBSCRIPTION_PLANS.find((plan) => plan.id === id) ?? null;
}

export function formatBRL(cents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
