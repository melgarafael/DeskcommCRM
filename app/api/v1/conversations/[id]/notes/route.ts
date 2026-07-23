/**
 * GET  /api/v1/conversations/[id]/notes — lista notas internas da conversa (nunca vai ao WhatsApp).
 * POST /api/v1/conversations/[id]/notes — cria nota interna (autor = user.id, org de authz).
 *
 * Ambos confirmam antes que a conversa pertence à org ativa (`.select("id").maybeSingle()`)
 * pra devolver 404 honesto em vez de vazar existência cross-org.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createNoteSchema } from "@/lib/schemas/notes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const COLS = "id, conversation_id, body, created_by_user_id, created_by_name, created_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversation_notes" });
  if (!authz.ok) return authz.response;
  const { org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conversation) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const { data, error } = await supabase
    .from("conversation_notes")
    .select(COLS)
    .eq("conversation_id", id)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: true });
  if (error) return fail("internal_error", "Erro ao listar notas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversation_notes" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conversation) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const raw = await req.json().catch(() => null);
  const parsed = createNoteSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const { data, error } = await supabase
    .from("conversation_notes")
    .insert({
      organization_id: org.orgId,
      conversation_id: id,
      body: parsed.data.body,
      created_by_user_id: user.id,
      created_by_name: user.full_name ?? null,
    })
    .select(COLS)
    .single();
  if (error || !data) return fail("internal_error", "Erro ao criar nota.", 500, { requestId });

  void audit({
    action: "conversation.note_added",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "conversation_note",
    resourceId: data.id,
    requestId,
    metadata: { conversation_id: id },
  });
  return ok(data, { requestId, status: 201 });
}
