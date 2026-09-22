import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { dadosDoPasso } from "@/app/actions/onboarding/montarQuadro";
import { QuadroClient } from "./_client";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * "Onde ele organiza" — o quadro de clientes.
 *
 * O gatilho `trg_seed_default_pipeline_for_org` semeia o MESMO funil de
 * e-commerce em toda organização: "Carrinho abandonado", "Em separação",
 * "Enviado". A clínica que instalava o sistema abria o quadro dela e lia isso,
 * sem nunca ter sido perguntada em que ramo estava.
 *
 * A sugestão é pedida no RENDER, não num clique: a pessoa chega no passo com a
 * proposta já na tela. Mandar clicar em "gerar sugestão" antes cobraria um passo
 * a mais para chegar exatamente ao mesmo lugar.
 */
export default async function FunilPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");
  const idioma = user.idioma;

  const { atual, sugestao } = await dadosDoPasso(activeOrg.orgId, activeOrg.name);

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-medium text-text tracking-tight">
          {traduzir("Onde ele organiza seus clientes", idioma)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Cada cliente vira um cartão que anda por essas colunas. Ele mesmo move o cartão conforme a conversa avança — por isso cada coluna diz também quando ele deve usá-la.",
            idioma,
          )}
        </p>
      </header>
      <QuadroClient atual={atual} sugestao={sugestao} />
    </div>
  );
}
