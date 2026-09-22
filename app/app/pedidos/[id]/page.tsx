import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { enderecoEmLinha } from "@/lib/contacts/endereco-em-linha";
import { COLUNAS_DO_ITEM, COLUNAS_DO_PEDIDO, type ItemDoPedido, type PedidoComercial } from "@/lib/schemas/pedidos";

import { DetalheDoPedido, type ContatoDoPedido } from "./_detalhe";

export const dynamic = "force-dynamic";

/**
 * O DETALHE DO PEDIDO — a ficha inteira no app, sem PDF.
 *
 * Espelha a tela de detalhe do Mercos (medida em 2026-09-06): cabeçalho com
 * número + pill, ações, bloco CLIENTE, bloco da organização (a "representada"
 * deles), grade de PRODUTOS com totais e bloco DETALHES. Tudo que a tela
 * mostra vem de `commercial_orders` + `commercial_order_items` + `contacts`;
 * o que não existe no nosso modelo (e-mail de envio, portal do cliente, IA
 * que resume perfil) vira link honesto (mailto, copiar URL) em vez de botão
 * que finge fazer.
 */
export default async function DetalhePedidoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const { id } = await params;

  const supabase = await createClient();
  const { data: pedido } = await supabase
    .from("commercial_orders")
    .select(COLUNAS_DO_PEDIDO)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();
  if (!pedido) redirect("/app/pedidos");

  const [{ data: itens }, { data: contato }, { data: org }] = await Promise.all([
    supabase
      .from("commercial_order_items")
      .select(COLUNAS_DO_ITEM)
      .eq("order_id", id)
      .eq("organization_id", activeOrg.orgId)
      .order("posicao"),
    (pedido as unknown as PedidoComercial).contact_id
      ? supabase
          .from("contacts")
          .select("id, name, display_name, phone_number, email, cnpj, source_metadata, logradouro, numero_end, complemento, bairro, cidade, uf, cep")
          .eq("id", (pedido as unknown as PedidoComercial).contact_id as string)
          .eq("organization_id", activeOrg.orgId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("organizations").select("display_name").eq("id", activeOrg.orgId).maybeSingle(),
  ]);

  // Nome do vendedor: auth metadata via admin, mesmo molde do dashboard. Sem
  // service role, a tela mostra o id curto — nunca vazio, nunca quebra.
  let nomeVendedor: string | null = null;
  const vendedorId = (pedido as unknown as PedidoComercial).vendedor_user_id;
  if (vendedorId && isServiceRoleConfigured()) {
    try {
      const admin = createAdminClient();
      const { data: userRes } = await admin.auth.admin.getUserById(vendedorId);
      const nome = userRes?.user?.user_metadata?.full_name as string | undefined;
      if (nome?.trim()) nomeVendedor = nome.trim();
    } catch {
      // Cortesia; o id curto abaixo cobre.
    }
  }

  const c = contato as unknown as {
    id: string;
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
    email: string | null;
    cnpj: string | null;
    source_metadata: { mercos?: { cidade?: string; uf?: string } } | null;
    logradouro: string | null;
    numero_end: string | null;
    complemento: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
    cep: string | null;
  } | null;
  const contatoFinal: ContatoDoPedido | null = c
    ? {
        id: c.id,
        nome: c.display_name ?? c.name ?? "",
        documento: c.cnpj,
        fone: c.phone_number,
        email: c.email,
        cidade: c.cidade ?? c.source_metadata?.mercos?.cidade ?? null,
        uf: c.uf ?? c.source_metadata?.mercos?.uf ?? null,
        endereco: enderecoEmLinha(c) || null,
      }
    : null;

  return (
    <DetalheDoPedido
      pedido={pedido as unknown as PedidoComercial}
      itens={(itens ?? []) as unknown as ItemDoPedido[]}
      contato={contatoFinal}
      nomeVendedor={nomeVendedor}
      nomeOrganizacao={(org as unknown as { display_name?: string } | null)?.display_name ?? ""}
      podeEditar={user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent}
      podeExcluir={user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager}
    />
  );
}
