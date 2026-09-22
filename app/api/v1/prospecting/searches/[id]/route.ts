/**
 * GET   /api/v1/prospecting/searches/[id] — detalhe com progresso.
 * PATCH /api/v1/prospecting/searches/[id] — {acao: pause|resume|cancel}.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const COLUNAS =
  "id, categorias, cidade, estado, pais, latitude, longitude, raio_km, max_empresas, " +
  "provider, status, grid_size_km, grid_overlap_pct, total_celulas, celulas_processadas, " +
  "encontradas, novas, duplicadas, erros, requisicoes, detalhes, custo_estimado_cents, " +
  "ultimo_erro, created_at, started_at, finished_at";

export async function GET(_req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "prospecting_searches" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospecting_searches")
    .select(COLUNAS)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .single();

  if (error || !data) return fail("not_found", "Busca não encontrada.", 404, { requestId });
  const busca = data as unknown as Record<string, unknown> & { total_celulas: number; celulas_processadas: number };
  return ok(
    {
      ...busca,
      progresso_pct:
        busca.total_celulas > 0 ? Math.round((busca.celulas_processadas / busca.total_celulas) * 100) : 0,
    },
    { requestId },
  );
}

const acaoSchema = z.object({ acao: z.enum(["pause", "resume", "cancel"]) });

export async function PATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "prospecting_searches" });
  if (!authz.ok) return authz.response;

  const parsed = acaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Dados inválidos.", 422, { requestId });

  const { id } = await params;
  const supabase = await createClient();
  const { data: atual } = await supabase
    .from("prospecting_searches")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const linha = atual as unknown as { id: string; status: string } | null;
  if (!linha) return fail("not_found", "Busca não encontrada.", 404, { requestId });

  const mapa = { pause: "paused", resume: "queued", cancel: "cancelled" } as const;
  if (linha.status === "completed" || linha.status === "failed") {
    return fail("validation_failed", "Busca encerrada não muda de estado.", 422, { requestId });
  }

  const { data, error } = await supabase
    .from("prospecting_searches")
    .update({ status: mapa[parsed.data.acao] })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id, status")
    .single();

  if (error || !data) return fail("internal_error", "Erro ao mudar estado.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "prospecting_search.state_changed",
    resourceType: "prospecting_searches",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}
