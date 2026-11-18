/**
 * Os links que a busca achou → as chaves `link_<tipo>` da ficha do contato (Spec 26).
 *
 * `linksDoCandidato` é função pura: lê só o `data` do candidato, sem rede. A ordem
 * das regras é a da tabela da §3.1 da spec. O ponto que mais importa é o `website`:
 * ele vem poluído da busca (Instagram, agregador, site próprio), então copiá-lo
 * direto para "Site" colocaria rede social no lugar do site da empresa. Por isso o
 * host é olhado antes.
 *
 * `completarLinksDoContato` é o SQL atômico da §3.3: acrescenta só o link que falta e
 * nunca toca no que a pessoa já digitou. Um `update` só, sem ler o contato antes, para
 * não apagar uma edição humana feita no meio (o PATCH de contato substitui o
 * `custom_fields` inteiro).
 */
import type pg from "pg";

import { aplicarLinks, normalizarLink, type LinksDoContato } from "@/lib/leads/links-de-contato";
import { DOMINIOS_DE_REDE, ehAgregador, hostDeSite } from "./site-classify";
import type { Prospect } from "./schema";

/** Os campos do candidato que viram link. Qualquer um pode vir ausente ou nulo. */
export type DadosDeLinkDoCandidato =
  | Partial<Pick<Prospect, "website" | "socials" | "maps_url">>
  | null
  | undefined;

/** Rede social reconhecida pelo host: a que `socials[]` e `website` podem preencher. */
type TipoDeRede = (typeof DOMINIOS_DE_REDE)[number][1];

/** Host que é a rede (ou subdomínio dela), ou null. Mesma régua de `ehAgregador`. */
function redeDoHost(host: string): TipoDeRede | null {
  for (const [dominio, rede] of DOMINIOS_DE_REDE) {
    if (host === dominio || host.endsWith(`.${dominio}`)) return rede;
  }
  return null;
}

/**
 * Monta os links do candidato. Nunca lança: entrada incompleta ou nula devolve o que
 * houver (talvez `{}`). Todo valor passa por `normalizarLink`, e o que ele recusa não entra.
 */
export function linksDoCandidato(data: DadosDeLinkDoCandidato): LinksDoContato {
  const links: LinksDoContato = {};

  // (a) socials[]: o primeiro endereço de cada rede reconhecida pelo host.
  const socialsBruto: unknown = data?.socials;
  const socials: unknown[] = Array.isArray(socialsBruto) ? socialsBruto : [];
  for (const bruto of socials) {
    const href = normalizarLink(typeof bruto === "string" ? bruto : null);
    const host = hostDeSite(href);
    const rede = host ? redeDoHost(host) : null;
    if (href && rede && !links[rede]) links[rede] = href;
  }

  // (b) website: testado DEPOIS de socials. Se a rede já veio de socials, ela vence e o
  // website não vira nada. Agregador que não é rede vai para "Outro"; o resto é "Site".
  // Endereço sem host não é endereço: não vira nada.
  const site = normalizarLink(data?.website);
  const hostDoSite = hostDeSite(site);
  if (site && hostDoSite) {
    const rede = redeDoHost(hostDoSite);
    if (rede) {
      if (!links[rede]) links[rede] = site;
    } else if (ehAgregador(site)) {
      links.outro = site;
    } else {
      links.site = site;
    }
  }

  // (c) maps_url: o link do Google Meu Negócio, direto.
  const maps = normalizarLink(data?.maps_url);
  if (maps) links.google_meu_negocio = maps;

  return links;
}

/**
 * Acrescenta à ficha do contato que JÁ EXISTE os links que faltam (Spec 26 §3.3).
 *
 * Regras, todas no próprio `where` (o contato é tocado só se for o certo):
 * - `organization_id` e `id`: contato de outra organização não é alcançado;
 * - `not is_anonymized` e `is_merged_into is null`: anonimizado e mesclado ficam quietos;
 * - só escreve se alguma chave de link FALTA: uma rodada sem nada novo não atualiza
 *   `updated_at`, e a aba Links não remonta o formulário à toa.
 *
 * No `||` a chave da DIREITA vence: o `custom_fields` que já está no banco (o que a
 * pessoa digitou) fica por último e ganha; o link que falta entra; o resto é preservado.
 *
 * Desvio consciente do SQL da §3.3: a checagem de "já completo" usa `?&` (existência
 * da chave) e não `@> $links`. Com `@>`, um link que a pessoa digitou com outro valor
 * nunca "bate", então a linha seria reescrita a cada clique (e o contador de faltantes
 * nunca zeraria). Com `?&` o critério é exatamente "só entra o link ausente".
 *
 * Devolve se gravou. Nenhuma chamada de rede.
 */
export async function completarLinksDoContato(
  db: pg.PoolClient,
  org: string,
  contactId: string,
  links: LinksDoContato,
): Promise<boolean> {
  const novos = aplicarLinks({}, links);
  const chaves = Object.keys(novos);
  if (chaves.length === 0) return false;
  const result = await db.query(
    `update public.contacts
        set custom_fields = $3::jsonb || coalesce(custom_fields, '{}'::jsonb), updated_at = now()
      where organization_id = $1 and id = $2
        and not is_anonymized and is_merged_into is null
        and not (coalesce(custom_fields, '{}'::jsonb) ?& $4::text[])`,
    [org, contactId, JSON.stringify(novos), chaves],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Só leitura: o contato receberia algum link de `links` se `completarLinksDoContato`
 * rodasse agora? Mesmo predicado do `where` acima (mesma org, mesmos filtros, mesmas
 * chaves), para a contagem de "faltam" dizer exatamente o que a escrita faria.
 */
export async function contatoPrecisaDeLinks(
  db: pg.PoolClient,
  org: string,
  contactId: string,
  links: LinksDoContato,
): Promise<boolean> {
  const chaves = Object.keys(aplicarLinks({}, links));
  if (chaves.length === 0) return false;
  const result = await db.query(
    `select 1 from public.contacts
      where organization_id = $1 and id = $2
        and not is_anonymized and is_merged_into is null
        and not (coalesce(custom_fields, '{}'::jsonb) ?& $3::text[])`,
    [org, contactId, chaves],
  );
  return result.rows.length > 0;
}
