/**
 * Descrição de produto que chega "achatada" (a Meta tira o HTML e gruda tudo:
 * "…LicenciadoO mini…", "realista.Modelado…", "*Idade: 3 anos*Peso: 25kg")
 * → texto pronto para o WhatsApp: título, um parágrafo curto de abertura,
 * seções com emoji e itens em "•".
 *
 * Regras, não IA: o mesmo texto de entrada sempre dá a mesma saída, então a
 * sincronização seguinte não "mexe" no produto à toa. E as seções da ficha
 * (especificações, características, itens) NÃO perdem nem trocam uma letra —
 * só ganham quebra de linha, "•" e emoji. A abertura é encurtada só por
 * CORTE (fica o primeiro parágrafo, até o fim de uma frase), nunca reescrita:
 * nada do que o cliente lê foi inventado.
 *
 * Medido no catálogo da Turbo Kids (out/2026, 443 produtos): conferência
 * letra a letra das seções passou em todos.
 */

const SECOES: Array<[RegExp, string]> = [
  [/Especifica[çc][õo]es\s*(?:t[ée]cnicas)?\s*:/i, "📋"],
  [/Especifica[çc][ãa]o\s*:/i, "📋"],
  [/Caracter[íi]sticas\s*:/i, "✨"],
  [/Voc[êe] est[áa] adquirindo\s*:/i, "📦"],
  [/Itens inclusos\s*:/i, "📦"],
  [/Conte[úu]do da embalagem\s*:/i, "📦"],
  [/Garantia\s*:/i, "🛡️"],
  [/"?Compra Garantida"?/i, "✅"],
];

const EMOJIS_DE_TITULO: Array<[RegExp, string]> = [
  [/quadriciclo|utv|atv/, "🏎️"],
  [/moto/, "🏍️"],
  [/bicicleta|bike/, "🚲"],
  [/patinete|scooter/, "🛴"],
  [/caminhonete|jipe|carr|trator|lamborghini|ferrari|mercedes|bmw|audi|porsche|hilux|blazer/, "🚗"],
  [/balan[çc]o|playground|escorregador|gangorra/, "🛝"],
  [/piscina|boia/, "🏊"],
  [/pula[ -]pula|cama el[áa]stica/, "🤸"],
];

/** Grafias que são assim de propósito e não podem ganhar quebra no meio. */
const PROTEGIDAS = ["ImportWay", "WhatsApp", "iPhone", "PlayStation", "YouTube", "McQueen", "AxLxC", "LxAxC", "CxLxA"];

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

/** Teto da abertura (título fora). Passou, corta no fim da última frase que coube. */
export const TETO_DA_ABERTURA = 300;

/** Já tem cara de formatado (quebra de linha)? Então não se mexe. */
function jaFormatada(texto: string): boolean {
  return /\n/.test(texto.trim());
}

function separar(texto: string): string {
  let t = texto.replace(/\r\n?/g, "\n").trim();
  // As grafias protegidas saem de cena ANTES de qualquer regra de separação:
  // "AxLxC" casaria a regra do título grudado e viraria "Ax" + "LxC".
  PROTEGIDAS.forEach((p, i) => {
    t = t.split(p).join(`\u0000${i}\u0000`);
  });
  // itens de lista: "*" (não "**") vira bullet numa linha própria
  t = t.replace(/\s*\*(?!\*)\s*/g, "\n• ");
  // seções: linha em branco antes, emoji na frente
  for (const [padrao, emoji] of SECOES) {
    t = t.replace(new RegExp(`\\s*(${padrao.source})`, "gi"), (_m, sec: string) => `\n\n${emoji} ${sec}`);
  }
  t = t.replace(/\n?•?\s*(Imagens? meramente ilustrativas?)/gi, "\n\n⚠️ $1");
  // frase grudada: ".X" vira parágrafo novo (decimal não casa: depois vem maiúscula)
  t = t.replace(/([a-zà-ú0-9%)\]"”])([.!?])([A-ZÀ-Ú])/g, "$1$2\n\n$3");
  // título grudado na primeira frase: "12VCom o" / "LicenciadoO mini"
  t = t.replace(/(\d+V)([A-ZÀ-Ú][a-zà-ú])/, "$1\n\n$2");
  t = t.replace(/([a-zà-ú])([A-ZÀ-Ú])(?=[\sa-zà-ú])/, "$1\n\n$2");
  // ficha "Campo: valor" grudada ("31cmLargura:", "NovoMarca:") vira item
  t = t.replace(
    /([a-zà-ú0-9%)/²³°])([A-ZÀ-Ú][a-zà-ú]+(?: [a-zà-ú()/]+){0,6}\s*(?:\([^)\n]{0,15}\))?\s*:)/g,
    "$1\n• $2",
  );
  // o resto grudado (minúscula + Maiúscula) ganha quebra, menos as protegidas
  t = t.replace(/([a-zà-ú])([A-ZÀ-Ú][a-zà-ú])/g, "$1\n$2");
  PROTEGIDAS.forEach((p, i) => {
    t = t.split(`\u0000${i}\u0000`).join(p);
  });
  return t
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Corta um parágrafo no fim da última frase que cabe no teto. */
function cortarNaFrase(paragrafo: string, teto: number): string {
  if (paragrafo.length <= teto) return paragrafo;
  const ate = paragrafo.slice(0, teto);
  const fim = Math.max(ate.lastIndexOf(". "), ate.lastIndexOf("! "), ate.lastIndexOf("? "));
  if (fim > teto * 0.4) return ate.slice(0, fim + 1).trim();
  const espaco = ate.lastIndexOf(" ");
  return `${ate.slice(0, espaco > 0 ? espaco : teto).trim()}…`;
}

/**
 * Abertura curta: o título (primeira linha) e o primeiro parágrafo depois dele,
 * cortado no teto. O resto da abertura sai; as seções ficam inteiras.
 */
function encurtarAbertura(t: string): string {
  // A abertura vai até o primeiro parágrafo que já é ficha: começa com o
  // emoji de uma seção OU tem algum item "•" (ficha sem título, como
  // "Dimensões da embalagem\n• Altura: 31cm"). Dali em diante, tudo fica.
  const paragrafos = t.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const ehFicha = (p: string) => /^(?:📋|✨|📦|🛡️|✅|⚠️)/u.test(p) || /(^|\n)• /.test(p);
  const corte = paragrafos.findIndex(ehFicha);
  const abertura = corte >= 0 ? paragrafos.slice(0, corte) : paragrafos;
  const resto = corte >= 0 ? paragrafos.slice(corte) : [];
  if (abertura.length === 0) return t;
  const [titulo, ...corpo] = abertura;
  const curtos = [cortarNaFrase(titulo!, TETO_DA_ABERTURA)];
  if (corpo[0]) curtos.push(cortarNaFrase(corpo[0], TETO_DA_ABERTURA));
  return [...curtos, ...resto].join("\n\n").trim();
}

function emojiDoTitulo(nome: string): string | null {
  const n = nome.toLowerCase();
  for (const [padrao, emoji] of EMOJIS_DE_TITULO) if (padrao.test(n)) return emoji;
  return null;
}

/**
 * Formata a descrição achatada. Descrição que já tem quebra de linha (alguém
 * formatou à mão, ou veio de HTML) volta como está.
 */
export function formatarDescricao(nome: string, descricao: string | null): string | null {
  if (!descricao || !descricao.trim()) return descricao;
  if (jaFormatada(descricao)) return descricao.trim();
  const t = encurtarAbertura(separar(descricao));
  const emoji = emojiDoTitulo(nome);
  return emoji ? `${emoji} ${t}` : t;
}

/** Letras, números e pontuação sem formatação nenhuma — para conferir que nada mudou. */
export function semFormatacao(texto: string): string {
  return texto.replace(EMOJI, "").replace(/[•*]/g, "").replace(/\s+/g, "");
}
