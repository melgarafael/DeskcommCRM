/**
 * Configuração da integração Asaas — só ativa quando BILLING_MODE=asaas.
 *
 * Self-host nunca depende disto (ADR-0002): `isBillingEnabled()` é o único
 * ponto de decisão, e todo chamador do módulo `lib/asaas/*` DEVE checá-lo antes
 * de agir. Sem isso, uma instalação self-host sem ASAAS_API_KEY tentaria criar
 * cliente/assinatura no signup e falharia — ou pior, vazaria a falha para o
 * usuário final de um clone que nunca pediu billing.
 */
import { env } from "@/lib/env";

export function isBillingEnabled(): boolean {
  return env.BILLING_MODE === "asaas";
}

export class BillingDisabledError extends Error {
  constructor() {
    super("Billing está desligado nesta instalação (BILLING_MODE != asaas)");
    this.name = "BillingDisabledError";
  }
}

export function asaasApiBase(): string {
  return env.ASAAS_ENVIRONMENT === "production"
    ? "https://api.asaas.com/v3"
    : "https://sandbox.asaas.com/api/v3";
}
