"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { SubscriptionPlanId } from "@/lib/billing/plans";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export function CheckoutButton({ planId, idioma }: { planId: SubscriptionPlanId; idioma: Idioma }) {
  const t = (text: string) => traduzir(text, idioma);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function checkout() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/billing/checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: planId }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        setError(
          response.status === 409
            ? "Já existe uma assinatura ou pagamento em andamento. Atualize a página para conferir."
            : "Não foi possível abrir o pagamento. Tente novamente.",
        );
        setPending(false);
        return;
      }
      const payload: unknown = await response.json();
      const url = (payload as { data?: { url?: unknown } })?.data?.url;
      if (
        typeof url !== "string" ||
        !["https://checkout.stripe.com", "https://pay.cakto.com.br"].includes(new URL(url).origin)
      )
        throw new Error("Invalid checkout URL");
      window.location.assign(url);
    } catch {
      setError("Não foi possível abrir o pagamento. Tente novamente.");
      setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button
        type="button"
        className="w-full"
        onClick={checkout}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? t("Abrindo pagamento...") : t("Continuar para pagamento")}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(error)}
        </p>
      )}
    </div>
  );
}
