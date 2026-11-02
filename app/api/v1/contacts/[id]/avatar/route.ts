/**
 * GET /api/v1/contacts/{id}/avatar — serve a foto de perfil do contato.
 *
 * O bucket `whatsapp-media` é PRIVADO, então a tela não pode apontar direto
 * para o objeto. Esta rota resolve o contato dentro da organização ativa,
 * assina uma URL curta e redireciona.
 *
 * Por que redirecionar em vez de devolver o binário: assim o browser baixa a
 * imagem direto do Storage e ela entra no cache dele — o app não vira proxy de
 * imagem em toda rolagem da lista de conversas.
 *
 * Contato anonimizado NUNCA devolve foto, mesmo que sobrasse arquivo: a
 * anonimização é irreversível por contrato, e uma rota de leitura não pode ser
 * a brecha que devolve o rosto de quem pediu remoção.
 *
 * ─── Dois modos de autenticação (#3420) ──────────────────────────────────────
 * A mesma dualidade das demais rotas de `/api/v1/*` (`lib/api/auth-dual.ts`):
 *
 *  a) Sessão do navegador (cookie) → `loadAuthUser` + `orgAtivaDaApi`, o
 *     caminho de SEMPRE desta rota, intocado por completo: a tela continua
 *     recebendo o mesmo 307, o mesmo `Cache-Control` e o mesmo 404.
 *  b) Cabeçalho `authorization` com um Bearer `dsk_…` de escopo
 *     `contacts:read` →
 *     `resolveAuthDual`, e a organização sai da LINHA DO TOKEN, nunca do path
 *     nem de query. Um Bearer de uma organização não alcança contato de outra.
 *     Token inválido/expirado fecha em 401; token válido sem `contacts:read`
 *     fecha em 403 — as mesmas recusas de todas as irmãs Dual.
 *
 * ⚠️ NÃO BASTA o handler: o `proxy.ts` roda ANTES de qualquer route handler e
 * só reconhece cookie de sessão. Sem a entrada de
 * `lib/auth/public-paths.ts` para `/api/v1/contacts/{id}/avatar`, todo Bearer
 * recebe 401 do proxy antes de chegar aqui e a porta (b) é inalcançável.
 * "Público" ali quer dizer "o proxy não decide", nunca "sem autenticação".
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { extractBearer } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Vida da URL assinada. Curta de propósito: se vazar, expira sozinha. */
const SIGNED_TTL_SECONDS = 300;

/**
 * Quanto o browser guarda o próprio redirect.
 *
 * Sem isto a lista de conversas refazia a rota inteira — sessão, organização
 * ativa, SELECT em `contacts` e `createSignedUrl` — uma vez por foto, a cada
 * render. Com 39 contatos com foto numa instalação pequena isso é ~3s de
 * trabalho de servidor por carga de lista, e o Realtime invalida a lista a cada
 * mensagem que chega.
 *
 * `private` é obrigatório e não é detalhe: a autorização desta rota é por
 * organização (a da sessão ou a da LINHA DO TOKEN), então um cache
 * compartilhado (CDN, proxy) que guardasse a resposta serviria o rosto de um
 * contato para outro tenant.
 *
 * Tem que ser MENOR que SIGNED_TTL_SECONDS, senão o browser reusa um redirect
 * que aponta para uma assinatura já vencida e a foto some. A folga de 60s cobre
 * o caso de o redirect ser seguido no último instante da janela.
 */
const BROWSER_CACHE_SECONDS = 240;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  // Porta (b) — servidor. Entra só quem mandou um Bearer no `authorization`:
  // o `resolveAuthDual` é o MESMO das demais rotas v1, e a organização vem da
  // LINHA DO TOKEN, nunca do path, então um token de uma organização não
  // alcança contato de outra. Sem Bearer, o ramo (a) de baixo roda intocado.
  let orgId: string;
  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "contacts",
      role: "viewer",
      scope: "contacts:read",
    });
    if (!authz.ok) return authz.response;
    // Esta rota está em PUBLIC_PATHS, logo não há estrangulamento a montante:
    // o que não for contado aqui não é contado em lugar nenhum. É o par
    // chamada + return que a varredura viva
    // (`tests/unit/rotas-bearer-aplicam-teto-de-escrita.test.ts`) cobra de
    // TODA rota que chama resolveAuthDual.
    const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
    if (teto) return teto;
    orgId = authz.organizationId;
  } else {
    // Porta (a) — navegador: loadAuthUser + organização ativa, o caminho de
    // SEMPRE desta rota, sem linha nova de comportamento.
    const authUser = await loadAuthUser();
    const ativa = await orgAtivaDaApi(authUser, requestId);
    if (!ativa.ok) return ativa.response;
    const activeOrg = ativa.org;
    if (!activeOrg) {
      return fail("no_active_org", "No active organization.", 403, { requestId });
    }
    orgId = activeOrg.orgId;
  }

  const admin = createAdminClient();
  // Service role bypassa RLS: o filtro por organization_id é obrigatório e vem
  // da sessão ou da LINHA DO TOKEN, nunca do path (doutrina do CLAUDE.md).
  const { data: contato } = await admin
    .from("contacts")
    .select("avatar_storage_path, is_anonymized")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();

  const row = contato as { avatar_storage_path?: string | null; is_anonymized?: boolean } | null;
  if (!row?.avatar_storage_path || row.is_anonymized) {
    // 404 e não erro: "sem foto" é o estado normal da maioria dos contatos, e o
    // <AvatarFallback> das iniciais assume sozinho.
    return new Response(null, { status: 404 });
  }

  const { data: signed, error } = await admin.storage
    .from("whatsapp-media")
    .createSignedUrl(row.avatar_storage_path, SIGNED_TTL_SECONDS);

  if (error || !signed?.signedUrl) {
    return new Response(null, { status: 404 });
  }

  // Response.redirect() devolve headers imutáveis — não dá pra anexar o
  // Cache-Control depois. Por isso o 307 é montado à mão.
  return new Response(null, {
    status: 307,
    headers: {
      Location: signed.signedUrl,
      "Cache-Control": `private, max-age=${BROWSER_CACHE_SECONDS}`,
    },
  });
}
