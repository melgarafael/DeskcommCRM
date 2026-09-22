import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DO_PEDIDO, STATUS_DO_PEDIDO, type PedidoComercial } from "@/lib/schemas/pedidos";
import { createClient } from "@/lib/supabase/server";

import { PedidosClient, type FiltrosIniciais } from "./_client";

export const dynamic = "force-dynamic";

/**
 * OS PEDIDOS DA LOJA — o coração comercial (ATT.txt Fase 2).
 *
 * Lista com filtros por status/origem e badges de origem (IA, vendedor,
 * WhatsApp, B2B). Criar e mudar pedido é `agent` para cima: viewer vê, não
 * mexe — e a rota cobra de novo, a tela esconder o botão é cortesia.
 *
 * Aceita filtros iniciais via URL (drill-down do dashboard): ?status=,
 * ?origem=, ?vendedor= (user_id), ?de= e ?ate= (ISO). Valores inválidos são
 * ignorados, nunca 422 — link externo não pode quebrar a lista.
 */
export default async function PedidosPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; origem?: string; vendedor?: string; de?: string; ate?: string }>;
}) {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const params = await searchParams;

  const podeCriar = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const podeExcluir = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const DIA = /^\d{4}-\d{2}-\d{2}$/;
  const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const dataValida = (v: string | undefined) => (v && (DIA.test(v) || INSTANTE.test(v)) ? v : "");

  const iniciais: FiltrosIniciais = {
    status: (STATUS_DO_PEDIDO as readonly string[]).includes(params.status ?? "") ? (params.status as string) : "",
    origem: params.origem?.trim() ?? "",
    vendedor: params.vendedor?.trim() ?? "",
    de: dataValida(params.de),
    ate: dataValida(params.ate),
  };

  const supabase = await createClient();
  let q = supabase
    .from("commercial_orders")
    .select(COLUNAS_DO_PEDIDO)
    .eq("organization_id", activeOrg.orgId);
  if (iniciais.status) q = q.eq("status", iniciais.status);
  if (iniciais.origem) q = q.eq("origem", iniciais.origem);
  if (iniciais.vendedor) q = q.eq("vendedor_user_id", iniciais.vendedor);
  if (iniciais.de) q = q.gte("created_at", DIA.test(iniciais.de) ? `${iniciais.de}T00:00:00Z` : iniciais.de);
  if (iniciais.ate) q = q.lt("created_at", DIA.test(iniciais.ate) ? `${iniciais.ate}T23:59:59.999Z` : iniciais.ate);
  const { data } = await q.order("created_at", { ascending: false }).limit(200);

  return (
    <PedidosClient
      inicial={(data ?? []) as unknown as PedidoComercial[]}
      iniciais={iniciais}
      podeCriar={podeCriar}
      podeExcluir={podeExcluir}
      meuId={user.id}
      textos={{
        titulo: t("Pedidos"),
        subtitulo: t("Os pedidos da loja, do rascunho à entrega."),
        vazio: t("Nenhum pedido ainda"),
        vazioDica: t("Crie o primeiro pedido no botão acima — ele pode nascer daqui, do WhatsApp, da IA ou do portal B2B."),
        novo: t("Novo pedido"),
        relatorios: t("Relatórios"),
        todosStatus: t("Todos os status"),
        todasOrigens: t("Todas as origens"),
        verPdf: t("Ver"),
        baixarPdf: t("Baixar"),
        buscar: t("Buscar"),
        condicao: t("Pagamento"),
        valorMin: t("Valor mín (R$)"),
        valorMax: t("Valor máx (R$)"),
        meus: t("Só meus pedidos"),
        salvarFiltro: t("Salvar filtro"),
        nomeFiltro: t("Nome do filtro…"),
        statusLabel: t("Status"),
        avancados: t("Filtros avançados"),
        limpar: t("Limpar filtros"),
        salvos: t("Filtros salvos"),
        excluir: t("Excluir"),
        tabela: t("Tabela"),
        quadro: t("Quadro"),
        cartoes: t("Cartões"),
        selecionarTodos: t("Selecionar todos"),
        avancarSelecionados: t("Avançar"),
        aprovarSelecionados: t("Aprovar"),
        cancelarSelecionados: t("Cancelar"),
        excluirSelecionados: t("Excluir"),
        exportar: t("Exportar CSV"),
        imprimirSelecionados: t("Imprimir"),
        duplicar: t("Duplicar"),
        historico: t("Histórico"),
        avancar: t("Avançar"),
        cancelar: t("Cancelar"),
        verDetalhe: t("Detalhe"),
      }}
    />
  );
}
