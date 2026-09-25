/**
 * GET /api/v1/contacts/[id]/hierarquia-do-anuncio — o nome da campanha, do
 * conjunto e do anúncio de onde este contato veio.
 *
 * Rota separada, e não mais um campo no GET do contato, porque a latência é
 * outra: a ficha abre com o que já está no banco, e ESTE pedido pode esperar uma
 * chamada à plataforma. Pendurá-lo no contato faria a ficha inteira aguardar a
 * Meta responder — e ficar em branco quando ela não responde.
 *
 * Autoriza pelo client de SESSÃO (é a RLS de `contacts` que diz se esta pessoa
 * pode ver este contato) e só então usa o admin client, porque
 * `ad_hierarchy_cache` e `ad_insights_connections` têm RLS ligada com zero
 * policies. O mesmo desenho de `crm-summary`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { resolverHierarquiaDoContato } from "@/lib/plataformas-de-anuncio/hierarquia-do-contato";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** A resposta quando não há o que resolver — nunca um erro. */
const VAZIO = { ad_name: null, adset_name: null, campaign_name: null };

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const { data: contato, error: erroDoContato } = await supabase
    .from("contacts")
    .select("organization_id, source_metadata, is_anonymized")
    .eq("id", contactId)
    .maybeSingle();
  if (erroDoContato) return fail("internal_error", erroDoContato.message, 500, { requestId });
  if (!contato) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  // Contato anonimizado não ganha consulta nova à plataforma: a ficha dele
  // existe para provar o apagamento, não para enriquecer o cadastro.
  if (contato.is_anonymized) return ok(VAZIO, { requestId });

  const meta =
    contato.source_metadata && typeof contato.source_metadata === "object"
      ? (contato.source_metadata as Record<string, unknown>)
      : {};
  const adId = typeof meta.ad_id === "string" && meta.ad_id.trim() !== "" ? meta.ad_id.trim() : null;

  // Sem id de anúncio não há pergunta a fazer. 200 com nulos, e não 404: "este
  // contato não veio de anúncio" é uma resposta, não uma falha.
  if (!adId) return ok(VAZIO, { requestId });

  const h = await resolverHierarquiaDoContato(
    createAdminClient(),
    contato.organization_id,
    adId,
  );

  return ok(
    h
      ? { ad_name: h.adName, adset_name: h.adsetName, campaign_name: h.campaignName }
      : VAZIO,
    { requestId },
  );
}
