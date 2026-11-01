import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { atualizarFontesDoServico } from "@/lib/agenda/servicos/consulta";
import { rpcDoServico } from "@/lib/agenda/servicos/escrita";
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";

/** A atualização é uma ação explícita. Viewer continua lendo sem efeitos. */
export async function POST(req: NextRequest) {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, { requestId, resource: "agenda", role: "agent", scope: "mcp:write" });
  if (!auth.ok) return auth.response;
  const ceiling = await tetoDeEscritaDoToken(auth, "agenda", requestId); if (ceiling) return ceiling;
  const t = (s: string) => traduzir(s, auth.idioma ?? "pt-BR");
  const body = z.object({ event_type_id: z.uuid() }).strict().safeParse(await req.json().catch(() => null));
  if (!body.success) return fail("validation_failed", t("Consulta inválida."), 422, { requestId });
  const db = createAdminClient(); const ctx = { organization_id: auth.organizationId, actor: auth.actor, requestId };
  try {
    // Revalidar ator atual antes de qualquer rede. Não aceitar ator/org do body.
    await rpcDoServico(db, ctx, "fn_calendar_service_assert_actor", { p_role: "agent" });
    const result = await atualizarFontesDoServico(db, ctx.organization_id, body.data.event_type_id);
    await audit({ action: "agenda.service_refresh", actorUserId: auth.actor.type === "user" ? auth.actor.id : null,
      actorApiTokenId: auth.apiTokenId ?? null, organizationId: ctx.organization_id, requestId, metadata: { complete: result.complete } });
    return ok(result, { requestId });
  } catch (e) {
    if (e instanceof ApiError) return fail(e.code, t(e.message), e.status, { requestId });
    return fail("internal_error", t("Não foi possível atualizar as fontes. O horário continua sem confirmação de disponibilidade."), 500, { requestId });
  }
}
