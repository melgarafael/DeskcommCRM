/**
 * O LEITOR DOS CATÁLOGOS — `lib/i18n/traducoes/<codigo>.json` na tela.
 *
 * ─── Só entra aqui o catálogo de um idioma que aparece ─────────────────────
 *
 * Um catálogo importado vai no pacote do navegador de TODO usuário. O de um
 * idioma `em_construcao` não é servido a ninguém, então pô-lo aqui seria pagar
 * centenas de KB por uma língua que ninguém pode escolher. A guarda está em
 * `tests/unit/catalogo-de-idioma-tem-forma`: este é o único arquivo que pode
 * importar um catálogo, e só o de um idioma visível.
 *
 * ─── O dicionário vem antes ────────────────────────────────────────────────
 *
 * `traduzir` consulta a coluna do dicionário e só depois o catálogo; os dois
 * caem no português. A leitura é síncrona e a mesma no servidor, no worker e
 * no navegador — nada de carga assíncrona por idioma nesta fatia.
 */
import type { Idioma } from "./idiomas";

// ponytail: vazio enquanto nenhum idioma de catálogo é visível (turco, chinês e
// inglês estão em construção); a promoção importa o JSON aqui.
const CATALOGOS: Partial<Record<Idioma, Readonly<Record<string, string>>>> = {};

/** Os idiomas cujo texto vem de um catálogo, e não de coluna do dicionário. */
export const IDIOMAS_COM_CATALOGO = Object.keys(CATALOGOS) as Idioma[];

/** A frase no catálogo do idioma, ou `undefined` quando ele não a tem. */
export function entradaDoCatalogo(idioma: Idioma, texto: string): string | undefined {
  return CATALOGOS[idioma]?.[texto];
}
