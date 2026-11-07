import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { MODULO_AVALIACAO_NAO_INSTALADO, moduloAvaliacaoNaoInstalado } from "@/lib/avaliacao/modulo";
import { unidadeSchema } from "@/lib/avaliacao/schemas";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) return fail("not_found", "Not found", 404, { requestId });

  const authz = await requireRole("viewer", { requestId, resource: "avaliacao_unidades" });
  if (!authz.ok) return authz.response;

  const somenteAtivas = req.nextUrl.searchParams.get("active") !== "0";
  const supabase = await createClient();
  let q = supabase
    .from("avaliacao_unidades")
    .select("id, name, sort_order, is_active")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (somenteAtivas) q = q.eq("is_active", true);

  const { data, error } = await q;
  if (error) {
    if (moduloAvaliacaoNaoInstalado(error)) {
      return fail("module_not_installed", MODULO_AVALIACAO_NAO_INSTALADO, 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) return fail("not_found", "Not found", 404, { requestId });

  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "avaliacao_unidades" });
  if (!authz.ok) return authz.response;

  const body = unidadeSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return fail("validation_failed", body.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("avaliacao_unidades")
    .insert({
      organization_id: authz.org.orgId,
      name: body.data.name,
      sort_order: body.data.sort_order ?? 0,
      is_active: body.data.is_active ?? true,
    })
    .select("id, name, sort_order, is_active")
    .single();

  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "avaliacao.unidade_criada",
    resourceType: "avaliacao_unidade",
    resourceId: data.id,
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
  });

  return ok(data, { requestId, status: 201 });
}
