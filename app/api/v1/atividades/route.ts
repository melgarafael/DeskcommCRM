/**
 * GET  /api/v1/atividades — o que foi feito, do mais recente (leitura: viewer+).
 * POST /api/v1/atividades — registra atividade (escrita: agent+).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { atividadeCreateSchema } from "@/lib/schemas/tarefas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = "id, contact_id, tipo, resultado, observacao, user_id, ocorrida_em, created_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_activities" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("commercial_activities")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("ocorrida_em", { ascending: false })
    .limit(500);
  if (error) return fail("internal_error", "Erro ao ler as atividades.", 500, { requestId });

  const ids = [...new Set(((data ?? []) as { contact_id: string | null }[]).map((a) => a.contact_id).filter(Boolean))] as string[];
  let nomes = new Map<string, string>();
  if (ids.length > 0) {
    const { data: contatos } = await supabase
      .from("contacts")
      .select("id, display_name, name")
      .eq("organization_id", authz.org.orgId)
      .in("id", ids);
    nomes = new Map(
      ((contatos ?? []) as { id: string; display_name: string | null; name: string | null }[]).map((c) => [
        c.id,
        c.display_name ?? c.name ?? "—",
      ]),
    );
  }

  const linhas = ((data ?? []) as Record<string, unknown>[]).map((a) => ({
    ...a,
    contato_nome: a.contact_id ? (nomes.get(a.contact_id as string) ?? "—") : null,
  }));
  return ok(linhas, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "commercial_activities" });
  if (!authz.ok) return authz.response;

  const parsed = atividadeCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("commercial_activities")
    .insert({
      organization_id: authz.org.orgId,
      contact_id: parsed.data.contact_id ?? null,
      tipo: parsed.data.tipo,
      resultado: parsed.data.resultado ?? null,
      observacao: parsed.data.observacao ?? null,
      user_id: authz.user.id,
      ocorrida_em: parsed.data.ocorrida_em ?? new Date().toISOString(),
    })
    .select(COLUNAS)
    .single();
  if (error || !data) return fail("internal_error", "Erro ao registrar a atividade.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "commercial_activity.created",
    resourceType: "commercial_activities",
    resourceId: (data as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId });
}
