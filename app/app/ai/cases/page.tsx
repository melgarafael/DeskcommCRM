import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { avisoDeVazioDeCasos, lerLiberacaoDeCasos } from "@/lib/ai/cases/liberacao-de-casos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { CaseList } from "./_components/CaseList";

export const dynamic = "force-dynamic";

export default async function CasesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // GET/POST de /api/v1/ai/cases exigem role agent+ (requireRole("agent")) —
  // abaixo disso a rota nem devolve dado, então a tela inteira gate aqui.
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.agent) redirect("/app");
  const idioma = user.idioma;

  // A fila é da ORGANIZAÇÃO (a rota lista `org.orgId`, sem agente), então a
  // pergunta "por que está vazia?" também é: existe algum agente que consiga
  // abrir caso? `cases_enabled` vem desligada de fábrica, e sem esta leitura a
  // tela mostrava "nenhum caso ainda" para quem nunca poderia ter um.
  const liberacao = await lerLiberacaoDeCasos(createAdminClient(), activeOrg.orgId);
  const aviso = avisoDeVazioDeCasos(liberacao, {
    // `/app/ai/agents/[id]` redireciona 403 abaixo de manager; escrever e
    // publicar versão exige admin (`_actions.ts`).
    podeVerAgente: ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager,
    podeEditar: ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin,
  });

  return (
    <div className="flex h-[calc(100dvh-3.5rem-var(--space-6)-max(var(--space-6),var(--rodape-ocupado,0px)))] min-h-0 flex-col sm:p-6">
      <CaseList aviso={aviso} heading={
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Casos", idioma)}</h1>
          <p className="text-sm text-muted-foreground">
            {traduzir(
              "Quando a IA trava em algo que só um humano resolve, ela abre um caso aqui — e continua conversando com o cliente enquanto espera sua resposta.",
              idioma,
            )}
          </p>
        </header>
      } />
    </div>
  );
}
