/**
 * GET /api/v1/commercial-orders/[id]/pdf — o pedido em PDF.
 *
 * `?destino=ver` (padrão) abre no navegador; `?destino=baixar` força download.
 * Render server-side via @react-pdf/renderer (mesmo molde do PDF de LGPD).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { enderecoEmLinha } from "@/lib/contacts/endereco-em-linha";
import { COLUNAS_DO_ITEM, COLUNAS_DO_PEDIDO } from "@/lib/schemas/pedidos";
import {
  numeroDoPedidoPdf,
  renderPedidoPdf,
  type PedidoPdfCliente,
  type PedidoPdfDados,
} from "@/lib/comercial/pedido-pdf";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const destino = req.nextUrl.searchParams.get("destino") === "baixar" ? "baixar" : "ver";
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: pedido }, { data: org }] = await Promise.all([
    supabase
      .from("commercial_orders")
      .select(COLUNAS_DO_PEDIDO)
      .eq("id", id)
      .eq("organization_id", authz.org.orgId)
      .single(),
    supabase
      .from("organizations")
      .select("display_name, legal_name, cnpj")
      .eq("id", authz.org.orgId)
      .single(),
  ]);

  if (!pedido) return fail("not_found", "Pedido não encontrado.", 404, { requestId });

  const p = pedido as unknown as Omit<PedidoPdfDados, "itens" | "cliente" | "vendedor_nome"> & {
    contact_id: string | null;
    cliente_nome: string;
    cliente_documento: string | null;
    vendedor_user_id: string | null;
    endereco_entrega: string | null;
  };

  const { data: itens } = await supabase
    .from("commercial_order_items")
    .select(COLUNAS_DO_ITEM)
    .eq("order_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("posicao");
  const listaItens = ((itens ?? []) as unknown as PedidoPdfDados["itens"]).map((i) => ({ ...i }));

  // Unidade do item: segue o cadastro do produto (padrão UN). Uma busca só
  // para o pedido inteiro — nunca N consultas.
  const idsProdutos = [...new Set(listaItens.map((i) => (i as { product_id?: string | null }).product_id).filter(Boolean))];
  let unidadePorProduto = new Map<string, string>();
  if (idsProdutos.length > 0) {
    const { data: prods } = await supabase
      .from("catalog_products")
      .select("id, unidade")
      .eq("organization_id", authz.org.orgId)
      .in("id", idsProdutos as string[]);
    unidadePorProduto = new Map(
      ((prods ?? []) as { id: string; unidade: string | null }[]).map((pr) => [pr.id, pr.unidade ?? "UN"]),
    );
  }
  for (const i of listaItens) {
    const pid = (i as { product_id?: string | null }).product_id;
    i.unidade = (pid && unidadePorProduto.get(pid)) || "UN";
  }

  // Bloco do cliente: os mesmos campos da impressão do Mercos. Sem vínculo,
  // o impresso usa o snapshot do pedido (nome/documento) — nunca vazio.
  let cliente: PedidoPdfCliente = {
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
  if (p.contact_id) {
    const { data: c } = await supabase
      .from("contacts")
      .select("display_name, name, tipo_pessoa, fantasia, ie, cnpj, phone_number, email, logradouro, numero_end, complemento, bairro, cidade, uf, cep")
      .eq("id", p.contact_id)
      .eq("organization_id", authz.org.orgId)
      .maybeSingle();
    const contato = c as unknown as {
      display_name: string | null;
      name: string | null;
      tipo_pessoa: string | null;
      fantasia: string | null;
      ie: string | null;
      cnpj: string | null;
      phone_number: string | null;
      email: string | null;
      logradouro: string | null;
      numero_end: string | null;
      complemento: string | null;
      bairro: string | null;
      cidade: string | null;
      uf: string | null;
      cep: string | null;
    } | null;
    if (contato) {
      const doc = contato.cnpj ?? p.cliente_documento;
      cliente = {
        nome: contato.display_name ?? contato.name ?? p.cliente_nome,
        fantasia: contato.fantasia,
        rotuloDocumento: contato.tipo_pessoa === "F" ? "CPF" : "CNPJ",
        documento: doc,
        ie: contato.ie,
        endereco: enderecoEmLinha(contato) || p.endereco_entrega,
        bairro: contato.bairro,
        cep: contato.cep,
        cidade: contato.cidade,
        uf: contato.uf,
        fone: contato.phone_number,
        email: contato.email,
      };
    }
  }

  // Nome do vendedor: auth metadata via admin, mesmo molde do detalhe. Sem
  // service role, a representada sai sem a pessoa — nunca quebra.
  let vendedorNome: string | null = null;
  if (p.vendedor_user_id && isServiceRoleConfigured()) {
    try {
      const admin = createAdminClient();
      const { data: userRes } = await admin.auth.admin.getUserById(p.vendedor_user_id);
      const nome = userRes?.user?.user_metadata?.full_name as string | undefined;
      if (nome?.trim()) vendedorNome = nome.trim();
    } catch {
      // Cortesia; a representada sem pessoa cobre.
    }
  }

  const o = (org ?? {}) as unknown as {
    display_name: string | null;
    legal_name: string | null;
    cnpj: string | null;
  };

  const buf = await renderPedidoPdf(
    { nome: o.legal_name ?? o.display_name ?? "Empresa", documento: o.cnpj },
    {
      ...p,
      cliente,
      vendedor_nome: vendedorNome,
      itens: listaItens,
    },
  );

  const nome = `${numeroDoPedidoPdf(p.numero)}.pdf`;
  // Nome ASCII no header: acento em filename quebra download em alguns
  // navegadores — o título dentro do PDF leva o nome real.
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${destino === "baixar" ? "attachment" : "inline"}; filename="${nome}"`,
      "X-Request-Id": requestId,
    },
  });
}
