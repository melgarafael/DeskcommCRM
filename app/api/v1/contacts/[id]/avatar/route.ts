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
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
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
 * organização da sessão, então um cache compartilhado (CDN, proxy) que
 * guardasse a resposta serviria o rosto de um contato para outro tenant.
 *
 * Tem que ser MENOR que SIGNED_TTL_SECONDS, senão o browser reusa um redirect
 * que aponta para uma assinatura já vencida e a foto some. A folga de 60s cobre
 * o caso de o redirect ser seguido no último instante da janela.
 */
const BROWSER_CACHE_SECONDS = 240;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail("no_active_org", "No active organization.", 403, { requestId });
  }

  const admin = createAdminClient();
  // Service role bypassa RLS: o filtro por organization_id é obrigatório e vem
  // da sessão, nunca do path (doutrina do CLAUDE.md).
  const { data: contato } = await admin
    .from("contacts")
    .select("avatar_storage_path, is_anonymized")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
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
  //
  // `Referrer-Policy: no-referrer` impede o browser de enviar cookies do
  // domínio da app ao seguir o redirect cross-origin para `supabase.co`. Sem
  // isso, o Storage responde `Access-Control-Allow-Origin: *` — incompatível
  // com credenciais pela spec CORS — e a foto é bloqueada (#CORS-storage). A
  // URL assinada já carrega autenticação própria (token JWT na query string).
  return new Response(null, {
    status: 307,
    headers: {
      Location: signed.signedUrl,
      "Cache-Control": `private, max-age=${BROWSER_CACHE_SECONDS}`,
      "Referrer-Policy": "no-referrer",
    },
  });
}
