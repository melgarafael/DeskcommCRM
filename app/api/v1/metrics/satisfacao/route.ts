import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { fecharPedidosVencidos, resumoDaSatisfacao } from "@/lib/atendimento/satisfacao";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/v1/metrics/satisfacao — a MÉDIA e a CONTAGEM da pesquisa de
 * satisfação (#4023), por período.
 *
 * ## Quem vê
 *
 * Piso `manager`, igual a `/metrics/lost` e `/metrics/atrito`: nota de
 * atendimento é régua de gestão, e a issue é explícita — "média e contagem
 * visíveis para quem gerencia [...] NUNCA por conversa individual para quem não
 * gerencia". A policy de leitura de `satisfacao_do_atendimento` diz o mesmo no
 * banco, então um `agent` que peça a tabela pelo PostgREST casa zero linhas.
 *
 * ## O que volta
 *
 * `media` é `null` quando não há NENHUMA nota respondida no período — nunca 0.
 * "Não medido" e "nota zero" são coisas diferentes, e a tela mostra "—" para a
 * primeira (mesma doutrina de `/metrics/atrito`).
 *
 * `sem_nota` conta pedidos cuja janela venceu sem resposta. Eles NÃO entram na
 * média: silêncio não é nota baixa. A varredura de vencidos roda aqui, antes da
 * leitura — um pedido de ontem não pode ficar `aguardando` para sempre e sumir
 * da conta de quem olha o número.
 *
 * ## Por que a superfície é esta
 *
 * Porque `/metrics` já é a tela de números da operação e `requireRole("manager")`
 * já é o piso dela. Criar dashboard novo para duas colunas seria mais uma tela
 * para manter sem número novo nenhum.
 */

export const dynamic = "force-dynamic";

const querySchema = z.object({
  de: z.string().datetime({ offset: true }).optional(),
  ate: z.string().datetime({ offset: true }).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    de: url.searchParams.get("de") ?? undefined,
    ate: url.searchParams.get("ate") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Período inválido."), 422, { requestId });
  }

  const admin = createAdminClient();
  try {
    const fechados = await fecharPedidosVencidos(admin, authz.org.orgId);
    const resumo = await resumoDaSatisfacao(admin, {
      organizationId: authz.org.orgId,
      de: parsed.data.de ?? null,
      ate: parsed.data.ate ?? null,
    });
    return ok({ ...resumo, fechados_agora: fechados }, { requestId });
  } catch (erro) {
    return fail(
      "internal_error",
      erro instanceof Error ? erro.message : t("Não foi possível calcular a satisfação."),
      500,
      { requestId },
    );
  }
}
