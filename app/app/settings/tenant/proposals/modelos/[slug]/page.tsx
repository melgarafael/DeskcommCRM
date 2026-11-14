import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import type { CampoDoFunilParaRotulo } from "@/lib/propostas/documento/rotulos-das-variaveis";
import { createClient } from "@/lib/supabase/server";
import { EditorDeModelo } from "./_client";

export const metadata = { title: "Modelo de proposta" };

/**
 * Os campos do NEGÓCIO com o rótulo que a empresa deu (#4533) — a lista que o
 * editor mostra como `{{lead.<chave>}}`.
 *
 * Um modelo de proposta não pertence a um funil: ele serve a qualquer negócio
 * da organização. Por isso a lista é a UNIÃO dos funis ativos, com a primeira
 * definição de cada chave vencendo (a mesma chave em dois funis é uma chave
 * só no documento). Lida com o cliente da SESSÃO, no servidor: a RLS recorta a
 * organização, e o editor não gasta um round-trip para montar rótulo.
 *
 * Falha de leitura devolve lista vazia — o editor então mostra o nome derivado
 * da chave, que é o comportamento de antes. Rótulo é cortesia, não conteúdo.
 */
async function camposDoNegocioDaOrganizacao(organizationId: string): Promise<CampoDoFunilParaRotulo[]> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("crm_pipelines")
      .select("settings")
      .eq("organization_id", organizationId)
      .eq("is_archived", false)
      .order("position");

    const vistos = new Set<string>();
    const saida: CampoDoFunilParaRotulo[] = [];
    for (const linha of (data ?? []) as Array<{ settings?: Record<string, unknown> | null }>) {
      for (const campo of camposDoFunil(linha.settings ?? null)) {
        if (vistos.has(campo.key)) continue;
        vistos.add(campo.key);
        saida.push({ key: campo.key, label: campo.label, type: campo.type, escopo: campo.escopo });
      }
    }
    return saida;
  } catch {
    return [];
  }
}

export default async function EditorDeModeloPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const { slug } = await params;
  const camposDoFunilDaOrg = await camposDoNegocioDaOrganizacao(activeOrg.orgId);
  return <EditorDeModelo slug={slug} camposDoFunil={camposDoFunilDaOrg} />;
}
