/**
 * POST /api/v1/contacts/[id]/phones/[phoneId]/primary — "Tornar principal" (Spec 31, B2, item 6).
 *
 * Troca o extra pelo principal numa operação só (`fn_tornar_telefone_principal`,
 * migration 9042). Extra que não é desta ficha, ou ficha mesclada/anonimizada → 404.
 * Sessão + papel `agent` + `requireSupportWrite` antes do efeito.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { ehUuid, tornarTelefonePrincipal } from "../../_handler";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; phoneId: string }> };

export async function POST(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, phoneId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  if (!ehUuid(id) || !ehUuid(phoneId)) {
    return fail("not_found", "Telefone não encontrado nesta ficha.", 404, { requestId });
  }

  const supabase = await createClient();
  try {
    await tornarTelefonePrincipal(
      {
        supabase,
        organizationId: activeOrg.orgId,
        contactId: id,
        actorUserId: user.id,
        requestId,
        idioma: user.idioma,
      },
      phoneId,
    );
    // O extra promovido deixou de existir como extra (virou o principal, sem id
    // próprio); quem quiser os dados da ficha relê o GET de contato.
    return ok({ contact_id: id, promoted: true }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
