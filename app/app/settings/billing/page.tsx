import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { emailDeSuporte } from "@/lib/branding/saida";
import { Card } from "@/components/ui/card";
import { AcoesDaAssinatura } from "@/components/cobranca/AcoesDaAssinatura";
import { PainelDaAssinatura } from "@/components/cobranca/PainelDaAssinatura";
import { lerPainelDaAssinatura } from "@/lib/cobranca/painel";
import { traduzir } from "@/lib/i18n/dicionario";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * A tela de dinheiro entregava o nosso contato ao cliente do revendedor, e ela
 * tem porta de 1ª classe no menu. Mesmo tratamento da tela de conta suspensa:
 * o endereço é o de quem opera a instalação (`SUPPORT_EMAIL`) e, sem ele
 * configurado, nenhum endereço aparece.
 *
 * Com a cobrança do revendedor ligada (spec §9), o cartão de "em breve" dá
 * lugar ao painel da assinatura, só leitura na PR 2. Desligada, nada muda.
 */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ voltou?: string }> }) {
  // spec 13 §4: billing é admin-only (viewer/agent/manager = none).
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;
  const admin = createAdminClient();
  const painel = (await moduloLigado(admin, "cobranca"))
    ? await lerPainelDaAssinatura(admin, activeOrg.orgId)
    : null;
  const suporte = painel ? null : await emailDeSuporte();
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        {/* Mesmo nome do item de menu (catalogo.ts), ligada ou não. */}
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Plano e cobrança", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Planos, faturas e cobrança.", idioma)}
        </p>
      </header>
      {painel ? (
        <>
          <PainelDaAssinatura dados={painel} idioma={idioma} />
          {painel.assinatura && (
            <AcoesDaAssinatura
              estado={painel.assinatura.estado}
              temProvedor={painel.assinatura.provedor !== null}
              assinaturasVivas={painel.assinatura.assinaturas_vivas}
              linkDePagamento={painel.assinatura.link_de_pagamento}
              cancelaNoFim={painel.assinatura.cancela_no_fim}
              planosParaTroca={painel.planosParaTroca}
              provedor={painel.checkout.provedor}
              documentoDoCadastro={painel.checkout.documentoDoCadastro}
              voltouDoCheckout={(await searchParams).voltou === "1"}
              noHub={false}
              fuso={painel.fuso}
            />
          )}
        </>
      ) : (
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
      )}
    </div>
  );
}
