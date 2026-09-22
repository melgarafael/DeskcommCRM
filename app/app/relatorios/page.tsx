import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  curvaABC,
  vendasPorCliente,
  vendasPorProduto,
  vendasPorVendedor,
} from "@/lib/comercial/relatorios";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { RelatoriosClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * OS RELATÓRIOS COMERCIAIS (ATT.txt F5, sem B2B por decisão do dono).
 *
 * Por vendedor, por cliente, por produto + Curva ABC dos dois — tudo do dado
 * que existe (pedidos + itens). Margem, prazo médio e giro ficam de fora de
 * propósito: sem custo histórico, data de pagamento e movimentação, esses
 * números seriam inventados (ver lib/comercial/relatorios.ts).
 *
 * Sem entrada na sidebar (dobra 900px): chega-se pelos Pedidos e pelo ⌘K.
 * Exportação CSV que o Excel abre — sem dependência nova.
 */
export default async function RelatoriosPage({
  searchParams,
}: {
  searchParams: Promise<{ dias?: string }>;
}) {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const dias = Math.min(365, Math.max(7, Number((await searchParams).dias ?? 30) || 30));
  const agoraMs = new Date().getTime();
  const agora = new Date(agoraMs).toISOString();
  const inicio = new Date(agoraMs - dias * 86400000).toISOString();

  const supabase = await createClient();
  const { data: pedidos } = await supabase
    .from("commercial_orders")
    .select("id, total_cents, status, created_at, vendedor_user_id, contact_id, cliente_nome")
    .eq("organization_id", activeOrg.orgId)
    .gte("created_at", inicio)
    .order("created_at", { ascending: false })
    .limit(5000);

  const vendas = ((pedidos ?? []) as unknown as {
    id: string;
    total_cents: number;
    status: string;
    created_at: string;
    vendedor_user_id: string | null;
    contact_id: string | null;
    cliente_nome: string;
  }[]).map((p) => ({ ...p, origem: "" }));

  // Nomes dos vendedores (poucos por org; um lookup cada — mesmo custo da
  // listagem de inbox, ver 0202).
  const idsVendedores = [...new Set(vendas.map((v) => v.vendedor_user_id).filter(Boolean))] as string[];
  const nomes: Record<string, string> = {};
  if (idsVendedores.length > 0) {
    const admin = createAdminClient();
    await Promise.all(
      idsVendedores.slice(0, 50).map(async (id) => {
        const { data } = await admin.auth.admin.getUserById(id);
        const meta = data?.user?.user_metadata as { full_name?: string; name?: string } | undefined;
        nomes[id] = meta?.full_name ?? meta?.name ?? data?.user?.email ?? "Equipe";
      }),
    );
  }

  const ids = [...new Set(vendas.map((v) => v.id).filter(Boolean))];
  let itens: { produto_nome: string; quantidade: number; subtotal_cents: number }[] = [];
  if (ids.length > 0) {
    const { data: itensDb } = await supabase
      .from("commercial_order_items")
      .select("produto_nome, quantidade, subtotal_cents")
      .eq("organization_id", activeOrg.orgId)
      .in("order_id", ids.slice(0, 1000))
      .limit(10000);
    itens = (itensDb ?? []) as unknown as typeof itens;
  }

  const porVendedor = vendasPorVendedor(vendas, inicio, agora, nomes);
  const porCliente = vendasPorCliente(vendas, inicio, agora).slice(0, 20);
  const porProduto = vendasPorProduto(itens);

  return (
    <RelatoriosClient
      dias={dias}
      porVendedor={porVendedor}
      abcClientes={curvaABC(porCliente)}
      abcProdutos={curvaABC(porProduto)}
      textos={{
        titulo: t("Relatórios"),
        subtitulo: t("Vendas por vendedor, cliente e produto — com Curva ABC."),
        periodo: t("Período (dias)"),
        porVendedor: t("Por vendedor"),
        porCliente: t("Por cliente (top 20)"),
        porProduto: t("Por produto"),
        curvaAbc: t("Curva ABC"),
        classe: t("Classe"),
        qtd: t("Qtd"),
        total: t("Total"),
        ticket: t("Ticket"),
        exportar: t("Exportar CSV"),
        vazio: t("Sem vendas no período."),
      }}
    />
  );
}
