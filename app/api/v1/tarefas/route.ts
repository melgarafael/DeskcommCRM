/**
 * GET  /api/v1/tarefas — lista com filtro por status (leitura: viewer+).
 * POST /api/v1/tarefas — agenda (escrita: agent+).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DA_TAREFA, STATUS_TAREFA, tarefaCreateSchema } from "@/lib/schemas/tarefas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_tasks" });
  if (!authz.ok) return authz.response;

  const status = req.nextUrl.searchParams.get("status")?.trim() ?? "";
  if (status !== "" && !(STATUS_TAREFA as readonly string[]).includes(status)) {
    return fail("validation_failed", "status aceita: pendente, concluida, cancelada.", 422, { requestId });
  }

  const supabase = await createClient();
  let q = supabase
    .from("commercial_tasks")
    .select(COLUNAS_DA_TAREFA)
    .eq("organization_id", authz.org.orgId)
    .order("agendada_para", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return fail("internal_error", "Erro ao ler as tarefas.", 500, { requestId });

  const ids = [...new Set(((data ?? []) as unknown as { contact_id: string | null }[]).map((t) => t.contact_id).filter(Boolean))] as string[];
  let nomes = new Map<string, string>();
  if (ids.length > 0) {
    const { data: contatos } = await supabase
      .from("contacts")
      .select("id, display_name, name")
      .eq("organization_id", authz.org.orgId)
      .in("id", ids);
    nomes = new Map(
      ((contatos ?? []) as unknown as { id: string; display_name: string | null; name: string | null }[]).map((c) => [
        c.id,
        c.display_name ?? c.name ?? "—",
      ]),
    );
  }

  const linhas = ((data ?? []) as unknown as Record<string, unknown>[]).map((t) => ({
    ...t,
    contato_nome: t.contact_id ? (nomes.get(t.contact_id as string) ?? "—") : null,
  }));
  return ok(linhas, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "commercial_tasks" });
  if (!authz.ok) return authz.response;

  const parsed = tarefaCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("commercial_tasks")
    .insert({
      organization_id: authz.org.orgId,
      titulo: parsed.data.titulo,
      descricao: parsed.data.descricao ?? null,
      tipo: parsed.data.tipo,
      contact_id: parsed.data.contact_id ?? null,
      responsavel_user_id: parsed.data.responsavel_user_id ?? authz.user.id,
      agendada_para: parsed.data.agendada_para ?? null,
      created_by: authz.user.id,
    })
    .select(COLUNAS_DA_TAREFA)
    .single();
  if (error || !data) return fail("internal_error", "Erro ao criar a tarefa.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "commercial_task.created",
    resourceType: "commercial_tasks",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId });
}
