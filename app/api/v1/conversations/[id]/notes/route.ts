import { requireSupportWrite } from "@/lib/impersonate/support";
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
import {
  idsDeMencaoEstrutural,
  mencaoAtingeUsuario,
  textoLegivelDeMencao,
  tokensDeMencao,
} from "@/lib/notifications/mentions";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { createNoteSchema } from "@/lib/schemas/notes";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
// As três colunas de anexo (migration 0483) entram nos DOIS caminhos: sem elas
// no SELECT o card da nota devolveria `undefined` em vez de `null` e o renderer
// ligaria o anexo com um path inexistente.
const COLS =
  "id, conversation_id, body, created_by_user_id, created_by_name, created_at, media_storage_path, media_mime, media_size_bytes";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversation_notes" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conversation) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

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
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversation_notes" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conversation) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const raw = await req.json().catch(() => null);
  const parsed = createNoteSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  // `anexo` é o trio que a rota de upload acabou de devolver. Ele NÃO é
  // validado de novo aqui (mime/tamanho são da allowlist do upload, que já
  // rodou com o arquivo na mão) — só a forma, pelo schema. `isMediaPathOwnedBy`
  // é o corte de posse: um path fora de {org}/{conversa}/ não pode virar anexo
  // de uma conversa que não é dele, nem que o cliente tenha agent.
  const anexo = parsed.data.anexo;
  if (anexo && !isMediaPathOwnedBy(anexo.storage_path, org.orgId, id)) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: { anexo: ["anexo fora desta conversa."] },
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
      ...(anexo
        ? {
            media_storage_path: anexo.storage_path,
            media_mime: anexo.media_mime,
            media_size_bytes: anexo.media_size_bytes,
          }
        : {}),
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
  void emitirMencoesDaNota({
    organizationId: org.orgId,
    conversationId: id,
    body: parsed.data.body,
    fromUserId: user.id,
  });
  return ok(data, { requestId, status: 201 });
}

async function emitirMencoesDaNota(input: {
  organizationId: string;
  conversationId: string;
  body: string;
  fromUserId: string;
}): Promise<void> {
  // DOIS caminhos, e a ordem deles importa: o ESTRUTURAL (gravado pelo
  // autocompletar da #2372) carrega o id no corpo, então não depende de
  // nome nenhum; o textual legado continua de pé para nota escrita à mão.
  const estruturais = new Set(idsDeMencaoEstrutural(input.body));
  const textuais = tokensDeMencao(input.body);
  if (estruturais.size === 0 && textuais.length === 0) return;
  const admin = createAdminClient();
  const { data: members } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", input.organizationId)
    .is("revoked_at", null);
  const ids = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id).filter((id) => id !== input.fromUserId);
  // Legível ANTES de cortar: cortar o corpo cru poderia deixar meio token solto
  // (`…(mencao:2f9c`) e a tela mostraria o escombro dele.
  const preview = textoLegivelDeMencao(input.body.trim()).slice(0, 140);

  const emitir = (userId: string) =>
    admin.rpc("emit_event", {
      p_event_type: "user.mentioned",
      p_entity_kind: "conversation_note",
      p_entity_id: input.conversationId,
      p_payload: {
        conversation_id: input.conversationId,
        to_user_id: userId,
        from_user_id: input.fromUserId,
        body_preview: preview,
      },
      p_metadata: {},
      p_organization_id: input.organizationId,
    });

  await Promise.all(
    ids.map(async (userId) => {
      // Estrutural: `userId` já veio da membership desta org, então o id no
      // corpo só pode ser de alguém daqui — sem ida ao auth, sem olhar nome
      // ou e-mail. É o caminho que notifica a PESSOA ESCOLHIDA e mais ninguém.
      if (estruturais.has(userId.toLowerCase())) {
        await emitir(userId);
        return;
      }
      if (textuais.length === 0) return;
      const { data: userRes } = await admin.auth.admin.getUserById(userId);
      const u = userRes?.user;
      if (!u?.email) return;
      const fullName =
        (typeof u.user_metadata?.full_name === "string" ? u.user_metadata.full_name : null) ?? null;
      if (!mencaoAtingeUsuario(input.body, { id: userId, email: u.email, full_name: fullName })) return;
      await emitir(userId);
    }),
  );
}
