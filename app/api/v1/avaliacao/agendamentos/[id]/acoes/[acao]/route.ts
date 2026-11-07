import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { MODULO_AVALIACAO_NAO_INSTALADO, moduloAvaliacaoNaoInstalado } from "@/lib/avaliacao/modulo";
import { ACOES_TRANSICAO } from "@/lib/avaliacao/status";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const acaoSchema = z.enum(ACOES_TRANSICAO);

interface RouteCtx {
  params: Promise<{ id: string; acao: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id, acao } = await ctx.params;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) return fail("not_found", "Not found", 404, { requestId });

  const parsedAcao = acaoSchema.safeParse(acao);
  if (!parsedAcao.success) return fail("validation_failed", "Ação inválida.", 422, { requestId });

  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "avaliacao_agendamentos" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_avaliacao_transicao_status", {
    p_org: authz.org.orgId,
    p_id: id,
    p_acao: parsedAcao.data,
  });

  if (error) {
    if (moduloAvaliacaoNaoInstalado(error)) {
      return fail("module_not_installed", MODULO_AVALIACAO_NAO_INSTALADO, 409, { requestId });
    }
    if (error.message.includes("avaliacao_transicao_invalida")) {
      return fail("conflict", "Esta ação não é permitida para o status atual.", 409, { requestId });
    }
    if (error.message.includes("avaliacao_cancelado_nao_inicia")) {
      return fail("conflict", "Agendamento cancelado não pode iniciar avaliação.", 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "avaliacao.agendamento_acao",
    resourceType: "avaliacao_agendamento",
    resourceId: id,
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    metadata: { acao: parsedAcao.data, resultado: data },
  });

  return ok(data, { requestId });
}
