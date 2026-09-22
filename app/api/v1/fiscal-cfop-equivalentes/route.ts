/**
 * GET  /api/v1/fiscal-cfop-equivalentes — de/para de CFOP da org.
 * POST /api/v1/fiscal-cfop-equivalentes — cria equivalência (manager+).
 *
 * O de/para é lido pelo Gera Arquivo do SPED para mapear o CFOP do item.
 * Escrita é manager+: mapeamento errado contamina o SPED inteiro.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { cfopEquivalenteSchema } from "@/lib/schemas/fiscal";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = "id, cfop_origem, cfop_destino, created_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "fiscal-cfop-equivalentes" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fiscal_cfop_equivalentes")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("cfop_origem")
    .limit(500);
  if (error) return fail("internal_error", "Erro ao listar as equivalências.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "fiscal-cfop-equivalentes" });
  if (!authz.ok) return authz.response;

  const parsed = cfopEquivalenteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "CFOP inválido (4 dígitos, origem ≠ destino).", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fiscal_cfop_equivalentes")
    .insert({
      organization_id: authz.org.orgId,
      cfop_origem: parsed.data.cfop_origem,
      cfop_destino: parsed.data.cfop_destino,
      created_by: authz.user.id,
    })
    .select(COLUNAS)
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return fail("conflict", "Esta origem já tem equivalência — edite ou apague a atual.", 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar a equivalência.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "fiscal.cfop_equivalente",
    resourceType: "fiscal_cfop_equivalentes",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
