/**
 * O veredito EFETIVO de um candidato — o que a LEITURA deve mostrar (tela,
 * prévia, contador). Morada única: ninguém deriva "sem site" de segunda mão.
 *
 * `data.site` é o veredito GRAVADO. Quando ele não existe e a empresa não tem
 * `website`, o veredito é determinístico e não depende de rede: `sem-site`
 * (`vereditoPuro`). Sem esta derivação, as linhas sem `website` ficavam em
 * "A verificar" para sempre — medido na VPS em 15/10/2026: 113 candidatas, porque
 * o `select` do enriquecimento exige `website` não-nulo e elas nunca chegavam à
 * fase pura.
 *
 * Nada aqui grava no banco: quem persiste o veredito puro é a cura em lote do
 * botão "Verificar sites" (`site-enrich.ts`).
 *
 * Client-safe (sem `node:*`): a tela importa daqui, e `site-fetch.ts`
 * (server-only) reexporta os limites para não duplicar a régua.
 */
import { ehSemSite, vereditoPuro, type SiteEnrichment } from "@/lib/prospecting/site-classify";

/** O mínimo que a leitura precisa de um candidato (não amarra a `Prospect`). */
export interface DadosComSite {
  website: string | null;
  site?: SiteEnrichment | null;
}

/** Teto de reverificações de um veredito provisório antes de congelar. */
export const LIMITE_TENTATIVAS = 3;

// As 3 tentativas cobrem 1h (30min × 2 intervalos), não 3 minutos de queda de rede; domínio inexistente nem espera.
export const INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN = 30;

/** Verdadeiro enquanto um veredito provisório ainda aceita nova tentativa. */
export function deveReverificar(site: { provisorio: boolean; tentativas: number }): boolean {
  return site.provisorio && site.tentativas < LIMITE_TENTATIVAS;
}

/**
 * O veredito que a leitura usa: o gravado quando existe; o `sem-site` derivado
 * quando não há `website`; `null` quando ainda depende de rede (pendente de verdade).
 */
export function siteEfetivo(data: DadosComSite, agoraIso: string): SiteEnrichment | null {
  if (data.site) return data.site;
  if (ehSemSite(data.website)) return vereditoPuro(null, agoraIso);
  return null;
}

/**
 * Quem o botão "Verificar sites" ainda pode socorrer: site preenchido e ainda
 * sem veredito, ou provisório já elegível para nova rodada. O `sem-site`
 * derivado NÃO entra — não há rede a fazer, e contá-lo dava um número que nunca
 * zerava.
 */
export function precisaDeRede(data: DadosComSite, agoraIso: string): boolean {
  const gravado = data.site;
  if (!gravado) return !ehSemSite(data.website);
  if (!deveReverificar(gravado)) return false;
  const decorrido = Date.parse(agoraIso) - Date.parse(gravado.verificado_em);
  return decorrido >= INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN * 60_000;
}
