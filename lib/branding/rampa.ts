/**
 * Derivação da rampa de 11 stops a partir de UM hex — o núcleo de cor do whitelabel.
 *
 * Por que existe: o revendedor que instala o CRM numa VPS escolhe a cor da marca dele
 * e o produto inteiro precisa se pintar com ela, sem que ninguém edite CSS. Uma rampa
 * de 11 graus é o que o design system consome (`app/globals.css`), então derivá-la
 * corretamente é a diferença entre "trocou a cor" e "quebrou a interface".
 *
 * Zero dependência de biblioteca de cor, de propósito: a imagem Docker do self-host é
 * pré-buildada e cada dependência nova é superfície de advisory num produto que o
 * cliente hospeda. As conversões (sRGB ↔ OKLab, de Björn Ottosson) cabem em 60 linhas.
 *
 * A régua é `app/globals.css`. `rampaDeSemente('#008069')` reproduz os 11 stops do
 * verde-WhatsApp (produto default) com Δ ≤ 2/255 por canal — medido, e vigiado por
 * `tests/unit/branding-rampa.test.ts`, que LÊ os stops esperados do próprio CSS.
 */

// ── Tipos ────────────────────────────────────────────────────────────────────

/** Canais 0..255, como o hex os traz. */
export type Rgb = { readonly r: number; readonly g: number; readonly b: number };

/** OKLCh: L em 0..1, C em 0..~0,4, h em graus 0..360. */
export type Oklch = { readonly L: number; readonly C: number; readonly h: number };

/** OKLab cru — usado pelo ΔE, onde o eixo polar só atrapalharia. */
export type Oklab = { readonly L: number; readonly a: number; readonly b: number };

/**
 * 11 hexes na ordem dos graus. Tupla, não `string[]`: sob
 * `noUncheckedIndexedAccess` isso é o que permite indexar sem `!` em toda linha.
 */
export type Rampa = readonly [
  string, string, string, string, string, string, string, string, string, string, string,
];

/** Os rótulos dos graus, na mesma ordem da `Rampa`. */
export const GRAUS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export type Grau = (typeof GRAUS)[number];

// ── Conversões sRGB ↔ OKLab ─────────────────────────────────────────────────

const srgbParaLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

const linearParaSrgb = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `true` para `#abc`, `#aabbcc` e as duas formas sem cerquilha. */
export function ehHexValido(hex: string): boolean {
  return HEX.test(hex.trim());
}

/**
 * Lança em hex malformado. É deliberado: quem recebe cor de fora do sistema valida
 * com Zod antes (doutrina do repo), e engolir lixo aqui devolveria preto silencioso —
 * a marca do cliente sumiria sem ninguém saber por quê.
 */
export function hexParaRgb(hex: string): Rgb {
  const bruto = hex.trim();
  if (!HEX.test(bruto)) throw new TypeError(`hex inválido: ${JSON.stringify(hex)}`);
  const corpo = bruto.replace("#", "");
  const seis =
    corpo.length === 3
      ? corpo
          .split("")
          .map((c) => c + c)
          .join("")
      : corpo;
  return {
    r: parseInt(seis.slice(0, 2), 16),
    g: parseInt(seis.slice(2, 4), 16),
    b: parseInt(seis.slice(4, 6), 16),
  };
}

const canal = (v: number): string =>
  Math.max(0, Math.min(255, Math.round(v)))
    .toString(16)
    .padStart(2, "0");

export function rgbParaHex({ r, g, b }: Rgb): string {
  return `#${canal(r)}${canal(g)}${canal(b)}`;
}

/** Sempre 6 dígitos, minúsculo, com cerquilha — para comparar hex por igualdade. */
export function normalizarHex(hex: string): string {
  return rgbParaHex(hexParaRgb(hex));
}

type Linear = readonly [number, number, number];

export function hexParaLinear(hex: string): Linear {
  const { r, g, b } = hexParaRgb(hex);
  return [srgbParaLinear(r / 255), srgbParaLinear(g / 255), srgbParaLinear(b / 255)];
}

export function linearParaHex(lin: Linear): string {
  const [r, g, b] = lin;
  const f = (v: number) => linearParaSrgb(Math.max(0, Math.min(1, v))) * 255;
  return rgbParaHex({ r: f(r), g: f(g), b: f(b) });
}

export function linearParaOklab(lin: Linear): Oklab {
  const [r, g, b] = lin;
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lr = Math.cbrt(l);
  const mr = Math.cbrt(m);
  const sr = Math.cbrt(s);
  return {
    L: 0.2104542553 * lr + 0.793617785 * mr - 0.0040720468 * sr,
    a: 1.9779984951 * lr - 2.428592205 * mr + 0.4505937099 * sr,
    b: 0.0259040371 * lr + 0.7827717662 * mr - 0.808675766 * sr,
  };
}

export function oklabParaLinear({ L, a, b }: Oklab): Linear {
  const lr = L + 0.3963377774 * a + 0.2158037573 * b;
  const mr = L - 0.1055613458 * a - 0.0638541728 * b;
  const sr = L - 0.0894841775 * a - 1.291485548 * b;
  const l = lr * lr * lr;
  const m = mr * mr * mr;
  const s = sr * sr * sr;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function hexParaOklab(hex: string): Oklab {
  return linearParaOklab(hexParaLinear(hex));
}

export function hexParaOklch(hex: string): Oklch {
  const { L, a, b } = hexParaOklab(hex);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { L, C: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

function oklchParaLinear({ L, C, h }: Oklch): Linear {
  const rad = (h * Math.PI) / 180;
  return oklabParaLinear({ L, a: C * Math.cos(rad), b: C * Math.sin(rad) });
}

// Folga de 1e-4 no teste de gamut: sem ela, arredondamento de ponto flutuante
// rejeitaria cores que o `Math.round` para 0..255 devolveria intactas, e a busca
// binária desbotaria stops que já estavam dentro do sRGB.
const dentroDoSrgb = (lin: Linear): boolean => lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * OKLCh → hex, com clamp de gamut por **redução de croma**.
 *
 * Clipar canal (o caminho preguiçoso: `min(1, max(0, v))` em cada um) desloca o
 * matiz — um roxo saturado vira azul quando só o canal vermelho estoura. Reduzir o
 * croma mantendo L e h faz a cor perder saturação, que é o que o olho perdoa. Busca
 * binária em 40 passos: resolução muito abaixo de 1/255, o custo é irrelevante e o
 * resultado é determinístico (nada de laço com passo fixo que pára cedo).
 */
export function oklchParaHex({ L, C, h }: Oklch): string {
  const Lc = Math.max(0, Math.min(1, L));
  const direto = oklchParaLinear({ L: Lc, C, h });
  if (dentroDoSrgb(direto)) return linearParaHex(direto);

  let cabe = 0;
  let estoura = C;
  for (let i = 0; i < 40; i += 1) {
    const meio = (cabe + estoura) / 2;
    if (dentroDoSrgb(oklchParaLinear({ L: Lc, C: meio, h }))) cabe = meio;
    else estoura = meio;
  }
  return linearParaHex(oklchParaLinear({ L: Lc, C: cabe, h }));
}

/** Distância euclidiana em OKLab. Unidade crua (0..~1), NUNCA multiplicada por 100. */
export function deltaEOklab(a: string, b: string): number {
  const x = hexParaOklab(a);
  const y = hexParaOklab(b);
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}

/**
 * Composição alfa em sRGB gama-codificado — de propósito: é assim que o navegador
 * compõe `rgba()` sobre um fundo, e o número que queremos é o que o olho vê na tela,
 * não o fisicamente correto. Compor em linear daria outro hex e outra razão de
 * contraste, e aí o gate mediria uma tela que não existe.
 */
export function compor(cor: string, alfa: number, sobre: string): string {
  const c = hexParaRgb(cor);
  const s = hexParaRgb(sobre);
  const a = Math.max(0, Math.min(1, alfa));
  return rgbParaHex({
    r: c.r * a + s.r * (1 - a),
    g: c.g * a + s.g * (1 - a),
    b: c.b * a + s.b * (1 - a),
  });
}

// ── A rampa ──────────────────────────────────────────────────────────────────

/**
 * Lightness dos 11 stops Sage, medida em OKLab a partir de `app/globals.css`.
 * É a FORMA da escada — a curva de luminosidade que o design system desenhou à mão.
 */
export const ESCADA_L = [
  0.9695, 0.9317, 0.8597, 0.7634, 0.6718, 0.5899, 0.5015, 0.4303, 0.3772, 0.339, 0.2278,
] as const;

/**
 * Croma de cada stop RELATIVO ao stop 600 (por isso `CURVA_C[6] === 1`). Sobe até o
 * 500 e cai nas pontas: cor clara demais ou escura demais não sustenta saturação
 * dentro do sRGB, e insistir só produz clamp.
 */
export const CURVA_C = [
  0.11, 0.247, 0.486, 0.765, 1.021, 1.111, 1.0, 0.789, 0.63, 0.508, 0.334,
] as const;

/**
 * O índice da SEMENTE: stop 600, o `--color-accent` do tema claro.
 *
 * Este é o coração da decisão. A alternativa óbvia — ancorar a semente no stop cuja
 * lightness mais se aproxima da dela — parece mais "natural" e está errada: `#0f172a`
 * (navy, a identidade corporativa mais comum que existe) cai num índice alto, e o
 * accent do tema claro vira `#4360a7`, um azul-periwinkle. O cliente cola o hex da
 * marca e recebe outra cor. Ancorar por PAPEL garante que o hex escolhido é
 * exatamente o que a interface pinta no papel para o qual ele foi escolhido.
 */
export const K = 6;

const L0 = ESCADA_L[0];
const L10 = ESCADA_L[10];
const LK = ESCADA_L[K];
const CK = CURVA_C[K];

/**
 * Reescala a escada de L em DOIS segmentos lineares, para que ela atravesse a
 * lightness da semente exatamente no índice K, sem mover as pontas.
 *
 * Um segmento só (interpolar L0→L10 passando pela semente) torceria a curva inteira e
 * a ponta clara perderia a separação entre 50 e 100. Dois segmentos preservam a forma
 * relativa de cada metade e movem só a articulação.
 */
function lightnessDoStop(indice: number, Lsemente: number): number {
  const L = ESCADA_L[indice] ?? LK;
  return indice <= K
    ? L0 + (L - L0) * ((Lsemente - L0) / (LK - L0))
    : Lsemente + (L - LK) * ((L10 - Lsemente) / (L10 - LK));
}

/**
 * Deriva os 11 stops a partir do hex da marca.
 *
 * O stop K recebe o hex LITERAL no fim, e não o resultado da ida-e-volta por OKLab:
 * a conversão erra ±1/255 por arredondamento, e o seletor de cor mostraria ao cliente
 * uma cor que a UI não usa. Um pixel de diferença ninguém vê; a desconfiança de ver
 * `#506d48` no campo e `#516d49` na tela custa caro.
 */
export function rampaDeSemente(semente: string): Rampa {
  const { L: Ls, C: Cs, h } = hexParaOklch(semente);
  const C0 = Cs / CK;
  const stops = ESCADA_L.map((_, i) =>
    oklchParaHex({ L: lightnessDoStop(i, Ls), C: C0 * (CURVA_C[i] ?? 1), h }),
  );
  stops[K] = normalizarHex(semente);
  return stops as unknown as Rampa;
}

/** Índice na `Rampa` a partir do rótulo do grau (600 → 6). */
export function indiceDoGrau(grau: Grau): number {
  return GRAUS.indexOf(grau);
}

/** Lê um stop já clampado às pontas — deslocamento que sai do array vira a ponta. */
export function stop(rampa: Rampa, indice: number): string {
  return rampa[Math.max(0, Math.min(10, Math.round(indice)))] ?? rampa[K];
}
