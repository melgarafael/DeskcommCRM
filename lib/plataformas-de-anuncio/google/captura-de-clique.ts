/**
 * O par token↔gclid: criado no clique da landing page, consumido quando a
 * mensagem do WhatsApp chega com o token no texto.
 *
 * Mora aqui — dentro de `lib/plataformas-de-anuncio/google/` — e não em
 * `lib/leads/`, porque o MECANISMO (código curto embutido no texto
 * pré-preenchido de um link `wa.me`) é específico do Google: a Meta não
 * precisa disso, o clique-para-WhatsApp dela chega com `ctwa_clid` nativo no
 * `referral`/`contextInfo`. Nomear "google" aqui é legítimo pela mesma razão
 * que `meta/conversions.ts` nomeia "meta" — esta pasta é a segunda fronteira
 * que `lib/plataformas-de-anuncio/types.ts` declara, e dentro dela nomear a
 * plataforma é o ponto, não a exceção.
 */
import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

// Sem 0/O/1/I/L: são os pares que mais se confundem ao reler — o token nunca é
// DIGITADO por um humano (vai pronto no link), mas é lido por humano quando
// alguém depura um clique perdido no log ou no banco.
const ALFABETO = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const TAMANHO_DO_TOKEN = 6;
const TENTATIVAS_MAXIMAS = 5;

function gerarToken(): string {
  let token = "";
  for (let i = 0; i < TAMANHO_DO_TOKEN; i++) {
    token += ALFABETO[randomInt(ALFABETO.length)];
  }
  return token;
}

export interface ClickRefCriado {
  token: string;
}

/**
 * Cria o par token↔gclid. Colisão é praticamente impossível (32^6 ≈ 1 bilhão
 * de combinações por organização), mas a tabela tem índice único em
 * `(organization_id, token)` e aqui se retenta em vez de deixar a landing
 * page quebrar por causa de um choque de 1 em 1 bilhão.
 */
export async function criarClickRef(
  admin: SupabaseClient,
  organizationId: string,
  gclid: string,
  queryRaw: Record<string, string>,
): Promise<ClickRefCriado | null> {
  for (let tentativa = 0; tentativa < TENTATIVAS_MAXIMAS; tentativa++) {
    const token = gerarToken();
    const { error } = await admin.from("google_ads_click_refs").insert({
      organization_id: organizationId,
      token,
      gclid,
      query_raw: queryRaw,
    });
    if (!error) return { token };
    // 23505 = unique_violation. Qualquer outro código não se resolve tentando
    // de novo com outro token — é falha de rede/schema, não de sorte.
    if (error.code !== "23505") {
      logger.error("[google-ads.captura-de-clique] insert falhou", {
        organizationId,
        codigo: error.code,
        detalhe: error.message,
      });
      return null;
    }
  }
  logger.error("[google-ads.captura-de-clique] esgotou tentativas de token único", {
    organizationId,
  });
  return null;
}

export interface ClickRefCasado {
  gclid: string;
}

/**
 * Casa um token com um contato — a UPDATE condicional que garante que um
 * clique só é consumido UMA vez. `matched_at is null` no WHERE é a trava:
 * duas mensagens com o mesmo token (replay, ou o mesmo texto reencaminhado)
 * só uma ganha a linha, e a segunda simplesmente não encontra o que atualizar.
 */
export async function casarClickRef(
  admin: SupabaseClient,
  organizationId: string,
  token: string,
  contactId: string,
): Promise<ClickRefCasado | null> {
  const { data, error } = await admin
    .from("google_ads_click_refs")
    .update({ matched_at: new Date().toISOString(), contact_id: contactId })
    .eq("organization_id", organizationId)
    .eq("token", token)
    .is("matched_at", null)
    .select("gclid")
    .maybeSingle();

  if (error) {
    logger.error("[google-ads.captura-de-clique] update de match falhou", {
      organizationId,
      codigo: error.code,
      detalhe: error.message,
    });
    return null;
  }
  if (!data) return null;
  return { gclid: (data as { gclid: string }).gclid };
}
