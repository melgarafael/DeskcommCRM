/**
 * A hierarquia do anúncio DE UM CONTATO — cache primeiro, plataforma depois.
 *
 * ─── Por que isto NÃO roda na ingestão ──────────────────────────────────────
 *
 * A restrição é explícita no domínio, e está escrita nos dois extratores:
 * falha de atribuição não pode derrubar a entrada da mensagem, porque devolver
 * erro ao provider faz ele REENVIAR. Uma chamada de rede à plataforma no caminho
 * quente da ingestão trocaria um rótulo faltando por uma tempestade de
 * reentregas — e a plataforma cobra cota por chamada, então a tempestade sairia
 * cara duas vezes.
 *
 * Então se resolve quando alguém ABRE a ficha: é o único momento em que o nome
 * do anúncio serve para alguma coisa, e é quando a lentidão tem dono olhando.
 *
 * ─── O que esta função promete, e o que ela nunca faz ───────────────────────
 *
 * Nunca lança e nunca propaga falha. Devolve o que conseguir — inclusive uma
 * linha VENCIDA do cache quando a plataforma recusa a releitura. Um nome de
 * campanha de uma semana atrás responde à pergunta do operador; um erro na
 * ficha do contato não responde nada, e a ficha inteira não pode quebrar porque
 * a Meta está fora do ar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { lerCredencialDeLeitura } from "./credenciais-de-leitura";
import {
  lerHierarquiaDoAnuncio,
  type HierarquiaDoAnuncio,
} from "./meta/hierarquia-do-anuncio";

/**
 * Quanto tempo um nome guardado ainda vale.
 *
 * Sete dias, e o número sai da assimetria entre os dois erros. Renomear anúncio
 * é raro — quem faz mídia cria peça nova em vez de reescrever a que já tem
 * histórico. Errar para o lado de reperguntar custa COTA, que é o recurso
 * escasso desta conta (`development_access`, medido); errar para o lado de
 * esperar custa um nome desatualizado numa ficha, que o operador reconhece.
 *
 * ponytail: prazo único para toda organização. Se uma conta de cota alta quiser
 * frescor maior, isto vira coluna da conexão de leitura — não constante nova.
 */
const IDADE_MAXIMA_MS = 7 * 24 * 60 * 60 * 1000;

const PLATAFORMA = "meta_ads";

interface LinhaDoCache {
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  fetched_at: string;
}

function daLinha(adId: string, linha: LinhaDoCache): HierarquiaDoAnuncio {
  return {
    adId,
    adName: linha.ad_name,
    adsetId: linha.adset_id,
    adsetName: linha.adset_name,
    campaignId: linha.campaign_id,
    campaignName: linha.campaign_name,
  };
}

/**
 * ⚠️ EXIGE O ADMIN CLIENT e SEMPRE com `organization_id` no filtro.
 *
 * `ad_hierarchy_cache` tem RLS ligada e zero policies (0380) — pelo client de
 * sessão isto não devolve nada. E o id do anúncio é da PLATAFORMA: duas
 * organizações podem alcançar a mesma conta, então ler sem a organização
 * mostraria, na ficha de uma, o nome que a outra deu ao anúncio.
 */
export async function resolverHierarquiaDoContato(
  admin: SupabaseClient,
  organizationId: string,
  adId: string,
): Promise<HierarquiaDoAnuncio | null> {
  const { data, error } = await admin
    .from("ad_hierarchy_cache")
    .select("ad_name, adset_id, adset_name, campaign_id, campaign_name, fetched_at")
    .eq("organization_id", organizationId)
    .eq("platform", PLATAFORMA)
    .eq("ad_id", adId)
    .maybeSingle();

  // O erro NÃO é descartado: um cache que falha em silêncio vira uma chamada à
  // plataforma por abertura de ficha, que é exatamente o que o cache existe para
  // impedir — e o sintoma seria a cota acabando sem causa visível.
  if (error) {
    logger.error("[ads.hierarquia-do-contato] leitura do cache falhou", {
      organizationId,
      ad_id: adId,
      error: error.message.slice(0, 200),
    });
  }

  const guardada = (data as LinhaDoCache | null) ?? null;
  if (guardada) {
    const idade = Date.now() - new Date(guardada.fetched_at).getTime();
    if (idade < IDADE_MAXIMA_MS) return daLinha(adId, guardada);
  }

  const credencial = await lerCredencialDeLeitura(admin, organizationId, PLATAFORMA);
  // Sem conexão de leitura não há a quem perguntar. A linha vencida ainda serve:
  // o nome de antes é melhor resposta do que nenhuma.
  if (!credencial.ok) return guardada ? daLinha(adId, guardada) : null;

  const leitura = await lerHierarquiaDoAnuncio(credencial.credencial.accessToken, adId);
  if (!leitura.ok) {
    logger.warn("[ads.hierarquia-do-contato] releitura recusada", {
      organizationId,
      ad_id: adId,
      falha: leitura.falha,
    });
    // Inclusive em `limite_de_chamadas`: cota é espera, não ausência. Gravar um
    // vazio aqui faria a ficha mentir para sempre sobre um anúncio que está no ar.
    return guardada ? daLinha(adId, guardada) : null;
  }

  const h = leitura.dados;
  const { error: erroDeEscrita } = await admin.from("ad_hierarchy_cache").upsert(
    {
      organization_id: organizationId,
      platform: PLATAFORMA,
      ad_id: adId,
      ad_name: h.adName,
      adset_id: h.adsetId,
      adset_name: h.adsetName,
      campaign_id: h.campaignId,
      campaign_name: h.campaignName,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,platform,ad_id" },
  );

  // A escrita falhar não estraga ESTA resposta — o nome já está em mãos. Estraga
  // a PRÓXIMA, que gastará cota de novo, e por isso o erro precisa aparecer.
  if (erroDeEscrita) {
    logger.error("[ads.hierarquia-do-contato] gravação do cache falhou", {
      organizationId,
      ad_id: adId,
      error: erroDeEscrita.message.slice(0, 200),
    });
  }

  return h;
}
