/**
 * FINALIZAR a comanda — as seis coisas numa transação só.
 *
 * A rota não faz nenhuma delas: quem faz é `fn_finalizar_comanda`, e isso é o
 * desenho, não preguiça. Marcar a venda, gerar comissão por item, lançar a
 * entrada na conta da forma de pagamento, dar o ponto de fidelidade e concluir o
 * agendamento precisam acontecer juntos ou não acontecer — e "juntos" em
 * TypeScript, com seis chamadas ao PostgREST, é seis oportunidades de parar no
 * meio com metade do dinheiro registrado.
 *
 * A função também trava a linha (`for update`), o que a torna idempotente de
 * fato: dois toques no botão devolvem o mesmo desfecho, não dois lançamentos.
 *
 * ⚠️ Ela exige `auth.uid()` e papel `agent`. Chamar com o client admin levanta
 * `comanda_forbidden` — o client de sessão aqui não é preferência de estilo.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { finalizarSchema } from "@/lib/financeiro/comanda";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * O erro do banco vira resposta com nome.
 *
 * Cada um destes é uma recusa DELIBERADA da função, escrita no corpo dela. Sem
 * esta tradução, todos chegariam como 500 "internal_error" — e `forma_sem_conta`
 * viraria "erro no servidor" quando o que falta é alguém escolher a conta de
 * destino numa tela de configuração.
 */
function traduzirErro(mensagem: string): { code: string; status: number; texto: string } | null {
  if (mensagem.includes("comanda_forbidden")) {
    return { code: "forbidden", status: 403, texto: "Sem permissão para finalizar comandas." };
  }
  if (mensagem.includes("comanda_nao_encontrada")) {
    return { code: "not_found", status: 404, texto: "Comanda não encontrada." };
  }
  if (mensagem.includes("comanda_cancelada")) {
    return { code: "conflict", status: 409, texto: "Comanda cancelada não pode ser finalizada." };
  }
  if (mensagem.includes("forma_sem_conta")) {
    return {
      code: "validation_failed",
      status: 422,
      texto:
        "Esta forma de pagamento ainda não tem conta de destino. Defina em Configurações › Financeiro.",
    };
  }
  if (mensagem.includes("forma_de_pagamento_invalida")) {
    return { code: "validation_failed", status: 422, texto: "Forma de pagamento inválida." };
  }
  return null;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const lido = finalizarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const { id } = await ctx.params;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("fn_finalizar_comanda", {
    p_org: authz.org.orgId,
    p_sale: id,
    p_payment_method: lido.data.payment_method_id,
    p_loyalty_points: lido.data.loyalty_points,
  });

  if (error) {
    const traduzido = traduzirErro(error.message);
    if (traduzido) {
      return fail(traduzido.code as never, traduzido.texto, traduzido.status as never, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  const desfecho = (data ?? {}) as { sale_id?: string; ja_finalizada?: boolean };

  // Auditar a chamada REPETIDA seria contar duas vezes o mesmo faturamento para
  // quem for ler o audit depois. A função diz qual das duas aconteceu.
  if (!desfecho.ja_finalizada) {
    await audit({
      action: "comanda.finalizada",
      resourceType: "sale",
      resourceId: id,
      requestId,
      metadata: {
        payment_method_id: lido.data.payment_method_id,
        loyalty_points: lido.data.loyalty_points,
      },
    });
  }

  return ok(desfecho, { requestId });
}
