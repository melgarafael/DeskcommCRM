import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { ProposalsList } from "./_components/ProposalsList";

export const dynamic = "force-dynamic";

/**
 * Propostas — as próximas ações que o assistente sugeriu, em lista.
 *
 * Antes desta tela a sugestão só existia dentro do card, no board: quem não
 * passasse naquela coluna nunca a via, e ela apodrecia sem ninguém saber que
 * havia algo para decidir. O mecanismo anti-morte morria pela mesma causa que
 * ele existe para matar.
 *
 * Decidir exige `agent` — mesmo posto que a rota de decisão cobra. Quem tem
 * menos vê a lista (saber o que a IA propôs é contexto de trabalho) e não
 * decide, em vez de não ver nada.
 */
export default async function ProposalsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const canDecide = ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text">{traduzir("Propostas", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Próximos passos que o assistente sugeriu e esperam sua decisão. Aprovar e ignorar são registrados — ignorar é uma decisão, não a falta dela.",
            idioma,
          )}
        </p>
      </header>
      <ProposalsList canDecide={canDecide} />
    </div>
  );
}
