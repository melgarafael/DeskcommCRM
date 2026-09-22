import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DO_PRODUTO, type Produto } from "@/lib/schemas/produtos";
import { createClient } from "@/lib/supabase/server";

import { OrderEditor } from "./_editor";

export const dynamic = "force-dynamic";

/**
 * NOVO PEDIDO — editor de venda rápida (refatoração §2–3).
 *
 * O servidor entrega catálogo + contatos + tabelas + permissão de margem +
 * comissão; o editor monta o rascunho local (autosave) e a rota recalcula
 * tudo no Salvar/Finalizar (totais do cliente nunca entram).
 */
export default async function NovoPedidoPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const pode = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  if (!pode) redirect("/app/pedidos");
  const verMargem =
    user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const supabase = await createClient();
  const [{ data: produtos }, { data: contatos }, { data: tabelas }, { data: policies }] =
    await Promise.all([
      supabase
        .from("catalog_products")
        .select(COLUNAS_DO_PRODUTO)
        .eq("organization_id", activeOrg.orgId)
        .eq("ativo", true)
        .order("nome")
        .limit(500),
      supabase
        .from("contacts")
        .select("id, display_name, name, phone_number, email")
        .eq("organization_id", activeOrg.orgId)
        .eq("is_anonymized", false)
        .order("display_name")
        .limit(500),
      supabase
        .from("price_tables")
        .select("id, nome, desconto_pct")
        .eq("organization_id", activeOrg.orgId)
        .eq("ativo", true)
        .order("nome")
        .limit(100),
      supabase
        .from("commercial_policies")
        .select("comissao_padrao_pct")
        .eq("organization_id", activeOrg.orgId)
        .maybeSingle(),
    ]);

  return (
    <OrderEditor
      produtos={(produtos ?? []) as unknown as Produto[]}
      contatos={
        (contatos ?? []) as unknown as {
          id: string;
          display_name: string | null;
          name: string | null;
          phone_number: string | null;
          email: string | null;
        }[]
      }
      tabelas={
        (tabelas ?? []) as unknown as { id: string; nome: string; desconto_pct: number }[]
      }
      verMargem={verMargem}
      comissaoPct={
        (policies as unknown as { comissao_padrao_pct: number | null } | null)?.comissao_padrao_pct ?? null
      }
      textos={{
        titulo: t("Novo pedido"),
        subtitulo: t("Busque o cliente, adicione os produtos e finalize."),
        cliente: t("Cliente"),
        buscarCliente: t("Buscar cliente por nome, telefone ou e-mail…"),
        clienteAvulso: t("ou digite o nome para cliente avulso"),
        condicao: t("Condição de pagamento"),
        observacoes: t("Observações"),
        obsInterna: t("Observação interna (equipe)"),
        endereco: t("Endereço de entrega"),
        enderecoExemplo: t("Rua, número, bairro, cidade"),
        transportadora: t("Transportadora"),
        tabelaPreco: t("Tabela de preço"),
        semTabela: t("Preço base"),
        relacionados: t("Você também pode vender"),
        adicionar: t("Adicionar"),
        historico: t("Histórico do cliente"),
        rascunhoRestaurado: t("Rascunho anterior restaurado"),
        produtos: t("Produtos"),
        buscarProduto: t("Buscar produto, código ou EAN… (/ foca)"),
        subtotal: t("Subtotal"),
        desconto: t("Desconto"),
        frete: t("Frete"),
        total: t("Total"),
        margem: t("Margem"),
        comissao: t("Comissão estimada"),
        aguardandoAprovacao: t("Desconto acima do teto: vai para aprovação comercial."),
        salvarRascunho: t("Salvar rascunho"),
        finalizar: t("Finalizar pedido"),
        revisar: t("Revisar pedido"),
        pedidoCriado: t("Pedido criado"),
      }}
    />
  );
}
