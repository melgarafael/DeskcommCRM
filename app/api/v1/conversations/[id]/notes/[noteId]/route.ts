/**
 * DELETE /api/v1/conversations/[id]/notes/[noteId] — apaga uma nota interna.
 * Autor da nota OU manager+ pode apagar; qualquer outro agent recebe 403.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, noContent } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; noteId: string }>;
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversation_notes" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id, noteId } = await params;

  const supabase = await createClient();
  // Filtra também por conversation_id do path: a nota tem que pertencer À
  // conversa da URL (não só à org), senão o `[id]` seria decorativo e uma nota
  // poderia ser apagada via a URL de outra conversa.
  const { data: note } = await supabase
    .from("conversation_notes")
    .select("created_by_user_id")
    .eq("id", noteId)
    .eq("conversation_id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!note) return fail("not_found", "Nota não encontrada.", 404, { requestId });

  if (note.created_by_user_id !== user.id && ROLE_RANK[org.role] < ROLE_RANK.manager) {
    return fail("forbidden", "Só o autor ou manager+ pode apagar esta nota.", 403, { requestId });
  }

  const { data: deleted, error } = await supabase
    .from("conversation_notes")
    .delete()
    .eq("id", noteId)
    .eq("conversation_id", id)
    .eq("organization_id", org.orgId)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao excluir nota.", 500, { requestId });
  if (!deleted) return fail("not_found", "Nota não encontrada.", 404, { requestId });

  void audit({
    action: "conversation.note_deleted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "conversation_note",
    resourceId: deleted.id,
    requestId,
  });
  return noContent(requestId);
}
