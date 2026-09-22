/**
 * POST /api/v1/assistente/executar — executa UMA proposta confirmada.
 *
 * O botão Confirmar do chat bate aqui com `{acao, payload}`. Tudo é refeito
 * do zero: ação conhecida? papel mínimo (`piso`) atendido? payload válido no
 * Zod? preço recalculado do catálogo? Só então executa, audita e responde com
 * a mensagem + link. O payload do navegador é DADO NÃO CONFIÁVEL — a
 * confiança vem da sessão e do banco, nunca dele.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  ACOES_DO_ASSISTENTE,
  ehAcaoConhecida,
  executarProposta,
} from "@/lib/assistente/propostas";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const executarSchema = z.object({
  acao: z.string().trim().min(1).max(40),
  payload: z.record(z.string(), z.unknown()),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const parsed = executarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !ehAcaoConhecida(parsed.data.acao)) {
    return fail("validation_failed", "Ação desconhecida.", 422, { requestId });
  }
  const acao = parsed.data.acao;
  const def = ACOES_DO_ASSISTENTE[acao];

  // Piso da ação (espelha a rota equivalente): viewer conversa, mas não
  // confirma escrita. A checagem é AQUI, antes de qualquer efeito.
  const authz = await requireRole(def.piso, { requestId, resource: def.recurso });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  try {
    const resultado = await executarProposta(
      {
        organizationId: authz.org.orgId,
        userId: authz.user.id,
        role: authz.org.role,
        requestId,
        supabase,
        admin: createAdminClient(),
      },
      acao,
      parsed.data.payload,
    );
    return ok(resultado, { requestId, status: 201 });
  } catch (err) {
    if (err instanceof ApiError) {
      const status = err.status === 404 ? 404 : err.status === 409 ? 409 : err.status === 422 ? 422 : 500;
      return fail(
        err.code as "validation_failed" | "not_found" | "conflict" | "internal_error",
        err.message,
        status,
        { requestId },
      );
    }
    throw err;
  }
}
