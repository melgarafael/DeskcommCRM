/**
 * GET /api/v1/sped/arquivo?ano=2026&mes=8 — Gera Arquivo (rascunho p/ o PVA).
 *
 * Junta notas AUTORIZADAS do mês + itens do pedido (NCM/CFOP/unidade do
 * produto) e devolve o texto da EFD ICMS/IPI (blocos 0, C e 9) com os
 * contadores fechados. É RASCUNHO: CST/CSOSN, bases e apuração saem zerados
 * e a resposta lista as pendências — o contador completa no PVA antes de
 * transmitir. Sem nota autorizada no mês, devolve os blocos vazios.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { gerarEfd, type ItemEfd, type NotaEfd } from "@/lib/fiscal/sped-arquivo";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "sped-arquivo" });
  if (!authz.ok) return authz.response;

  const agora = new Date();
  const ano = Number(req.nextUrl.searchParams.get("ano") ?? agora.getUTCFullYear());
  const mes = Number(req.nextUrl.searchParams.get("mes") ?? agora.getUTCMonth() + 1);
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100 || !Number.isInteger(mes) || mes < 1 || mes > 12) {
    return fail("validation_failed", "Período inválido.", 422, { requestId });
  }

  const supabase = await createClient();
  const inicio = new Date(Date.UTC(ano, mes - 1, 1)).toISOString();
  const fim = new Date(Date.UTC(ano, mes, 1)).toISOString();

  const [{ data: config }, { data: equivs }, { data: notasDb }] = await Promise.all([
    supabase
      .from("fiscal_settings")
      .select("serie, natureza_operacao, cfop_padrao, emitente_documento, ie, crt, municipio, codigo_municipio, uf, ambiente")
      .eq("organization_id", authz.org.orgId)
      .maybeSingle(),
    supabase
      .from("fiscal_cfop_equivalentes")
      .select("cfop_origem, cfop_destino")
      .eq("organization_id", authz.org.orgId),
    supabase
      .from("invoices")
      .select("id, order_id, serie, numero, chave_acesso, total_cents, created_at")
      .eq("organization_id", authz.org.orgId)
      .eq("status", "autorizada")
      .gte("created_at", inicio)
      .lt("created_at", fim)
      .order("numero", { ascending: true })
      .limit(500),
  ]);

  const cfg = config as unknown as {
    natureza_operacao: string;
    cfop_padrao: string;
    emitente_documento: string | null;
    ie: string | null;
    crt: string;
    codigo_municipio: string | null;
    uf: string | null;
    ambiente: string;
  } | null;
  if (!cfg?.emitente_documento || !cfg?.ie || !cfg?.uf || !cfg?.codigo_municipio) {
    return fail("validation_failed", "Configuração fiscal incompleta para o SPED (CNPJ, IE, UF e IBGE).", 422, { requestId });
  }

  const equivalentes: Record<string, string> = Object.fromEntries(
    ((equivs ?? []) as unknown as { cfop_origem: string; cfop_destino: string }[]).map((e) => [e.cfop_origem, e.cfop_destino]),
  );

  const notas = ((notasDb ?? []) as unknown as {
    id: string;
    order_id: string | null;
    serie: string;
    numero: number | null;
    chave_acesso: string | null;
    total_cents: number;
    created_at: string;
  }[]).filter((n) => n.numero !== null && n.chave_acesso);

  const idsPedidos = [...new Set(notas.map((n) => n.order_id).filter((v): v is string => !!v))];
  let pedidos: Record<string, { cliente_nome: string; cliente_documento: string | null; frete_cents: number }> = {};
  const itensPorPedido: Record<string, {
    produto_codigo: string;
    produto_nome: string;
    quantidade: number;
    preco_unit_cents: number;
    desconto_pct: number;
    product_id: string | null;
  }[]> = {};
  if (idsPedidos.length > 0) {
    const [{ data: peds }, { data: itensDb }] = await Promise.all([
      supabase
        .from("commercial_orders")
        .select("id, cliente_nome, cliente_documento, frete_cents")
        .eq("organization_id", authz.org.orgId)
        .in("id", idsPedidos),
      supabase
        .from("commercial_order_items")
        .select("order_id, produto_codigo, produto_nome, quantidade, preco_unit_cents, desconto_pct, product_id")
        .eq("organization_id", authz.org.orgId)
        .in("order_id", idsPedidos)
        .order("posicao"),
    ]);
    pedidos = Object.fromEntries(
      ((peds ?? []) as unknown as { id: string; cliente_nome: string; cliente_documento: string | null; frete_cents: number }[]).map((p) => [
        p.id,
        { cliente_nome: p.cliente_nome, cliente_documento: p.cliente_documento, frete_cents: p.frete_cents },
      ]),
    );
    for (const it of (itensDb ?? []) as unknown as {
      order_id: string;
      produto_codigo: string;
      produto_nome: string;
      quantidade: number;
      preco_unit_cents: number;
      desconto_pct: number;
      product_id: string | null;
    }[]) {
      (itensPorPedido[it.order_id] ??= []).push(it);
    }
  }

  const idsProd = [
    ...new Set(
      Object.values(itensPorPedido)
        .flat()
        .map((i) => i.product_id)
        .filter((v): v is string => !!v),
    ),
  ];
  let fiscais: Record<string, { ncm: string | null; cfop: string | null; unidade: string | null }> = {};
  if (idsProd.length > 0) {
    const { data: prods } = await supabase
      .from("catalog_products")
      .select("id, ncm, cfop, unidade")
      .eq("organization_id", authz.org.orgId)
      .in("id", idsProd);
    fiscais = Object.fromEntries(
      ((prods ?? []) as unknown as { id: string; ncm: string | null; cfop: string | null; unidade: string | null }[]).map((p) => [
        p.id,
        { ncm: p.ncm, cfop: p.cfop, unidade: p.unidade },
      ]),
    );
  }

  const notasEfd: NotaEfd[] = notas.map((n) => {
    const ped = n.order_id ? pedidos[n.order_id] : undefined;
    const itens: ItemEfd[] = (n.order_id ? (itensPorPedido[n.order_id] ?? []) : []).map((i) => ({
      codigo: i.produto_codigo,
      descricao: i.produto_nome,
      ncm: i.product_id ? (fiscais[i.product_id]?.ncm ?? null) : null,
      cfop: i.product_id ? (fiscais[i.product_id]?.cfop ?? null) : null,
      unidade: i.product_id ? (fiscais[i.product_id]?.unidade ?? null) : null,
      quantidade: Number(i.quantidade),
      preco_cents: i.preco_unit_cents,
      desconto_cents: Math.round((Number(i.quantidade) * i.preco_unit_cents * Number(i.desconto_pct)) / 100),
    }));
    return {
      serie: n.serie,
      numero: n.numero as number,
      chave: n.chave_acesso as string,
      emissao: n.created_at,
      cliente_nome: ped?.cliente_nome ?? "—",
      cliente_documento: ped?.cliente_documento ?? null,
      total_cents: n.total_cents,
      desconto_cents: itens.reduce((a, i) => a + i.desconto_cents, 0),
      frete_cents: ped?.frete_cents ?? 0,
      itens,
    };
  });

  const saida = gerarEfd({
    emitente: {
      nome: "Emitente",
      cnpj: cfg.emitente_documento,
      ie: cfg.ie,
      uf: cfg.uf,
      codigo_municipio: cfg.codigo_municipio,
      crt: cfg.crt,
    },
    ano,
    mes,
    cfopPadrao: cfg.cfop_padrao,
    equivalentes,
    notas: notasEfd,
  });

  // O 0000 pede a razão social: busca o nome fantasia? Não há — a config não
  // guarda razão social, então o arquivo sai com o CNPJ como identificação e
  // a pendência diz para completar. Melhor que inventar nome.
  saida.pendencias.unshift("Razão social do emitente no 0000: complete no PVA (a config ainda não guarda)");

  return ok(
    {
      ano,
      mes,
      ...saida,
      rascunho: true,
      nomes: {
        inicio: saida.inicio,
        fim: saida.fim,
        sugestao: `EFD_${cfg.emitente_documento.replace(/\D/g, "")}_${ano}${mes.toString().padStart(2, "0")}_RASCUNHO.txt`,
      },
    },
    { requestId },
  );
}
