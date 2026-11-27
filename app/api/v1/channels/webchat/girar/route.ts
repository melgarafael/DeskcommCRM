import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { acharConexaoDoChat, novaChaveDoChat } from "@/lib/channels/webchat/conexao";
import { chatNoSiteLigado } from "@/lib/channels/webchat/modulo";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/v1/channels/webchat/girar — troca a chave pública do chat no site.
 *
 * A chave antiga para de valer no mesmo UPDATE: o widget que ainda a usa recebe 404 ao abrir
 * uma conversa nova (`/sessao`) até o site do cliente receber o código novo. Quem já tem token
 * emitido segue conversando até ele expirar (30 dias): o token vale pelo id da conexão, não pela
 * chave. Por isso a tela da F2 pede confirmação antes.
 * A resposta traz a chave nova (única vez em que ela sai da rota além da leitura de quem
 * administra); a auditoria guarda só o id da conexão.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_webchat" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  if (!(await chatNoSiteLigado(admin, orgId))) return fail("not_found", "Not found", 404, { requestId });

  let conexao;
  try {
    conexao = await acharConexaoDoChat(admin, orgId);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "lookup_failed", 500, { requestId });
  }
  if (!conexao) return fail("not_found", "Not found", 404, { requestId });

  const chave = novaChaveDoChat();
  const { error } = await admin
    .from("channel_sessions")
    .update({ webchat_public_key: chave })
    .eq("id", conexao.id)
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .select("id")
    .single();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "channel.webchat_key_rotated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: conexao.id,
    requestId,
    metadata: { canal: "webchat" },
  });

  return ok({ id: conexao.id, public_key: chave }, { requestId });
}
