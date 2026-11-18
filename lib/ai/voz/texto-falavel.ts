/**
 * O TEXTO QUE O AGENTE ESCREVE NÃO É O TEXTO QUE SE FALA.
 *
 * A resposta do agente tem emoji, markdown e preço em `R$ 1.234,56` — lido em
 * voz alta por um TTS isso sai "asterisco asterisco promoção", "R cifrão mil
 * duzentos e trinta e quatro vírgula cinquenta e seis", ou pior, cada símbolo
 * soletrado. Esta função limpa o texto para FALAR, nunca o texto que vai para
 * a tela. O texto original fica na thread do CRM (`media_derived_text`), mas ao
 * CLIENTE sai só a nota de voz — não há mensagem de texto equivalente. Por isso
 * `textoParaFalar` devolve `null` (a resposta sai em texto) quando o áudio
 * perderia alguma coisa: um link, ou o fim de uma resposta longa.
 *
 * Pura e determinística de propósito: quem decide SE fala é outra camada (a
 * regra de `voz_quando`); esta decide só o COMO, e precisa ser testável sem
 * rede nem banco.
 */

/** Emoji e pictogramas — `\p{Extended_Pictographic}` cobre a famíla inteira sem lista manual. */
const EMOJI = /\p{Extended_Pictographic}/gu;

/** Seletor de variação (ex.: ❤️ = coração + seletor) e ZWJ de sequências compostas. */
const RESIDUO_DE_EMOJI = /[\u{FE0F}\u{200D}]/gu;

const URL = /https?:\/\/\S+/gi;

/** Link markdown `[rótulo](url)` → fica só o rótulo; o link em si não existe em áudio. */
const LINK_MARKDOWN = /\[([^\]]+)\]\(([^)]+)\)/g;

const NEGRITO = /\*\*([^*]+)\*\*/g;
const ITALICO_ASTERISCO = /\*([^*]+)\*/g;
const ITALICO_UNDERSCORE = /_([^_]+)_/g;
const TACHADO = /~~([^~]+)~~/g;
const CODIGO_INLINE = /`([^`]+)`/g;

/**
 * `R$ 1.234,56`, `R$1,50` ou `R$1500` (sem separador de milhar) — formato
 * brasileiro (ponto = milhar, vírgula = decimal).
 *
 * ⚠️ Achado na revisão de código: a versão anterior era
 * `(\d{1,3}(?:\.\d{3})*|\d+)` — a PRIMEIRA alternativa vence sempre que
 * casa, e `\d{1,3}` sozinho casa "150" dentro de "1500" sem nunca tentar a
 * segunda alternativa (`\d+`) para o resto. "R$1500" saía falado como "cento
 * e cinquenta reais" com um "0" solto atrás — um preço ERRADO indo ao
 * cliente. `\d+(?:\.\d{3})*` resolve as duas formas com UM padrão: sem
 * ponto, `\d+` consome os dígitos todos (nada para parar nele); com ponto,
 * ele consome só o primeiro grupo (1–3 dígitos, porque é aí que o ponto
 * aparece) e o restante entra pelo grupo repetido.
 */
const MOEDA_BRL = /R\$\s?(\d+(?:\.\d{3})*)(?:,(\d{2}))?/g;

const UNIDADES = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const DEZ_A_DEZENOVE = [
  "dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove",
];
const DEZENAS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CENTENAS = [
  "", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos",
  "seiscentos", "setecentos", "oitocentos", "novecentos",
];

/** 0–999 por extenso. `cem` é a forma exata (não "cento") quando não há resto. */
function grupoDeTres(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cem";
  const partes: string[] = [];
  const centena = Math.floor(n / 100);
  const resto = n % 100;
  if (centena > 0) partes.push(CENTENAS[centena]!);
  if (resto > 0) {
    if (resto < 10) partes.push(UNIDADES[resto]!);
    else if (resto < 20) partes.push(DEZ_A_DEZENOVE[resto - 10]!);
    else {
      const dezena = Math.floor(resto / 10);
      const unidade = resto % 10;
      partes.push(unidade === 0 ? DEZENAS[dezena]! : `${DEZENAS[dezena]} e ${UNIDADES[unidade]}`);
    }
  }
  return partes.join(" e ");
}

/**
 * Inteiro não-negativo por extenso, em português. Correto e testado até
 * 999.999 (a faixa real de preço de venda); milhões em diante usa a mesma
 * regra de junção por "e" entre grupos, que é compreensível mas não garante
 * cobrir toda irregularidade formal do idioma nessa faixa — faixa que este
 * produto não precisa, porque não é para onde preço de venda chega.
 */
export function porExtenso(n: number): string {
  if (n === 0) return "zero";
  const milhoes = Math.floor(n / 1_000_000);
  const milhares = Math.floor((n % 1_000_000) / 1000);
  const unidade = n % 1000;

  const partes: string[] = [];
  if (milhoes > 0) {
    partes.push(milhoes === 1 ? "um milhão" : `${grupoDeTres(milhoes)} milhões`);
  }
  if (milhares > 0) {
    partes.push(milhares === 1 ? "mil" : `${grupoDeTres(milhares)} mil`);
  }
  if (unidade > 0) {
    partes.push(grupoDeTres(unidade));
  }
  // "e" entre o ÚLTIMO par quando o grupo final é < 100 ("mil e cinco") OU é
  // uma centena REDONDA ("mil e cem", "mil e duzentos") — mas NÃO quando a
  // centena tem resto próprio ("mil duzentos e trinta e quatro": o "e" já
  // mora dentro de "duzentos e trinta e quatro", um segundo não entra ali).
  if (partes.length > 1 && unidade > 0 && (unidade < 100 || unidade % 100 === 0)) {
    const ultimo = partes.pop()!;
    return `${partes.join(" ")} e ${ultimo}`;
  }
  return partes.join(" ");
}

function moedaPorExtenso(inteiros: string, centavosStr: string | undefined): string {
  const valor = Number(inteiros.replace(/\./g, ""));
  const reais = valor === 1 ? "um real" : `${porExtenso(valor)} reais`;
  if (centavosStr === undefined) return reais;
  const centavos = Number(centavosStr);
  if (centavos === 0) return reais;
  const centavosTexto = centavos === 1 ? "um centavo" : `${porExtenso(centavos)} centavos`;
  return `${reais} e ${centavosTexto}`;
}

/** Teto de caracteres do texto FALADO — nota de voz de 3 minutos ninguém ouve, e custa por caractere. */
export const TETO_DE_CARACTERES_FALADOS = 600;

/**
 * Corta no limite de PALAVRA, nunca no meio — cortar "obrigad|o" sai pior que
 * um texto mais curto.
 */
function truncar(texto: string, teto: number): string {
  if (texto.length <= teto) return texto;
  const cortado = texto.slice(0, teto);
  const ultimoEspaco = cortado.lastIndexOf(" ");
  return (ultimoEspaco > 0 ? cortado.slice(0, ultimoEspaco) : cortado).trim();
}

/**
 * Transforma a resposta ESCRITA do agente no texto que vai para o TTS.
 *
 * Ordem importa: moeda ANTES de remover símbolo nenhum (ela depende do `R$`
 * intacto); markdown antes de emoji (negrito pode embrulhar um emoji, e
 * remover o emoji primeiro deixaria `**foo` solto se o emoji estivesse colado
 * ao delimitador); espaços no fim, sempre.
 */
export function textoFalavel(texto: string, teto: number = TETO_DE_CARACTERES_FALADOS): string {
  let t = texto;
  t = t.replace(MOEDA_BRL, (_m, inteiros: string, centavos: string | undefined) =>
    moedaPorExtenso(inteiros, centavos),
  );
  t = t.replace(LINK_MARKDOWN, "$1");
  t = t.replace(URL, "");
  t = t.replace(NEGRITO, "$1");
  t = t.replace(ITALICO_ASTERISCO, "$1");
  t = t.replace(ITALICO_UNDERSCORE, "$1");
  t = t.replace(TACHADO, "$1");
  t = t.replace(CODIGO_INLINE, "$1");
  t = t.replace(EMOJI, "");
  t = t.replace(RESIDUO_DE_EMOJI, "");
  t = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return truncar(t, teto);
}

/** Link cru ou markdown: em áudio os dois somem. Sem `g` — `.test` global guarda `lastIndex`. */
const TEM_LINK = /https?:\/\/\S|\[[^\]]+\]\([^)]+\)/i;

/**
 * O texto que vira nota de voz, ou `null` quando a resposta tem de sair em TEXTO.
 *
 * As duas razões vêm do desenho aprovado na #491:
 *  - tem link: falado, ele some — o cliente que pediu o link de pagamento fica sem ele;
 *  - passa do teto: acima de `TETO_DE_CARACTERES_FALADOS` a resposta sai em texto, nunca cortada.
 *
 * Decidir ANTES do envio também protege a reserva: quando a síntese falha,
 * `send-message.ts` manda `body` como texto, e `body` é o que esta função devolveu.
 */
export function textoParaFalar(texto: string): string | null {
  if (TEM_LINK.test(texto)) return null;
  const falado = textoFalavel(texto, Infinity);
  if (falado.length === 0 || falado.length > TETO_DE_CARACTERES_FALADOS) return null;
  return falado;
}
