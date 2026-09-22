/**
 * GET /api/v1/financeiro/recebiveis — contas a receber (entidade 0233).
 *
 * Filtros e paginação no BACKEND (§28 do plano): busca (cliente), status
 * (vencido é derivado), vendedor, cidade, período de vencimento, pedido e NF.
 * Enriquecimento em lote (contatos, pedidos, somas) — nunca N+1.
 *
 * POST — recebível avulso (sem pedido): valor + parcelas mensais a partir do
 * primeiro vencimento. Com pedido, use POST /api/v1/financeiro/gerar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { situacaoDe } from "@/lib/comercial/financeiro";
import { recebiveisQuerySchema, recebivelCreateSchema, COLUNAS_DO_RECEBIVEL } from "@/lib/schemas/financeiro";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type LinhaRecebivel = {
  id: string;
  order_id: string | null;
  invoice_id: string | null;
  contact_id: string | null;
  parcela_n: number;
  total_parcelas: number;
  valor_original_cents: number;
  vencimento: string;
  status: "aberto" | "parcial" | "pago" | "cancelado";
  forma_pagamento: string | null;
};

function hojeDia(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "financial_receivables" });
  if (!authz.ok) return authz.response;

  const raw: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    raw[k] = v;
  });
  const parsed = recebiveisQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Filtros inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const q = parsed.data;
  const supabase = await createClient();
  const orgId = authz.org.orgId;
  const hoje = hojeDia();

  // Pré-resolução para filtrar ANTES de paginar (sem ela, a página mentiria).
  let contatoIds: string[] | null = null;
  if (q.busca?.trim() || q.cidade?.trim()) {
    let cq = supabase.from("contacts").select("id").eq("organization_id", orgId).limit(2000);
    if (q.busca?.trim()) {
      const b = q.busca.trim().replace(/[%_]/g, "");
      cq = cq.or(`display_name.ilike.%${b}%,name.ilike.%${b}%,phone_number.ilike.%${b}%`);
    }
    if (q.cidade?.trim()) cq = cq.ilike("cidade", `%${q.cidade.trim().replace(/[%_]/g, "")}%`);
    const { data, error } = await cq;
    if (error) return fail("internal_error", "Erro ao buscar contatos.", 500, { requestId });
    contatoIds = ((data ?? []) as { id: string }[]).map((c) => c.id);
    if (contatoIds.length === 0) return ok([], { requestId, meta: { page: q.page, limit: q.limit, total: 0 } });
  }
  let pedidoIds: string[] | null = null;
  if (q.vendedor) {
    const { data, error } = await supabase
      .from("commercial_orders")
      .select("id")
      .eq("organization_id", orgId)
      .eq("vendedor_user_id", q.vendedor)
      .limit(5000);
    if (error) return fail("internal_error", "Erro ao buscar pedidos do vendedor.", 500, { requestId });
    pedidoIds = ((data ?? []) as { id: string }[]).map((p) => p.id);
    if (pedidoIds.length === 0) return ok([], { requestId, meta: { page: q.page, limit: q.limit, total: 0 } });
  }

  const montaBase = () => {
    let bq = supabase.from("financial_receivables").select(COLUNAS_DO_RECEBIVEL, { count: "exact" }).eq("organization_id", orgId);
    if (contatoIds) bq = bq.in("contact_id", contatoIds);
    if (q.contact_id) bq = bq.eq("contact_id", q.contact_id);
    if (pedidoIds) bq = bq.in("order_id", pedidoIds);
    if (q.pedido_id) bq = bq.eq("order_id", q.pedido_id);
    if (q.invoice_id) bq = bq.eq("invoice_id", q.invoice_id);
    if (q.de) bq = bq.gte("vencimento", q.de);
    if (q.ate) bq = bq.lte("vencimento", q.ate);
    if (q.status === "vencido") bq = bq.lt("vencimento", hoje).in("status", ["aberto", "parcial"]);
    else if (q.status) bq = bq.eq("status", q.status);
    return bq;
  };

  const { count } = await montaBase().limit(0);
  const de = (q.page - 1) * q.limit;
  const ordenada =
    q.ordem === "valor"
      ? montaBase().order("valor_original_cents", { ascending: false })
      : q.ordem === "recentes"
        ? montaBase().order("created_at", { ascending: false })
        : montaBase().order("vencimento", { ascending: true });
  const { data, error } = await ordenada.range(de, de + q.limit - 1);
  if (error) return fail("internal_error", "Erro ao listar recebíveis.", 500, { requestId });
  const linhas = (data ?? []) as unknown as LinhaRecebivel[];

  // Enriquecimento em 3 lotes: contatos, pedidos, somas de pagamentos.
  const idsContatos = [...new Set(linhas.map((l) => l.contact_id).filter((v): v is string => !!v))];
  const idsPedidos = [...new Set(linhas.map((l) => l.order_id).filter((v): v is string => !!v))];
  const idsRec = linhas.map((l) => l.id);
  const [contatos, pedidos, pagamentos] = await Promise.all([
    idsContatos.length > 0
      ? supabase.from("contacts").select("id, display_name, name, cidade, uf").eq("organization_id", orgId).in("id", idsContatos)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    idsPedidos.length > 0
      ? supabase.from("commercial_orders").select("id, numero, cliente_nome").eq("organization_id", orgId).in("id", idsPedidos)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    idsRec.length > 0
      ? supabase.from("financial_payments").select("receivable_id, valor_cents").eq("organization_id", orgId).in("receivable_id", idsRec).limit(5000)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  if (contatos.error || pedidos.error || pagamentos.error) {
    return fail("internal_error", "Erro ao enriquecer recebíveis.", 500, { requestId });
  }
  const mapaContatos = new Map(
    ((contatos.data ?? []) as { id: string; display_name: string | null; name: string | null; cidade: string | null; uf: string | null }[]).map(
      (c) => [c.id, c],
    ),
  );
  const mapaPedidos = new Map(
    ((pedidos.data ?? []) as { id: string; numero: number; cliente_nome: string }[]).map((p) => [p.id, p]),
  );
  const somas = new Map<string, { total: number; itens: { valor_cents: number }[] }>();
  for (const p of (pagamentos.data ?? []) as unknown as { receivable_id: string; valor_cents: number }[]) {
    const atual = somas.get(p.receivable_id) ?? { total: 0, itens: [] };
    atual.total += p.valor_cents;
    atual.itens.push({ valor_cents: p.valor_cents });
    somas.set(p.receivable_id, atual);
  }

  const saida = linhas.map((l) => {
    const pagos = somas.get(l.id)?.itens ?? [];
    const sit = situacaoDe(
      { status: l.status, valor_original_cents: l.valor_original_cents, vencimento: l.vencimento },
      pagos,
      hoje,
    );
    const contato = l.contact_id ? mapaContatos.get(l.contact_id) : undefined;
    const pedido = l.order_id ? mapaPedidos.get(l.order_id) : undefined;
    return {
      ...l,
      situacao: sit.situacao,
      pago_cents: sit.pago_cents,
      saldo_cents: sit.saldo_cents,
      dias_atraso: sit.diasAtraso,
      contato_nome: contato ? (contato.display_name ?? contato.name ?? "—") : null,
      contato_cidade: contato ? [contato.cidade, contato.uf].filter(Boolean).join("/") || null : null,
      pedido_numero: pedido?.numero ?? null,
      pedido_cliente: pedido?.cliente_nome ?? null,
    };
  });

  return ok(saida, { requestId, meta: { page: q.page, limit: q.limit, total: count ?? saida.length } });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "financial_receivables" });
  if (!authz.ok) return authz.response;

  const parsed = recebivelCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const e = parsed.data;
  const supabase = await createClient();

  const { data: contato } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", e.contact_id)
    .maybeSingle();
  if (!contato) return fail("validation_failed", "Contato não encontrado.", 422, { requestId });

  // Parcelas mensais a partir do primeiro vencimento (documentado no schema).
  const base = Math.floor(e.valor_original_cents / e.parcelas);
  const dia0 = new Date(`${e.vencimento}T12:00:00Z`);
  const linhas = Array.from({ length: e.parcelas }, (_, i) => {
    const ultimo = i === e.parcelas - 1;
    const venc = new Date(dia0.getTime());
    venc.setUTCMonth(venc.getUTCMonth() + i);
    return {
      organization_id: authz.org.orgId,
      order_id: e.order_id ?? null,
      invoice_id: e.invoice_id ?? null,
      contact_id: e.contact_id,
      parcela_n: i + 1,
      total_parcelas: e.parcelas,
      valor_original_cents: ultimo ? e.valor_original_cents - base * (e.parcelas - 1) : base,
      vencimento: venc.toISOString().slice(0, 10),
      status: "aberto",
      forma_pagamento: e.forma_pagamento ?? null,
      observacoes: e.observacoes ?? null,
      created_by: authz.user.id,
    };
  });

  const { data, error } = await supabase.from("financial_receivables").insert(linhas).select("id");
  if (error || !data) return fail("internal_error", "Erro ao criar recebíveis.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "financial_receivable.created",
    resourceType: "financial_receivables",
    resourceId: (data as unknown as { id: string }[])[0]?.id ?? null,
    requestId,
  });
  return ok({ ids: (data as unknown as { id: string }[]).map((r) => r.id) }, { requestId, status: 201 });
}
