import { redirect } from "next/navigation";

import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { AgentInboxList } from "./_components/AgentInboxList";
import { LembreteDeCasoParado } from "./_components/LembreteDeCasoParado";

export const dynamic = "force-dynamic";

export default async function AgentInboxPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const canResolve = ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const idioma = user.idioma;

  // O cartão do lembrete de caso parado (migration 0766) é de quem administra:
  // é a mesma régua da action que o grava, e mostrá-lo a quem ela recusa seria
  // oferecer um formulário que nunca salva.
  let lembrete: { ligado: boolean; intervaloHoras: number; teto: number } | null = null;
  if (podeAdministrarEmpresa(user, activeOrg)) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("organizations")
      .select("lembrete_caso_ligado, lembrete_caso_intervalo_horas, lembrete_caso_teto")
      .eq("id", activeOrg.orgId)
      .maybeSingle();
    if (data) {
      lembrete = {
        ligado: data.lembrete_caso_ligado as boolean,
        intervaloHoras: data.lembrete_caso_intervalo_horas as number,
        teto: data.lembrete_caso_teto as number,
      };
    }
  }

  return (
    <div className="flex h-full flex-col gap-6 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Central de avisos", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "O que o assistente precisou escalar para o time: conexões caídas, tarefas que falharam, atendimentos passados a humanos.",
            idioma,
          )}
        </p>
      </header>
      {lembrete && <LembreteDeCasoParado inicial={lembrete} />}
      <AgentInboxList canResolve={canResolve} />
    </div>
  );
}
