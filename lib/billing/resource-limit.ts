import { ApiErrorCodes } from "@/lib/api/errors";
import { fail } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/** SQLSTATE is the contract; never classify errors from arbitrary message text. */
export function isSubscriptionResourceLimit(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P4020";
}

/** A stable public explanation, without SQL details or provider internals. */
export function subscriptionResourceLimitMessage(idioma: Idioma) {
  return traduzir(
    "Não foi possível adicionar este recurso ao plano atual. Peça ao administrador para conferir os limites e o pagamento em Configurações → Planos e assinatura. Seus recursos existentes foram preservados.",
    idioma,
  );
}

export function subscriptionResourceLimitResponse(requestId: string, idioma: Idioma) {
  return fail(
    ApiErrorCodes.subscription_resource_limit,
    subscriptionResourceLimitMessage(idioma),
    409,
    { requestId, details: { billing_path: "/app/settings/billing" } },
  );
}
