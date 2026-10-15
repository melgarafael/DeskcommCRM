import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

const nameSchema = z
  .object({ display_name: z.string().trim().min(1).max(80) })
  .strict();

/** Altera somente o rótulo interno do canal; nenhum nome é enviado ao provedor. */
export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const auth = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", "Canal inválido.", 422, { requestId });

  const parsed = nameSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Informe um nome interno com até 80 caracteres.", 422, {
      requestId,
    });

  const db = createAdminClient();
  const { data: before, error: readError } = await db
    .from("channel_sessions")
    .select("display_name")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (readError)
    return fail("internal_error", "Não foi possível ler o nome da conexão.", 500, { requestId });
  if (!before) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const displayName = parsed.data.display_name;
  if (before.display_name === displayName) return ok({ id, display_name: displayName }, { requestId });

  const { data, error } = await db
    .from("channel_sessions")
    .update({ display_name: displayName })
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .is("archived_at", null)
    .select("id, display_name")
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não foi possível salvar o nome da conexão.", 500, {
      requestId,
    });
  if (!data) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  void audit({
    action: "channel.renamed",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { previous_display_name: before.display_name, display_name: displayName },
  });
  return ok(data, { requestId });
}
