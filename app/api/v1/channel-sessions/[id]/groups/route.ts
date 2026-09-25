/**
 * GET/PUT /api/v1/channel-sessions/[id]/groups — os grupos do número e a chave de cada um.
 * Só gerente ou administrador. A organização vem da sessão autenticada, nunca do body.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { alternarGrupo, criarDepsDeGrupos, GrupoError, listarGruposDoNumero } from "@/lib/grupos/servico";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const corpoSchema = z.object({
  group_chat_id: z.string().regex(/^[\d-]+@g\.us$/),
  subject: z.string().max(200).nullable().optional(),
  enabled: z.boolean(),
});

const STATUS: Record<GrupoError["code"], number> = {
  sessao_nao_encontrada: 404,
  canal_sem_grupos: 409,
  filtro_nao_confirmado: 502,
};

function falhaDeGrupo(err: unknown, requestId: string): Response {
  if (err instanceof GrupoError) return fail(err.code, err.code, STATUS[err.code], { requestId });
  // O resto é o transporte: sessão fora de WORKING, provedor fora do ar ou sem
  // configuração. Antes subia como 500 cru do Next, sem o envelope `{ error }`
  // nem o request id.
  logger.warn("grupos: o transporte do canal não respondeu", {
    requestId,
    causa: err instanceof Error ? err.message : String(err),
  });
  return fail(
    "channel_unavailable",
    "O WhatsApp deste número não respondeu. Confira se ele está conectado e tente de novo.",
    502,
    { requestId },
  );
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channel_session_groups" });
  if (!authz.ok) return authz.response;
  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return fail("validation_error", "id inválido", 400, { requestId });
  try {
    const grupos = await listarGruposDoNumero(criarDepsDeGrupos(createAdminClient()), {
      organizationId: authz.org.orgId,
      channelSessionId: id.data,
    });
    return ok(grupos, { requestId });
  } catch (err) {
    return falhaDeGrupo(err, requestId);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channel_session_groups" });
  if (!authz.ok) return authz.response;
  const id = idSchema.safeParse((await ctx.params).id);
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!id.success || !corpo.success) return fail("validation_error", "dados inválidos", 400, { requestId });
  try {
    const r = await alternarGrupo(criarDepsDeGrupos(createAdminClient()), {
      organizationId: authz.org.orgId,
      channelSessionId: id.data,
      groupChatId: corpo.data.group_chat_id,
      subject: corpo.data.subject ?? null,
      ligar: corpo.data.enabled,
      actorUserId: authz.user.id,
      requestId,
    });
    return ok(r, { requestId });
  } catch (err) {
    return falhaDeGrupo(err, requestId);
  }
}
