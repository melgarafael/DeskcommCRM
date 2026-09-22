import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O FINANCEIRO COMO ENTIDADE — recebíveis e pagamentos (0233).
 *
 * Contratos que este módulo guarda (testados abaixo, sem banco):
 * - `paidAmount > originalAmount` e `balance < 0` nunca acontecem: o teto é
 *   checado antes de inserir (`validarPagamento`), e `UNIQUE` parcial impede
 *   gerar duas vezes o mesmo (pedido, parcela).
 * - VENCIDO é derivado (vencimento < hoje com saldo > 0), nunca gravado: sem
 *   cron varrendo a tabela todo dia.
 * - NF é opcional (`invoice_id` nulo é estado válido): pedido → financeiro
 *   existe com ou sem NF; nunca `if (!nota) financeiro = null`.
 *
 * O que é DB vai por `admin` injetado (molde do motor de prospecção): cada
 * função lê o que precisa, escreve o mínimo, e nunca lança erro cru — devolve
 * discriminante para a rota traduzir em `fail()`.
 */

export type StatusRecebivelGravado = "aberto" | "parcial" | "pago" | "cancelado";
export type SituacaoRecebivel = StatusRecebivelGravado | "vencido";

export interface RecebivelLinha {
  id: string;
  organization_id: string;
  order_id: string | null;
  invoice_id: string | null;
  contact_id: string | null;
  parcela_n: number;
  total_parcelas: number;
  valor_original_cents: number;
  vencimento: string;
  status: StatusRecebivelGravado;
  forma_pagamento: string | null;
}

export interface PagamentoLinha {
  id: string;
  receivable_id: string;
  valor_cents: number;
  pago_em: string;
}

/** Prazos em dias a partir da condição ("30/60/90", "28 dias"). null = à vista. */
export function prazosDaCondicao(condicao: string | null | undefined): number[] | null {
  if (!condicao) return null;
  const nums = [...condicao.matchAll(/(\d+)\s*(?:dias?)?/gi)].map((m) => Number(m[1]));
  const prazos = nums.filter((n) => n >= 0 && n <= 720);
  return prazos.length <= 1 ? null : prazos;
}

export interface ParcelaCalculada {
  n: number;
  valor_cents: number;
  vencimento: string;
}

/**
 * Divide o total em parcelas com resto na última (1/3 de 1000 → 333,33 +
 * 333,33 + 333,34). Vencimento = base + dias. À vista (sem padrão) = parcela
 * única vencendo na emissão — nunca "combinar depois" adivinhado.
 */
export function dividirParcelas(
  totalCents: number,
  condicao: string | null | undefined,
  baseIso: string,
): ParcelaCalculada[] {
  const prazos = prazosDaCondicao(condicao);
  const base = new Date(`${baseIso.slice(0, 10)}T12:00:00Z`).getTime();
  if (prazos === null) {
    return [{ n: 1, valor_cents: Math.max(0, totalCents), vencimento: baseIso.slice(0, 10) }];
  }
  const parte = Math.floor(totalCents / prazos.length);
  return prazos.map((dias, i) => {
    const ultimo = i === prazos.length - 1;
    return {
      n: i + 1,
      valor_cents: ultimo ? totalCents - parte * (prazos.length - 1) : parte,
      vencimento: new Date(base + dias * 86400000).toISOString().slice(0, 10),
    };
  });
}

export function somarPagamentos(pagamentos: Pick<PagamentoLinha, "valor_cents">[]): number {
  return pagamentos.reduce((s, p) => s + p.valor_cents, 0);
}

export interface SituacaoCalculada {
  situacao: SituacaoRecebivel;
  pago_cents: number;
  saldo_cents: number;
  diasAtraso: number;
}

/** Situação derivada: pago > parcial > cancelado > vencido > aberto. */
export function situacaoDe(
  gravado: Pick<RecebivelLinha, "status" | "valor_original_cents" | "vencimento">,
  pagos: Pick<PagamentoLinha, "valor_cents">[],
  hojeIso: string,
): SituacaoCalculada {
  const pago = somarPagamentos(pagos);
  const saldo = Math.max(0, gravado.valor_original_cents - pago);
  const diasAtraso =
    saldo > 0 && gravado.vencimento < hojeIso.slice(0, 10)
      ? Math.floor(
          (new Date(`${hojeIso.slice(0, 10)}T12:00:00Z`).getTime() -
            new Date(`${gravado.vencimento}T12:00:00Z`).getTime()) /
            86400000,
        )
      : 0;
  if (gravado.status === "cancelado") return { situacao: "cancelado", pago_cents: pago, saldo_cents: saldo, diasAtraso: 0 };
  if (saldo === 0 && gravado.valor_original_cents > 0) return { situacao: "pago", pago_cents: pago, saldo_cents: 0, diasAtraso: 0 };
  if (pago > 0) {
    return {
      situacao: "parcial",
      pago_cents: pago,
      saldo_cents: saldo,
      diasAtraso,
    };
  }
  return {
    situacao: diasAtraso > 0 ? "vencido" : "aberto",
    pago_cents: 0,
    saldo_cents: gravado.valor_original_cents,
    diasAtraso,
  };
}

export type ErroPagamento = "acima_do_saldo" | "valor_invalido" | "recebivel_fechado" | "nao_achado";

/** Teto do caixa: pagamento (0, saldo]. Erro discriminado, nunca throw. */
export function validarPagamento(valorCents: number, saldoCents: number): ErroPagamento | null {
  if (!Number.isInteger(valorCents) || valorCents <= 0) return "valor_invalido";
  if (saldoCents <= 0) return "recebivel_fechado";
  if (valorCents > saldoCents) return "acima_do_saldo";
  return null;
}

function statusAposPagamento(saldoRestante: number): StatusRecebivelGravado {
  return saldoRestante === 0 ? "pago" : "parcial";
}

/**
 * Gera os recebíveis de um pedido (idempotente: pula parcela já existente).
 * Chamar ao faturar e no botão "Gerar financeiro" — nunca duplica.
 */
export async function gerarRecebiveis(
  admin: SupabaseClient,
  args: {
    orgId: string;
    orderId: string;
    contactId: string | null;
    totalCents: number;
    condicao: string | null;
    baseIso: string;
    criadoPor: string | null;
  },
): Promise<{ criados: number; existentes: number; ids: string[] }> {
  const parcelas = dividirParcelas(args.totalCents, args.condicao, args.baseIso);
  const { data: ja } = await admin
    .from("financial_receivables")
    .select("parcela_n")
    .eq("organization_id", args.orgId)
    .eq("order_id", args.orderId);
  const feitas = new Set(((ja ?? []) as { parcela_n: number }[]).map((r) => r.parcela_n));
  let criados = 0;
  const ids: string[] = [];
  for (const p of parcelas) {
    if (feitas.has(p.n)) continue;
    const { data, error } = await admin
      .from("financial_receivables")
      .insert({
        organization_id: args.orgId,
        order_id: args.orderId,
        contact_id: args.contactId,
        parcela_n: p.n,
        total_parcelas: parcelas.length,
        valor_original_cents: p.valor_cents,
        vencimento: p.vencimento,
        status: "aberto",
        created_by: args.criadoPor,
      })
      .select("id")
      .single();
    // Corrida entre dois cliques: unique parcial barra o segundo — conta como
    // existente em vez de falhar (idempotência de verdade, não de promessa).
    if (error) {
      if (error.code === "23505") continue;
      throw new Error(`gerar-recebiveis: ${error.message}`);
    }
    criados++;
    ids.push((data as unknown as { id: string }).id);
  }
  return { criados, existentes: parcelas.length - criados, ids };
}

export type ResultadoPagamento =
  | { ok: true; pagamentoId: string; jaExistia: boolean; novoStatus: StatusRecebivelGravado }
  | { ok: false; erro: ErroPagamento | "nao_achado" };

/**
 * Registra recebimento com teto e idempotência. `chave` (Idempotency-Key do
 * header): retry com a mesma chave devolve o pagamento original.
 */
export async function registrarPagamento(
  admin: SupabaseClient,
  args: {
    orgId: string;
    receivableId: string;
    valorCents: number;
    pagoEm?: string | null;
    forma?: string | null;
    conta?: string | null;
    observacao?: string | null;
    chave?: string | null;
    criadoPor: string | null;
    hojeIso: string;
  },
): Promise<ResultadoPagamento> {
  const { data: rec } = await admin
    .from("financial_receivables")
    .select("id, valor_original_cents, status")
    .eq("organization_id", args.orgId)
    .eq("id", args.receivableId)
    .maybeSingle();
  const recebivel = rec as unknown as {
    id: string;
    valor_original_cents: number;
    status: StatusRecebivelGravado;
  } | null;
  if (!recebivel) return { ok: false, erro: "nao_achado" };
  if (recebivel.status === "pago" || recebivel.status === "cancelado") {
    return { ok: false, erro: "recebivel_fechado" };
  }

  if (args.chave) {
    const { data: dup } = await admin
      .from("financial_payments")
      .select("id")
      .eq("organization_id", args.orgId)
      .eq("receivable_id", args.receivableId)
      .eq("idempotency_key", args.chave)
      .maybeSingle();
    if (dup) {
      const { data: pagos } = await admin
        .from("financial_payments")
        .select("valor_cents")
        .eq("organization_id", args.orgId)
        .eq("receivable_id", args.receivableId);
      const total = somarPagamentos((pagos ?? []) as { valor_cents: number }[]);
      const novoStatus: StatusRecebivelGravado =
        total >= recebivel.valor_original_cents ? "pago" : total > 0 ? "parcial" : "aberto";
      return {
        ok: true,
        pagamentoId: (dup as unknown as { id: string }).id,
        jaExistia: true,
        novoStatus,
      };
    }
  }

  const { data: pagos } = await admin
    .from("financial_payments")
    .select("valor_cents")
    .eq("organization_id", args.orgId)
    .eq("receivable_id", args.receivableId);
  const totalPago = somarPagamentos((pagos ?? []) as { valor_cents: number }[]);
  const saldo = recebivel.valor_original_cents - totalPago;
  const invalido = validarPagamento(args.valorCents, saldo);
  if (invalido) return { ok: false, erro: invalido };

  const { data: novo, error } = await admin
    .from("financial_payments")
    .insert({
      organization_id: args.orgId,
      receivable_id: args.receivableId,
      valor_cents: args.valorCents,
      pago_em: args.pagoEm ?? new Date().toISOString(),
      forma_pagamento: args.forma ?? null,
      conta: args.conta ?? null,
      observacao: args.observacao ?? null,
      idempotency_key: args.chave ?? null,
      created_by: args.criadoPor,
    })
    .select("id")
    .single();
  if (error) {
    // Corrida perdeu na unique: relê e devolve o vencedor (nunca 500 à toa).
    if (error.code === "23505" && args.chave) {
      return registrarPagamento(admin, { ...args, chave: args.chave });
    }
    throw new Error(`registrar-pagamento: ${error.message}`);
  }
  const novoStatus = statusAposPagamento(saldo - args.valorCents);
  await admin
    .from("financial_receivables")
    .update({ status: novoStatus, updated_at: new Date().toISOString() })
    .eq("id", args.receivableId);
  return { ok: true, pagamentoId: (novo as unknown as { id: string }).id, jaExistia: false, novoStatus };
}

/** Estorna um recebimento e recalcula o status (nunca deixa pago fantasma). */
export async function estornarPagamento(
  admin: SupabaseClient,
  args: { orgId: string; pagamentoId: string },
): Promise<{ ok: true; novoStatus: StatusRecebivelGravado } | { ok: false; erro: "nao_achado" }> {
  const { data: pag } = await admin
    .from("financial_payments")
    .select("id, receivable_id")
    .eq("organization_id", args.orgId)
    .eq("id", args.pagamentoId)
    .maybeSingle();
  if (!pag) return { ok: false, erro: "nao_achado" };
  const receivableId = (pag as unknown as { receivable_id: string }).receivable_id;
  await admin.from("financial_payments").delete().eq("id", args.pagamentoId);
  const { data: rec } = await admin
    .from("financial_receivables")
    .select("id, valor_original_cents, status")
    .eq("id", receivableId)
    .maybeSingle();
  const recebivel = rec as unknown as {
    valor_original_cents: number;
    status: StatusRecebivelGravado;
  } | null;
  if (recebivel && recebivel.status !== "cancelado") {
    const { data: pagos } = await admin
      .from("financial_payments")
      .select("valor_cents")
      .eq("organization_id", args.orgId)
      .eq("receivable_id", receivableId);
    const total = somarPagamentos((pagos ?? []) as { valor_cents: number }[]);
    const novoStatus: StatusRecebivelGravado =
      total >= recebivel.valor_original_cents ? "pago" : total > 0 ? "parcial" : "aberto";
    await admin
      .from("financial_receivables")
      .update({ status: novoStatus, updated_at: new Date().toISOString() })
      .eq("id", receivableId);
    return { ok: true, novoStatus };
  }
  return { ok: true, novoStatus: recebivel?.status ?? "aberto" };
}
