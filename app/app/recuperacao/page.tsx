import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import { RecuperacaoClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * A RECUPERAÇÃO — quem comprava e parou (ATT.txt Fase 4).
 *
 * Sem entrada na sidebar (dobra 900px): chega-se pelo alerta do Dashboard e
 * pelo ⌘K. A lista vem da API de inativos; cada linha tem ação direta
 * (WhatsApp com mensagem pronta, ficha, novo pedido).
 */
export default async function RecuperacaoPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  // O seletor de período nasce em 60 dias; a API valida o resto.
  const supabase = await createClient();
  const agoraMs = new Date().getTime();
  const corte = new Date(agoraMs - 60 * 86400000).toISOString();
  const { count } = await supabase
    .from("commercial_orders")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", activeOrg.orgId)
    .neq("status", "cancelado")
    .lt("created_at", corte);

  return (
    <RecuperacaoClient
      temBase={(count ?? 0) > 0}
      textos={{
        titulo: t("Recuperação de clientes"),
        subtitulo: t("Quem comprava e parou — por ordem de prioridade."),
        periodo: t("Sem compra há ao menos (dias)"),
        aplicar: t("Aplicar"),
        vazio: t("Ninguém inativo neste período. Boas vendas!"),
        semBase: t("Ainda não há pedidos antigos para medir inatividade."),
        chamar: t("Chamar no WhatsApp"),
        ficha: t("Ficha"),
        novoPedido: t("Novo pedido"),
        ultimaCompra: t("Última compra há"),
        dias: t("dias"),
        totalHistorico: t("Total histórico"),
        pedidos: t("pedidos"),
      }}
    />
  );
}
