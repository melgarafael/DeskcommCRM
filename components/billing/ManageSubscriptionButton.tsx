"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export function ManageSubscriptionButton({ idioma }: { idioma: Idioma }) {
  const t = (text: string) => traduzir(text, idioma);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function openPortal() {
    setPending(true);
    setError(false);
    try {
      const response = await fetch("/api/v1/billing/portal", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Portal unavailable");
      const data: unknown = await response.json();
      const url = (data as { data?: { url?: unknown } })?.data?.url;
      if (typeof url !== "string" || new URL(url).origin !== "https://billing.stripe.com")
        throw new Error("Invalid portal URL");
      window.location.assign(url);
    } catch {
      setError(true);
      setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button type="button" onClick={openPortal} disabled={pending} aria-busy={pending}>
        {pending ? t("Abrindo gestão da assinatura...") : t("Gerenciar assinatura")}
      </Button>
      <p className="text-sm text-muted-foreground">
        {t("Consulte faturas, atualize o pagamento ou cancele sua assinatura.")}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t("Não foi possível abrir a gestão da assinatura. Tente novamente.")}
        </p>
      )}
    </div>
  );
}
