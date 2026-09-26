import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { loadOnboardingState } from "@/app/actions/onboarding/_shared";
import { resumoDoOnboarding } from "@/lib/onboarding/passos";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { oQueMaisExiste } from "@/lib/onboarding/o-que-mais-existe";
import { DoneClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function DonePage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");

  const { state } = await loadOnboardingState(activeOrg.orgId);

  // O resumo sai da MESMA fonte que decidiu a ordem e desenhou o indicador.
  // Antes era uma terceira lista, fixa, e por isso ela listava "Loja Nuvemshop
  // (pulado)" em instalações que nunca ofereceram esse passo — o wizard
  // acusando a pessoa de não fazer o que ninguém lhe pediu.
  const itens = resumoDoOnboarding(state, { lojaLigada: env.NUVEMSHOP_ENABLED });

  const supabase = await createClient();
  // SE O ATENDENTE ESTÁ NO AR vem do banco, não das pendências: publicar é o
  // que coloca o agente de pé, e a tela antiga inferia isso (mal) só de
  // "ficou algo por fazer" — daí "Seu funcionário já está de pé" dito para quem
  // pulou a IA e para quem ficou com o rascunho.
  const { data: publicados } = await supabase
    .from("ai_agents")
    .select("id")
    .eq("organization_id", activeOrg.orgId)
    .is("archived_at", null)
    .not("published_version_id", "is", null)
    .limit(1);
  const noAr = (publicados ?? []).length > 0;

  return <DoneClient itens={itens} pecas={oQueMaisExiste()} noAr={noAr} />;
}
