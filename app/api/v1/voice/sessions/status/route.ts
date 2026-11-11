/**
 * GET /api/v1/voice/sessions/status — estado do pareamento de chamada de voz
 * da organização ativa. Usado pelo discador (§5.1 da spec) pra decidir se
 * mostra o botão "Ligar".
 */
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import { comIdDaRequisicao, ok } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { extractBearer } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // DOIS PORTÕES, UM CORPO (Spec 33, R3). O token `dsk_…` (escopo `mcp:read`,
  // papel membro) entra por `resolveAuthDual`; a sessão segue por
  // `loadAuthUser` + `orgAtivaDaApi` de sempre. A organização vem da linha do
  // token ou da sessão, nunca do path.
  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "channel_sessions",
      role: "viewer",
      scope: "mcp:read",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "channel_sessions", requestId);
    if (teto) return teto;
    return responderStatus(authz.supabase, authz.organizationId, requestId);
  }

  const user = await loadAuthUser();
  if (!user) return comIdDaRequisicao(new Response(null, { status: 401 }), requestId);
  const ativa = await orgAtivaDaApi(user, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) return comIdDaRequisicao(new Response(null, { status: 403 }), requestId);

  const supabase = await createClient();
  return responderStatus(supabase, activeOrg.orgId, requestId);
}

async function responderStatus(
  db: SupabaseClient,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const { data } = await db
    .from("channel_sessions")
    .select("id, status, wacalls_jid, wacalls_paired_at")
    .eq("organization_id", organizationId)
    .eq("provider", "wacalls")
    .is("archived_at", null)
    .maybeSingle();

  const row = data as {
    id: string;
    status: string;
    wacalls_jid: string | null;
    wacalls_paired_at: string | null;
  } | null;

  return ok(
    {
      configured: !!row,
      channelSessionId: row?.id ?? null,
      status: row?.status ?? null,
      paired: !!row?.wacalls_paired_at,
      jid: row?.wacalls_jid ?? null,
    },
    { requestId },
  );
}
