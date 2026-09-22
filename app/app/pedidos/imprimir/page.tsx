import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { enderecoEmLinha } from "@/lib/contacts/endereco-em-linha";
import { createClient } from "@/lib/supabase/server";
import { COLUNAS_DO_ITEM, COLUNAS_DO_PEDIDO, type ItemDoPedido, type PedidoComercial } from "@/lib/schemas/pedidos";

import { ImprimirLoteClient, type ClienteImpresso, type ItemImpresso } from "./_imprimir";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAXIMO = 50;

/**
 * IMPRESSÃO EM LOTE — os pedidos selecionados na lista, um após o outro,
 * prontos para Ctrl+P. Sem sidebar de propósito (doutrina da dobra): a porta
 * é o botão Imprimir da barra de massa, que passa os ids na URL.
 */
export default async function ImprimirLotePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const params = await searchParams;

  const ids = (params.ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID.test(s))
    .slice(0, MAXIMO);

  const supabase = await createClient();
  const [{ data: org }, { data: pedidosRaw }, { data: itensRaw }] = await Promise.all([
    supabase.from("organizations").select("display_name").eq("id", activeOrg.orgId).maybeSingle(),
    ids.length > 0
      ? supabase.from("commercial_orders").select(COLUNAS_DO_PEDIDO).eq("organization_id", activeOrg.orgId).in("id", ids)
      : Promise.resolve({ data: [] }),
    ids.length > 0
      ? supabase
          .from("commercial_order_items")
          .select(`order_id, ${COLUNAS_DO_ITEM}`)
          .eq("organization_id", activeOrg.orgId)
          .in("order_id", ids)
          .order("posicao")
      : Promise.resolve({ data: [] }),
  ]);

  const porPedido = new Map<string, ItemDoPedido[]>();
  for (const it of ((itensRaw ?? []) as unknown as (ItemDoPedido & { order_id: string })[])) {
    const lista = porPedido.get(it.order_id) ?? [];
    lista.push(it);
    porPedido.set(it.order_id, lista);
  }
  const listaPedidos = (pedidosRaw ?? []) as unknown as PedidoComercial[];

  // Bloco do cliente (um select para o lote) + unidade dos itens (idem).
  const idsContatos = [...new Set(listaPedidos.map((p) => p.contact_id).filter(Boolean))] as string[];
  const idsProdutos = [
    ...new Set(
      [...porPedido.values()].flat().map((i) => i.product_id).filter(Boolean),
    ),
  ] as string[];
  const [{ data: contatosRaw }, { data: prodsRaw }] = await Promise.all([
    idsContatos.length > 0
      ? supabase
          .from("contacts")
          .select("id, display_name, name, tipo_pessoa, fantasia, ie, cnpj, phone_number, email, logradouro, numero_end, complemento, bairro, cidade, uf, cep")
          .eq("organization_id", activeOrg.orgId)
          .in("id", idsContatos)
      : Promise.resolve({ data: [] }),
    idsProdutos.length > 0
      ? supabase
          .from("catalog_products")
          .select("id, unidade")
          .eq("organization_id", activeOrg.orgId)
          .in("id", idsProdutos)
      : Promise.resolve({ data: [] }),
  ]);
  const porContato = new Map(
    ((contatosRaw ?? []) as unknown as Record<string, string | null>[]).map((c) => [c.id as string, c]),
  );
  const unidadePorProduto = new Map(
    ((prodsRaw ?? []) as { id: string; unidade: string | null }[]).map((pr) => [pr.id, pr.unidade ?? "UN"]),
  );

  function clienteDe(p: PedidoComercial): ClienteImpresso {
    const c = p.contact_id ? porContato.get(p.contact_id) : undefined;
    if (!c) {
      return {
        nome: p.cliente_nome,
        fantasia: null,
        rotuloDocumento: (p.cliente_documento ?? "").replace(/\D/g, "").length === 11 ? "CPF" : "CNPJ",
        documento: p.cliente_documento,
        ie: null,
        endereco: p.endereco_entrega,
        bairro: null,
        cep: null,
        cidade: null,
        uf: null,
        fone: null,
        email: null,
      };
    }
    const s = (k: string) => (c[k] as string | null) ?? null;
    return {
      nome: s("display_name") ?? s("name") ?? p.cliente_nome,
      fantasia: s("fantasia"),
      rotuloDocumento: s("tipo_pessoa") === "F" ? "CPF" : "CNPJ",
      documento: s("cnpj") ?? p.cliente_documento,
      ie: s("ie"),
      endereco:
        enderecoEmLinha({
          logradouro: s("logradouro"),
          numero_end: s("numero_end"),
          complemento: s("complemento"),
          bairro: s("bairro"),
          cidade: s("cidade"),
          uf: s("uf"),
          cep: s("cep"),
        }) || p.endereco_entrega,
      bairro: s("bairro"),
      cep: s("cep"),
      cidade: s("cidade"),
      uf: s("uf"),
      fone: s("phone_number"),
      email: s("email"),
    };
  }

  const pedidos = listaPedidos.map((p) => ({
    pedido: p,
    cliente: clienteDe(p),
    itens: (porPedido.get(p.id) ?? []).map(
      (it): ItemImpresso => ({ ...it, unidade: (it.product_id && unidadePorProduto.get(it.product_id)) || "UN" }),
    ),
  }));
  // Mesma ordem da seleção.
  pedidos.sort((a, b) => ids.indexOf(a.pedido.id) - ids.indexOf(b.pedido.id));

  return (
    <ImprimirLoteClient
      nomeOrganizacao={(org as unknown as { display_name?: string } | null)?.display_name ?? ""}
      pedidos={pedidos}
    />
  );
}
