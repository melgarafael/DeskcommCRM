import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { linksDeLeitura } from "@/lib/agencia/envios/armazenamento";
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
    .select("id, tipo, titulo, descricao, link, texto, arquivo_caminho, arquivo_mime, arquivo_apagado_em, versao, situacao, comentario, pedido_em, respondido_em")
    .eq("organization_id", activeOrg.orgId)
    .neq("situacao", "cancelado")
    .order("pedido_em", { ascending: false })
    .limit(200);

  // SPEC-envios, E4: o arquivo abre aqui dentro, por link assinado de 3 h, gerado a cada abertura.
  type Linha = Omit<AprovacaoDaTela, "material"> & { link: string | null; texto: string | null; arquivo_caminho: string | null; arquivo_mime: string | null; arquivo_apagado_em: string | null };
  const linhas = (data ?? []) as Linha[];
  const links = await linksDeLeitura(linhas.filter((l) => l.arquivo_caminho && !l.arquivo_apagado_em).map((l) => l.arquivo_caminho!));
  const aprovacoes: AprovacaoDaTela[] = linhas.map(({ link, texto, arquivo_caminho, arquivo_mime, arquivo_apagado_em, ...resto }) => ({
    ...resto,
    material: {
      texto,
      link,
      mime: arquivo_mime,
      url: arquivo_caminho && !arquivo_apagado_em ? (links.get(arquivo_caminho) ?? null) : null,
      apagado: !!arquivo_apagado_em,
    },
  }));

  const podeResponder = !user.support && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  // Datas no fuso da EMPRESA: sem ele, a hora montada no servidor (UTC) diverge da do navegador.
  return (
    <AprovacoesClient
      aprovacoes={aprovacoes}
      podeResponder={podeResponder}
      fuso={activeOrg.timezone || "America/Sao_Paulo"}
    />
  );
}
