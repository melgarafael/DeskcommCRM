/**
 * GET /api/v1/voice/calls/history — histórico de chamadas da organização.
 *
 * Lê de `voice_calls` (a NOSSA cópia, sincronizada pela ponte de eventos do
 * worker — §4.2 da spec), não faz proxy pro `/history` do WaCalls: nossa
 * tabela já tem `contact_id`/`end_reason` que o upstream não devolve.
 */
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { requireRole } from "@/lib/auth/require-role";
import { extractBearer } from "@/lib/mcp/auth";
import { createClient } from "@/lib/supabase/server";
import { idsDeContatosPessoais } from "@/app/api/v1/conversations/_handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // DOIS PORTÕES, UM CORPO (Spec 33, R3). O token `dsk_…` (escopo `mcp:read`,
  // papel agent) entra por `resolveAuthDual`; a sessão segue pelo `requireRole`
  // de sempre. A organização vem da linha do token ou da sessão, nunca do path.
  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "voice_calls",
      role: "agent",
      scope: "mcp:read",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "voice_calls", requestId);
    if (teto) return teto;
    return responderHistory(authz.supabase, authz.organizationId, req, requestId);
  }

  const authz = await requireRole("agent", { requestId, resource: "voice_calls" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const supabase = await createClient();
  return responderHistory(supabase, activeOrg.orgId, req, requestId);
}

async function responderHistory(
  db: SupabaseClient,
  organizationId: string,
  req: NextRequest,
  requestId: string,
): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50") || 50, 200);
  // `id`: o painel de chamada confere UMA ligação com o servidor. Procurá-la
  // entre as N mais recentes da organização falhava em escritório movimentado.
  const id = searchParams.get("id");
  if (id !== null && !z.string().uuid().safeParse(id).success) {
    return fail("invalid_request", "id precisa ser um uuid.", 400, { requestId });
  }

  let consulta = db
    .from("voice_calls")
    .select(
      "id, contact_id, direction, peer_phone, status, end_reason, started_at, answered_at, ended_at, duration_ms, owner_user_id, created_by",
    )
    .eq("organization_id", organizationId);
  // Chamada de pessoal some do histórico e só volta ao desmarcar (spec 21,
  // etapa 14) — a mesma primitiva de ids da lista do inbox. Bloqueado continua
  // aparecendo (recusada); por isso o filtro é só de pessoal.
  const pessoais = await idsDeContatosPessoais(db, organizationId);
  if (pessoais.length > 0) {
    consulta = consulta.not("contact_id", "in", `(${pessoais.join(",")})`);
  }
  if (id) consulta = consulta.eq("id", id);
  const { data, error } = await consulta.order("started_at", { ascending: false }).limit(limit);

  // ERRO NÃO É LISTA VAZIA.
  //
  // `ok([])` fazia "a consulta falhou" ficar indistinguível de "esta
  // organização nunca ligou para ninguém" — e a segunda frase é a que a tela
  // conta. Além de esconder a falha, é o desfecho que convida alguém a concluir
  // que o histórico se perdeu. Falhar ABERTO na informação, sempre.
  if (error) {
    logger.error("voice: histórico de chamadas falhou", {
      request_id: requestId,
      organization_id: organizationId,
      error: error.message,
    });
    return fail("internal_error", error.message, 500, { requestId });
  }
  return ok(data ?? [], { requestId, meta: { has_more: (data?.length ?? 0) === limit } });
}
