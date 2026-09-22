/**
 * GET  /api/v1/prospecting/campaigns — campanhas.
 * POST /api/v1/prospecting/campaigns — cria campanha.
 * POST /api/v1/prospecting/campaigns/[id]/executar — fã-out: uma busca
 *        queued por (cidade × categorias em blocos), vinculada à campanha.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { campanhaCreateSchema } from "@/lib/schemas/prospeccao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "prospecting_campaigns" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospecting_campaigns")
    .select("id, nome, categorias, cidades, status, recorrencia_dias, ultima_execucao_at, created_at")
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return fail("internal_error", "Erro ao listar campanhas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "prospecting_campaigns" });
  if (!authz.ok) return authz.response;

  const parsed = campanhaCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospecting_campaigns")
    .insert({
      organization_id: authz.org.orgId,
      nome: parsed.data.nome,
      categorias: parsed.data.categorias,
      cidades: parsed.data.cidades,
      recorrencia_dias: parsed.data.recorrencia_dias ?? null,
      status: "rascunho",
      created_by: authz.user.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    return fail("internal_error", "Erro ao criar campanha.", 500, { requestId });
  }

  return ok(data, { requestId, status: 201 });
}
