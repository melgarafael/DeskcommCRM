/**
 * ESTORNAR a comanda.
 *
 * Estorno não é o desfazer de cancelar: cancelar vale para comanda ABERTA, que
 * ainda não virou nada; estornar vale para a FINALIZADA, que já virou
 * lançamento, comissão e ponto. Por isso são duas operações e não um botão com
 * dois sentidos.
 *
 * E estorno **nunca apaga**. `fn_estornar_comanda` insere o contra-lançamento e
 * deixa o original intacto — ele está pago, e o trigger `fn_lancamento_pago_e_
 * imutavel` recusaria a alteração de qualquer forma. A comissão vira
 * `reversed`, e não some, porque ela existiu e alguém pode já ter sido pago por
 * ela.
 *
 * ⚠️ Exige `manager`, um degrau acima de finalizar. Desfazer dinheiro que já
 * entrou é decisão de quem responde pelo caixa, não de quem opera o balcão — e
 * quem impõe isso é a própria função, no banco.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { estornarSchema } from "@/lib/financeiro/comanda";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function traduzirErro(mensagem: string): { code: string; status: number; texto: string } | null {
  if (mensagem.includes("estorno_forbidden")) {
    return {
      code: "forbidden",
      status: 403,
      texto: "Estornar uma comanda exige perfil de gerente.",
    };
  }
  if (mensagem.includes("comanda_nao_encontrada")) {
    return { code: "not_found", status: 404, texto: "Comanda não encontrada." };
  }
  if (mensagem.includes("comanda_nao_finalizada")) {
    return {
      code: "conflict",
      status: 409,
      texto: "Só comanda finalizada pode ser estornada. Comanda aberta se cancela.",
    };
  }
  return null;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const lido = estornarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail(
      "validation_failed",
      // O motivo é obrigatório porque um estorno sem motivo é um buraco no caixa
      // que ninguém consegue explicar três meses depois.
      lido.error.issues[0]?.message ?? "Informe o motivo do estorno.",
      422,
      { requestId },
    );
  }

  const { id } = await ctx.params;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("fn_estornar_comanda", {
    p_org: authz.org.orgId,
    p_sale: id,
    p_motivo: lido.data.reason,
  });

  if (error) {
    const traduzido = traduzirErro(error.message);
    if (traduzido) {
      return fail(traduzido.code as never, traduzido.texto, traduzido.status as never, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  const desfecho = (data ?? {}) as { sale_id?: string; ja_estornada?: boolean };

  if (!desfecho.ja_estornada) {
    await audit({
      action: "comanda.estornada",
      resourceType: "sale",
      resourceId: id,
      requestId,
      metadata: { reason: lido.data.reason },
    });
  }

  return ok(desfecho, { requestId });
}
