/**
 * POST /api/v1/admin/tenants/[id]/delete — exclusão DEFINITIVA de um tenant.
 *
 * Irreversível, e por isso cercada dos dois lados:
 *
 *  - aqui: admin da plataforma com escopo `full` e MFA de sessão; a organização
 *    precisa estar SUSPENSA, e não por cobrança (409
 *    `exclusao_com_cobranca_pendente`); o corpo traz o slug digitado como
 *    confirmação e o motivo (vai para a lápide da auditoria);
 *  - no banco (`fn_excluir_organizacao`, migration 0614): as mesmas três
 *    condições conferidas de novo, dentro da transação.
 *
 * O procedimento inteiro — ler as credenciais, a transação, desligar canais e
 * integrações só depois do commit, o Storage, os logins que ficaram sem
 * organização — mora em
 * `lib/tenants/exclusao.ts`. Esta rota só autoriza e traduz.
 *
 * O 500 diz "nada foi apagado" só quando é verdade — erro antes do commit ou
 * do próprio Postgres. Interrompida depois do commit (ou com a resposta da
 * transação perdida) é outra frase: tente de novo, que a nova tentativa
 * retoma a limpeza a partir da lápide.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { excluirOrganizacao, ExclusaoInterrompida, ExclusaoRecusada } from "@/lib/tenants/exclusao";

const bodySchema = z.object({
  /** O slug da organização, digitado pelo admin — a confirmação de que sabe o que está apagando. */
  confirmacao: z.string().min(1).max(200),
  motivo: z
    .string()
    .trim()
    .min(10, "Motivo deve ter ao menos 10 caracteres")
    .max(500, "Motivo deve ter no máximo 500 caracteres"),
});

const STATUS_DA_RECUSA: Record<ExclusaoRecusada["codigo"], number> = {
  not_found: 404,
  state_conflict: 409,
  exclusao_com_cobranca_pendente: 409,
  exclusao_com_assinatura_viva: 409,
  provedor_indisponivel: 503,
  confirmacao_divergente: 400,
  motivo_curto: 400,
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  const supportDenied = await requireSupportWrite(id);
  if (supportDenied) return supportDenied;

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return fail(
      "validation_failed",
      "Informe a confirmação e o motivo (mínimo 10 caracteres).",
      400,
      {
        requestId,
      },
    );
  }

  try {
    const resultado = await excluirOrganizacao(createAdminClient(), {
      orgId: id,
      atorId: adminCtx.user.id,
      confirmacao: body.confirmacao.trim(),
      motivo: body.motivo,
      requestId,
    });
    return ok(resultado, { requestId });
  } catch (err) {
    if (err instanceof ExclusaoRecusada) {
      return fail(err.codigo, err.message, STATUS_DA_RECUSA[err.codigo], { requestId });
    }
    if (err instanceof ExclusaoInterrompida) {
      logger.error("[admin.tenants.delete] exclusão interrompida depois do commit", {
        requestId,
        organization_id: id,
        erro: err.message,
      });
      return fail(
        "internal_error",
        "A exclusão pode já ter sido confirmada no banco, mas a limpeza (WhatsApp, arquivos, logins) não terminou. Tente de novo com o mesmo identificador: a nova tentativa retoma de onde parou.",
        500,
        { requestId },
      );
    }
    logger.error("[admin.tenants.delete] exclusão falhou", {
      requestId,
      organization_id: id,
      erro: err instanceof Error ? err.message : String(err),
    });
    return fail(
      "internal_error",
      "A exclusão não foi concluída. Nada foi apagado do banco — tente novamente.",
      500,
      { requestId },
    );
  }
}
