import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { buscarContatoPorTelefoneParaApi } from "@/lib/avaliacao/resolver-contato";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({ phone: z.string().trim().min(8).max(32) });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) return fail("not_found", "Not found", 404, { requestId });

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;

  const parsed = querySchema.safeParse({ phone: req.nextUrl.searchParams.get("phone") ?? "" });
  if (!parsed.success) {
    return fail("validation_failed", "Informe um telefone válido.", 422, { requestId });
  }

  const contato = await buscarContatoPorTelefoneParaApi(admin, authz.org.orgId, parsed.data.phone);
  if (!contato) return ok({ contato: null }, { requestId });

  return ok(
    {
      contato: {
        id: contato.id,
        name: contato.name,
        phone_number: contato.phone_number,
      },
    },
    { requestId },
  );
}
