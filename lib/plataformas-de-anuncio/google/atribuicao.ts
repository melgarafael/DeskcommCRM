/**
 * Extrator + carimbo da atribuição de Google Ads — a partir do TEXTO da
 * mensagem, não de um payload de provider.
 *
 * Mora aqui, dentro da fronteira de `lib/plataformas-de-anuncio/` (a mesma
 * que `pnpm lint:channels` já allowlista para esta pasta, por causa de
 * `meta/conversions.ts`) — e não em `lib/channels/` nem em `lib/waha/`: os
 * extratores de lá leem a FORMA CRUA que cada transporte usa para o
 * `referral`/`contextInfo` da Meta; este lê o TEXTO já normalizado da
 * mensagem, que é o MESMO em qualquer transporte (API oficial ou QR).
 *
 * Faz DUAS coisas numa função só, ao contrário dos irmãos `extrairAtribuicaoX`
 * de `lib/channels/`/`lib/waha/` (puros, sem I/O): a extração PRECISA de uma
 * consulta ao banco — o token sozinho não diz nada, só o par com o `gclid`
 * guardado no clique (`./captura-de-clique.ts`) diz. Não dá para separar
 * "extrair" de "consultar" como os outros dois fazem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { casarClickRef } from "./captura-de-clique";

/**
 * `[ref:XXXXXX]` — colchetes e prefixo de propósito, para não casar por
 * acidente com seis caracteres que apareçam à toa no meio de uma mensagem
 * comum. O alfabeto (sem 0/O/1/I/L) espelha `captura-de-clique.ts`.
 */
const PADRAO_DO_TOKEN = /\[ref:([2-9A-HJ-NP-Z]{6})\]/;

/**
 * Melhor esforço: nunca lança, nunca derruba o inbound. Ausência de match é o
 * caminho NORMAL — a grande maioria das mensagens não veio de um anúncio do
 * Google — e só entra warn quando HÁ um token no texto e ele não casa, porque
 * aí o sinal é nosso e uma falha de match é sinal de bug, não de tráfego
 * orgânico.
 */
export async function extrairEEstamparAtribuicaoGoogle(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  texto: string | null,
): Promise<void> {
  if (!texto) return;
  const achado = PADRAO_DO_TOKEN.exec(texto);
  if (!achado) return;

  const token = achado[1];
  // Inalcançável na prática: o grupo de captura é obrigatório no padrão, e
  // `achado` só existe se o padrão inteiro casou. A guarda é só para o
  // `noUncheckedIndexedAccess` do tsconfig — não para um caso real.
  if (!token) return;
  const casado = await casarClickRef(admin, organizationId, token, contactId);
  if (!casado) {
    logger.warn("[plataformas-de-anuncio.google.atribuicao] token não casou", {
      organizationId,
      contactId,
    });
    return;
  }

  await estamparAtribuicaoDoContato(admin, organizationId, contactId, {
    plataforma: "google_ads",
    sourceId: casado.gclid,
    // Não há id de anúncio neste caminho, e não é lacuna a preencher depois: o
    // `gclid` é o clique, e o token de `[ref:XXXXXX]` não carrega peça criativa
    // nenhuma. Repetir o `gclid` aqui diria "o anúncio é este clique".
    adId: null,
    titulo: null,
    corpo: null,
    sourceUrl: null,
    bruto: { token },
  });
}
