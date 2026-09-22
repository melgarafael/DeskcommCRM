/**
 * Textos das telas — português (BR), único idioma do produto.
 *
 * A CHAVE é o texto em português (regra histórica que segue valendo: quem lê
 * o componente vê a frase, não um código). Sem segundo idioma, `traduzir()`
 * devolve a chave sempre — `t()` vira identidade e nenhuma das ~2700 chamadas
 * precisa ser reescrita. Se um dia voltar um segundo idioma, é só republicar
 * entradas aqui; nenhuma tela migra.
 */
import type { Idioma } from "./idiomas";

/** `pt-BR` não aparece: é a chave. Reservado para uma futura tradução. */
type Traducoes = Record<string, Partial<Record<Exclude<Idioma, "pt-BR">, string>>>;

export const DICIONARIO: Traducoes = {};

/**
 * Traduz, ou devolve o próprio texto.
 *
 * Nunca lança e nunca devolve vazio: um texto sem tradução aparece em
 * português, que é exatamente o comportamento de antes desta feature. Uma
 * tradução parcial não pode deixar a tela PIOR do que estava.
 */
export function traduzir(texto: string, idioma: Idioma): string {
  if (idioma === "pt-BR") return texto;
  return DICIONARIO[texto]?.[idioma] ?? texto;
}
