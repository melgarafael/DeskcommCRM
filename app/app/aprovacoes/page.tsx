import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

import { AprovacoesClient, type AprovacaoDaTela } from "./_components/AprovacoesClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Aprovações" };

/**
 * APROVAÇÕES — o que a agência mandou para a empresa aprovar
 * (docs/agencia/SPEC-aprovacoes.md). Leitura pelo servidor, filtrada À MÃO pela
 * organização ativa (o client é o de serviço). Responder é `agent` ou acima; o
 * viewer só vê — e a action cobra de novo.
 */
export default async function AprovacoesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const { data } = await createAdminClient()
    .from("agencia_aprovacoes")
    .select("id, tipo, titulo, descricao, link, versao, situacao, comentario, pedido_em, respondido_em")
    .eq("organization_id", activeOrg.orgId)
    .neq("situacao", "cancelado")
    .order("pedido_em", { ascending: false })
    .limit(200);

  const podeResponder = !user.support && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  // Datas no fuso da EMPRESA: sem ele, a hora montada no servidor (UTC) diverge da do navegador.
  return (
    <AprovacoesClient
      aprovacoes={(data ?? []) as AprovacaoDaTela[]}
      podeResponder={podeResponder}
      fuso={activeOrg.timezone || "America/Sao_Paulo"}
    />
  );
}
