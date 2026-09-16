/**
 * O app OAuth do Google Ads desta INSTALAÇÃO — e o único lugar que monta o
 * endereço de retorno.
 *
 * Irmão declarado de `lib/agenda/google/config.ts`, com uma diferença
 * deliberada: aqui não existe camada de banco (`platform_google_oauth`),
 * env-only. A Agenda ganhou a tela de configuração (0201) porque o app OAuth
 * dela é editado por um humano depois da instalação, num fluxo que já existia
 * antes em `.env`. Aqui não há esse histórico — a instalação nasce com ou sem
 * as três variáveis, e é a MESMA decisão de design de antes da 0201: sem elas,
 * o botão "Conectar Google Ads" some e a tela explica o que falta, sem quebrar
 * o resto do produto.
 *
 * DECISÃO 3.1 (mesma da Agenda): `configuracaoDoGoogleAds()` devolve `null` em
 * vez de lançar. Quem chama decide o que fazer com a ausência.
 */

import { env } from "@/lib/env";

/** O caminho da rota de callback. Tem de estar registrado no console do Google. */
export const CAMINHO_DO_CALLBACK = "/api/v1/plataformas-de-anuncio/google/callback";

/** Os nomes das variáveis, para a tela poder dizer exatamente o que falta. */
export const VARIAVEIS_DO_GOOGLE_ADS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_OAUTH_CLIENT_ID",
  "GOOGLE_ADS_OAUTH_CLIENT_SECRET",
] as const;

export interface AppDoGoogleAdsConfigurado {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  /** Absoluto, e idêntico nos dois lados do fluxo — ver `lib/agenda/google/config.ts`. */
  redirectUri: string;
}

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Mesma regra de `enderecoDeRetorno` da Agenda: sem barra dupla, sem barra final. */
export function enderecoDeRetorno(urlDaAplicacao: string = env.NEXT_PUBLIC_APP_URL): string {
  const base = texto(urlDaAplicacao).replace(/\/+$/, "");
  return `${base}${CAMINHO_DO_CALLBACK}`;
}

/** A configuração em vigor, ou `null` quando a instalação não tem app OAuth de Ads. */
export function configuracaoDoGoogleAds(): AppDoGoogleAdsConfigurado | null {
  const clientId = texto(env.GOOGLE_ADS_OAUTH_CLIENT_ID);
  const clientSecret = texto(env.GOOGLE_ADS_OAUTH_CLIENT_SECRET);
  const developerToken = texto(env.GOOGLE_ADS_DEVELOPER_TOKEN);
  if (!clientId || !clientSecret || !developerToken) return null;
  return { clientId, clientSecret, developerToken, redirectUri: enderecoDeRetorno() };
}

/** Conectar o Google Ads está disponível nesta instalação? */
export function googleAdsEstaConfigurado(): boolean {
  return configuracaoDoGoogleAds() !== null;
}

/** O que falta, pelo nome — para a tela dizer em vez de só desabilitar o botão. */
export function faltaParaConectarOGoogleAds(): string[] {
  if (googleAdsEstaConfigurado()) return [];
  return VARIAVEIS_DO_GOOGLE_ADS.filter((nome) => !texto(env[nome]));
}
