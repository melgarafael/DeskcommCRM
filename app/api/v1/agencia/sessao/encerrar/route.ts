import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { invalidarSessao, invalidarUsuario, sessaoDosCookies } from "@/lib/auth/cache-curto";
/** Encerrar depende da posse da sessão, inclusive depois da revogação. */
export async function POST() {
  const requestId = randomUUID();
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", "Entre novamente.", 401, { requestId });
  const { data, error } = await db.rpc("fn_agencia_encerrar_sessao");
  if (error)
    return fail("upstream_unavailable", "Não foi possível encerrar o acesso ao cliente.", 503, {
      requestId,
    });
  const store = await cookies();
  // O contexto positivo também precisa cair antes da volta à agência. A
  // invalidação por usuário atravessa os runtimes da rota e da página; a chave
  // da sessão fecha a entrada específica quando ela estiver disponível.
  invalidarUsuario(user.id);
  const sessaoAtual = sessaoDosCookies(store.getAll());
  if (sessaoAtual) invalidarSessao(sessaoAtual.chave);
  if (data?.id) {
    store.set("active_org", data.agencia_id, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    await audit({
      action: "agency.session_ended",
      actorUserId: user.id,
      organizationId: data.organization_id,
      resourceType: "organization",
      resourceId: data.organization_id,
      requestId,
      metadata: { agency_id: data.agencia_id, session_id: data.id },
    });
  }
  return ok({ redirect_url: "/app/settings/organizacoes" }, { requestId });
}
