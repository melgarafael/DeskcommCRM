/**
 * O CAMPO PERSONALIZADO DE MOEDA (`type: "currency"`) — na moeda da ORGANIZAÇÃO.
 *
 * Era real brasileiro de ponta a ponta. O tipo se chamava
 * « Moeda (BRL) » em toda organização, o editor escrevia o valor com
 * `Intl.NumberFormat("pt-BR", { currency: "BRL" })`, o exemplo do campo vazio era
 * « R$ 0,00 » e a leitura só sabia tirar o « R$ » da frente. Numa organização em
 * euro, o campo dizia « Devise (BRL) » e mostrava reais.
 *
 * A moeda é a de `organizations.currency`, a mesma do valor do negócio e do
 * catálogo (`lib/catalogo/moeda-da-org.ts`): é fato do negócio, não do idioma de
 * quem lê — e por isso o formato também é o da moeda, pela régua de `lib/money.ts`.
 *
 * O VALOR GUARDADO NÃO MUDA: o campo continua gravando unidades da moeda
 * (`1250.5`). Muda só como ele é escrito e lido na tela.
 */
import { formatValorDoNegocio, parseReaisToCents, simboloDaMoeda } from "@/lib/money";

/** O valor guardado (`1250.5`), escrito na moeda: « R$ 1.250,50 », « 1250,50 € ». */
export function valorDoCampoDeMoeda(valor: number, moeda: string): string {
  // A régua do negócio (×100 em qualquer moeda) é a que `formatValorDoNegocio` lê.
  return formatValorDoNegocio(Math.round(valor * 100), moeda);
}

/** O exemplo do campo vazio: « R$ 0,00 », « 0,00 € ». */
export function exemploDoCampoDeMoeda(moeda: string, valor = 0): string {
  return valorDoCampoDeMoeda(valor, moeda);
}

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * O que se digitou, sem o símbolo e o código da moeda da organização (« R$ »,
 * « € », « EUR »), onde quer que estejam, e sem espaço nenhum. Vazio quer dizer
 * que nada além da moeda foi digitado — quem chama decide se isso apaga o campo.
 */
export function semAMoeda(texto: string, moeda: string): string {
  let simbolo: string;
  try {
    simbolo = simboloDaMoeda(moeda);
  } catch {
    // Moeda que o `Intl` recusa: fica só o código.
    simbolo = moeda;
  }
  const marcas = [...new Set([simbolo, moeda].filter((marca) => marca.length > 0))];
  let resto = texto;
  for (const marca of marcas) resto = resto.replace(new RegExp(escaparRegex(marca), "giu"), "");
  return resto.replace(/\s/g, "");
}

/**
 * O que se digitou, em centavos (×100) — ou `null` quando não é um número.
 *
 * `parseReaisToCents` segue sendo quem decide o que é número: um texto com outra
 * coisa além de dígitos e separadores continua recusado. É o que a leitura de
 * antes fazia depois de tirar o « R$ », agora para toda moeda.
 */
export function lerCampoDeMoeda(texto: string, moeda: string): number | null {
  // ⚠️ A moeda vai ADIANTE (#3331): sem ela o parser lia `1,300` de uma
  // organização em dólar como 1,30 — a moeda chegava até aqui só para tirar o
  // símbolo e escrever o exemplo, e parava antes da leitura.
  return parseReaisToCents(semAMoeda(texto, moeda), moeda);
}
