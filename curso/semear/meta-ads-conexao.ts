/**
 * Semente do módulo "Meta Ads (conexão)": começa toda lição SEM conta de
 * anúncios ligada — o estado de uma instalação nova.
 *
 * As lições ligam a conta pela própria tela (token de exemplo; salvar não chama
 * a Meta) e a última desliga pelo botão "Desconectar". Esta limpeza garante o
 * ponto de partida mesmo se uma rodada parar no meio: uma conexão esquecida faria
 * a tela /app/ads/meta (módulo "Meta Ads") tentar ler a Meta com token falso.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  semErro(
    await c.db.from("ad_insights_connections").delete().eq("organization_id", c.org).eq("platform", "meta_ads"),
    "limpar conexão de leitura da Meta",
  );
}
