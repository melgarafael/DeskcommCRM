/**
 * POST /api/v1/invoices/validar {order_id} — pré-validação fiscal SEM emitir.
 *
 * Devolve a lista de pendências (cliente, produtos, emitente) com para onde
 * ir corrigir. A UI mostra antes do "Emitir" para a SEFAZ nunca ser a
 * primeira a dizer que falta NCM.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { carregarContextoSped, montarPayloadSped } from "@/lib/fiscal/sped-payload";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({ order_id: z.string().uuid() });

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "invoices" });
  if (!authz.ok) return authz.response;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Dados inválidos.", 422, { requestId });

  const supabase = await createClient();
  const { data: pedido } = await supabase
    .from("commercial_orders")
    .select("id, numero, cliente_nome, cliente_documento, total_cents, frete_cents, status, contact_id")
    .eq("id", parsed.data.order_id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const ped = pedido as unknown as {
    id: string;
    numero: number;
    cliente_nome: string;
    cliente_documento: string | null;
    total_cents: number;
    frete_cents: number;
    status: string;
    contact_id: string | null;
  } | null;
  if (!ped) return fail("not_found", "Pedido não encontrado.", 404, { requestId });
  if (ped.status !== "faturado") {
    return ok({ ok: false, pendencias: [{ campo: "status", mensagem: `Pedido está "${ped.status}" — só faturado vira nota.`, onde: `/app/pedidos/${ped.id}` }] }, { requestId });
  }

  const pendencias: { campo: string; mensagem: string; onde: string }[] = [];
  if (ped.contact_id) {
    const { data: contato } = await supabase
      .from("contacts")
      .select("logradouro, numero_end, bairro, cidade, uf, cep")
      .eq("id", ped.contact_id)
      .maybeSingle();
    const c = (contato ?? {}) as Record<string, string | null>;
    for (const [campo, rotulo] of [["logradouro", "endereço"], ["numero_end", "número"], ["bairro", "bairro"], ["cidade", "município"], ["uf", "UF"], ["cep", "CEP"]] as const) {
      if (!c[campo]) {
        pendencias.push({ campo: `cliente.${campo}`, mensagem: `Cliente sem ${rotulo}`, onde: `/app/contacts/${ped.contact_id}` });
      }
    }
  }

  const ctx = await carregarContextoSped(authz.org.orgId);
  if (!ctx) {
    return ok({ ok: false, pendencias: [{ campo: "emitente", mensagem: "Configuração fiscal incompleta.", onde: "/app/notas" }] }, { requestId });
  }
  const { data: itensDb } = await supabase
    .from("commercial_order_items")
    .select("produto_codigo, produto_nome, quantidade, preco_unit_cents, desconto_pct, product_id")
    .eq("order_id", ped.id)
    .eq("organization_id", authz.org.orgId)
    .order("posicao");
  const idsProd = ((itensDb ?? []) as unknown as { product_id: string | null }[]).map((i) => i.product_id).filter(Boolean) as string[];
  const fiscais: Record<string, { ncm: string | null; cfop: string | null; unidade: string | null }> = {};
  if (idsProd.length > 0) {
    const { data: prods } = await supabase
      .from("catalog_products")
      .select("id, ncm, cfop, unidade")
      .eq("organization_id", authz.org.orgId)
      .in("id", idsProd);
    for (const p of ((prods ?? []) as unknown as { id: string; ncm: string | null; cfop: string | null; unidade: string | null }[])) {
      fiscais[p.id] = p;
    }
  }
  const em = ctx.emitente as unknown as Record<string, string | null>;
  const montado = montarPayloadSped(
    {
      serie: "",
      natureza_operacao: (em.natureza_operacao as string) ?? "",
      cfop_padrao: (em.cfop_padrao as string) ?? "",
      emitente_documento: em.emitente_documento ?? null,
      ie: em.ie ?? null,
      crt: (em.crt as string) ?? "1",
      logradouro: em.logradouro ?? null,
      numero_end: em.numero_end ?? null,
      bairro: em.bairro ?? null,
      municipio: em.municipio ?? null,
      codigo_municipio: em.codigo_municipio ?? null,
      uf: em.uf ?? null,
      cep: em.cep ?? null,
      ambiente: (em.ambiente as string) ?? "homologacao",
      certificado_path: em.certificado_path ?? null,
    },
    ctx.senhaCertificado ?? "",
    { numero: ped.numero, nome: ped.cliente_nome, documento: ped.cliente_documento, frete_cents: ped.frete_cents },
    ((itensDb ?? []) as unknown as {
      produto_codigo: string;
      produto_nome: string;
      quantidade: number;
      preco_unit_cents: number;
      desconto_pct: number;
      product_id: string | null;
    }[]).map((i) => ({
      codigo: i.produto_codigo,
      descricao: i.produto_nome,
      ncm: i.product_id ? (fiscais[i.product_id]?.ncm ?? null) : null,
      cfop: i.product_id ? (fiscais[i.product_id]?.cfop ?? null) : null,
      unidade: i.product_id ? (fiscais[i.product_id]?.unidade ?? null) : null,
      quantidade: i.quantidade,
      preco_cents: i.preco_unit_cents,
      desconto_pct: Number(i.desconto_pct),
    })),
  );
  if (!montado.ok) {
    pendencias.push({ campo: "fiscal", mensagem: montado.falta, onde: "/app/notas" });
  }
  return ok({ ok: pendencias.length === 0, pendencias }, { requestId });
}
