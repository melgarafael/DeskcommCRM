import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DO_PRODUTO, type Produto } from "@/lib/schemas/produtos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function escaparCsv(texto: string | null | undefined): string {
  if (!texto) return "";
  const limpo = texto.replace(/\r\n|\r|\n/g, " ").replace(/"/g, '""');
  return `"${limpo}"`;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;

  const orgId = authz.org.orgId;
  const supabase = await createClient();

  const { data: produtos, error } = await supabase
    .from("catalog_products")
    .select(COLUNAS_DO_PRODUTO)
    .eq("organization_id", orgId)
    .eq("ativo", true)
    .order("nome");

  if (error) {
    return new Response("Erro ao ler catálogo para exportação", { status: 500 });
  }

  const cabecalho = "id,title,description,availability,condition,price,link,image_link,brand,gtin,google_product_category";
  const linhas: string[] = [cabecalho];

  for (const p of (produtos ?? []) as unknown as Produto[]) {
    const id = p.codigo;
    const title = p.nome;
    const description = p.descricao || p.nome;
    const availability = p.controla_estoque && p.quantidade <= 0 ? "out of stock" : "in stock";
    const condition = p.condicao || "new";
    const precoFormatado = `${(p.preco_cents / 100).toFixed(2)} ${p.moeda || "BRL"}`;
    const link = p.link_loja || "";
    const imageLink = p.imagem_url || "";
    const brand = p.marca || "";
    const gtin = p.gtin || "";
    const category = p.categoria || "";

    linhas.push(
      [
        escaparCsv(id),
        escaparCsv(title),
        escaparCsv(description),
        escaparCsv(availability),
        escaparCsv(condition),
        escaparCsv(precoFormatado),
        escaparCsv(link),
        escaparCsv(imageLink),
        escaparCsv(brand),
        escaparCsv(gtin),
        escaparCsv(category),
      ].join(","),
    );
  }

  const csv = `\uFEFF${linhas.join("\n")}\n`;

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="catalogo-meta-commerce.csv"',
      "x-request-id": requestId,
    },
  });
}
