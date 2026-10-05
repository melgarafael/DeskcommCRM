import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerAcervoDoCanal, salvarAcervoDoCanal } from "@/lib/channels/acervo-do-historico";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * A opção por conexão da #999: guardar (ou não) o acervo do histórico do número.
 *
 * Desligada por padrão — a chave ausente do `metadata` já responde `false`, que
 * é a decisão registrada na issue. Mesma porta de admin da tela de conexões, e
 * a escrita é em `channel_sessions.metadata`, sem migration.
 */
export async function GET(_req: NextRequest, { params }: Context): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: "leitura" });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const valor = await lerAcervoDoCanal(createAdminClient(), auth.org.orgId, id);
  if (valor === null) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  return ok({ guardar_historico: valor }, { requestId });
}

export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const parsed = z.object({ guardar_historico: z.boolean() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Informe se o histórico deste número deve ser guardado.", 422, { requestId });
  // Grava e já tenta aplicar na sessão existente. Se o canal não responder, a
  // opção segue salva e vale na próxima subida da sessão: escolha do operador
  // não depende de o transporte estar de pé para ser lembrada.
  const salvo = await salvarAcervoDoCanal(createAdminClient(), auth.org.orgId, id, parsed.data.guardar_historico);
  if (!salvo) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  void audit({
    action: "channel.acervo_updated",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { guardar_historico: salvo.guardar_historico, aplicado: salvo.aplicado },
  });
  return ok(salvo, { requestId });
}
