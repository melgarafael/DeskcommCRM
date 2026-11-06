/**
 * GET /api/v1/conversations — list inbox (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import type { Actor } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { extractBearer } from "@/lib/mcp/auth";
import { moduloSemContato, redigirContatoParaModulo } from "@/lib/modulo/redigir-contato";
import { listConversationsQuerySchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { comNomeDoAtendente } from "@/lib/users/com-nome-do-atendente";

import { listConversationsHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Token de integração (Spec 33, R2): o handler abaixo já filtra
  // `organization_id` em toda consulta e é o mesmo que as tools MCP usam.
  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "conversations",
      role: "viewer",
      scope: "mcp:read",
      tokenRole: "agent",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "conversations", requestId);
    if (teto) return teto;
    return responderLista(
      authz.supabase,
      authz.organizationId,
      authz.actor,
      authz.idioma,
      req,
      requestId,
      authz,
    );
  }

  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) {
    return fail("no_active_org", t("No active organization."), 403, { requestId });
  }

  return responderLista(
    supabase,
    activeOrg.orgId,
    { type: "user", id: user.id },
    authUser?.idioma,
    req,
    requestId,
  );
}

async function responderLista(
  supabase: SupabaseClient,
  organizationId: string,
  actor: Actor,
  idioma: Idioma | undefined,
  req: NextRequest,
  requestId: string,
  /** Só no caminho do token: diz se é módulo e se ele pode ver contato (Spec 33, F3). */
  quemChama?: { actor: { type: string }; contatoVisivel?: boolean },
): Promise<Response> {
  const t = (texto: string) => traduzir(texto, idioma ?? "pt-BR");
  const url = new URL(req.url);
  // Busca por texto casa com nome/telefone do contato: sem a área `contatos`, ela viraria um oráculo
  // ("tem alguém chamada Ana?"). O módulo sem contatos não filtra por contato nem por texto.
  if (
    quemChama &&
    moduloSemContato(quemChama) &&
    (url.searchParams.get("search") || url.searchParams.get("contact_id"))
  ) {
    return fail(
      "module_area_not_granted",
      t("Este módulo não tem permissão para esta área da organização."),
      403,
      { requestId },
    );
  }
  const qsParsed = listConversationsQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    exclude_finished: url.searchParams.get("exclude_finished") === "true" ? true : undefined,
    closed_since: url.searchParams.get("closed_since") ?? undefined,
    assigned_to: url.searchParams.get("assigned_to") ?? undefined,
    // QUEM MANDA na conversa (migration 0203) — o filtro das abas Fila e
    // Automático. Faltar aqui é a MESMA rotura que o `tag` teve logo abaixo: o
    // schema aceita, o hook serializa, o handler implementa, e esta linha não lê
    // — a lista volta INTEIRA, sem erro nenhum. Como o badge vem de OUTRA rota
    // (que leu o filtro certo), a tela chega a se contradizer sozinha: medido no
    // CI em 2026-08-31, a aba dizia "Fila 1" e listava 5 conversas embaixo.
    // Agora `tests/unit/rota-le-todo-filtro-do-schema.test.ts` reprova o próximo
    // esquecimento, em vez de este comentário pedir atenção.
    comando: url.searchParams.get("comando") ?? undefined,
    // O `tag` era o único param que o schema aceitava, o hook serializava e o
    // handler implementava — e que esta linha não lia. A cadeia rompia AQUI, no
    // meio: `InboxFilters` mostra o select "Filtrar por tag" sempre que a org tem
    // vocabulário, o browser manda `?tag=vip`, e a lista voltava inteira, sem erro.
    // Achado por @jmpo, no cabeçalho do teste que ele escreveu no PR #199.
    //
    // ⚠️ `getAll`, e não `get` (#1274): o filtro passou a aceitar VÁRIAS
    // etiquetas, e a repetição na URL (`?tag=vip&tag=orçamento`) só existe para o
    // `getAll`. Um `get` aqui leria só a PRIMEIRA e a tela mostraria uma escolha
    // que a lista ignora — que é a MESMA classe de rotura silenciosa que a linha
    // de cima documenta, e por isso a cerca `rota-le-todo-filtro-do-schema` cobre
    // este filtro com a mesma regra.
    tag: url.searchParams.getAll("tag"),
    modo: url.searchParams.get("modo") ?? undefined,
    unread: url.searchParams.get("unread") ?? undefined,
    channel_session_id: url.searchParams.get("channel_session_id") ?? undefined,
    // A aba "Grupos" (Task 10) — mesma rotura que `tag`/`comando` já tiveram
    // aqui: schema aceita, hook serializa, handler filtra, e esta linha é o
    // único lugar que pode esquecer sem erro nenhum. `rota-le-todo-filtro-do-schema`
    // cobra a chave.
    is_group: url.searchParams.get("is_group") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    // A cerca `rota-le-todo-filtro-do-schema` cobra a chave: schema aceita,
    // rota lê, handler filtra. Esquecer aqui é invisível para todo gate de tipo.
    contact_id: url.searchParams.get("contact_id") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!qsParsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: qsParsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  try {
    const { conversations, cursor, has_more } = await listConversationsHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
      },
      qsParsed.data,
    );
    // O nome de quem atende entra AQUI, na borda HTTP, e não no handler: o
    // handler é compartilhado com as tools MCP, que já resolvem o nome por conta
    // própria (`lib/mcp/tools/conversations.ts`) — enriquecer lá faria a mesma
    // leitura duas vezes por chamada do agente.
    const comAtendente = await comNomeDoAtendente(organizationId, conversations);
    return ok(quemChama ? redigirContatoParaModulo(quemChama, comAtendente) : comAtendente, {
      requestId,
      meta: { cursor, has_more },
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
