import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { perfilDaOrganizacao } from "@/lib/legal/perfil-do-pais";
import { contactCreateSchemaDoPais, validateRequest, type ContactCreate } from "@/lib/schemas";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { createContactHandler } from "@/app/api/v1/contacts/_handler";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("validation_failed", "Negócio inválido.", 422, { requestId });
  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  // O documento do titular é validado pela régua do PAÍS da organização (issue
  // #1033): quem decide é a coluna `organizations.country`, nunca o corpo da
  // requisição — mesma doutrina da moeda em `lib/catalogo/moeda-da-org.ts`.
  const perfil = await perfilDaOrganizacao(supabase, activeOrg.orgId);

  let input;
  try {
    input = await validateRequest(contactCreateSchemaDoPais(perfil), req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const result = await createContactHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: user.idioma,
      },
      input as ContactCreate,
      id,
    );
    return ok(result, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
