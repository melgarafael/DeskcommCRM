import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { emailDeSuporte } from "@/lib/branding/saida";
import { Card } from "@/components/ui/card";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * A tela de dinheiro entregava o nosso contato ao cliente do revendedor, e ela
 * tem porta de 1ª classe no menu. Mesmo tratamento da tela de conta suspensa:
 * o endereço é o de quem opera a instalação (`SUPPORT_EMAIL`) e, sem ele
 * configurado, nenhum endereço aparece.
 */
export default async function BillingPage() {
  // spec 13 §4: billing é admin-only (viewer/agent/manager = none).
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const suporte = emailDeSuporte();
  const idioma = user.idioma;
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text">Billing</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Planos, faturas e cobrança.", idioma)}
        </p>
      </header>
      <Card className="max-w-xl p-6">
        <h2 className="text-sm font-semibold">{traduzir("Em breve — Fase 2", idioma)}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {traduzir("Billing entra na Fase 2 do roadmap.", idioma)}{" "}
          {suporte ? (
            <>
              {traduzir("Para questões de pagamento, contate", idioma)}{" "}
              <a className="underline" href={`mailto:${suporte}`}>
                {suporte}
              </a>
              .
            </>
          ) : (
            <>{traduzir("Para questões de pagamento, fale com quem administra este sistema.", idioma)}</>
          )}
        </p>
      </Card>
    </div>
  );
}
