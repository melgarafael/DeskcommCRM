/**
 * Para ONDE o Strobi olha, a partir de onde o mouse está.
 *
 * A lib (`@bible-strong/avatar-react`) só entende expressões NOMEADAS — não dá
 * para apontar o olhar em graus. Então cada direção do cursor vira a
 * expressão cujo ângulo chega mais perto.
 *
 * ⚠️ Os ângulos abaixo são MEDIDOS, não deduzidos: o `head.x/head.y` do JSON
 * NÃO é a direção dos olhos (perspectiva e espaçamento deslocam). Medido com
 * `scripts/sondar-olhares.ts` — motor geométrico da própria lib, centroide
 * dos olhos vs `neutral`, em graus (0 = cima, 90 = direita). Exemplos do que
 * a medição desmentiu: `asymmetric-up-left` olha para a DIREITA (73°),
 * `skeptical-right` olha para BAIXO (179°) e `wide-down-left` para a direita.
 *
 * ⚠️ Só entraram expressões de humor neutro, sem olho oculto E sem olho
 * semicerrado (medido o bounding-box de cada olho). `skeptical-left` e
 * `asymmetric-down-right` foram REMOVIDAS de propósito: um dos olhos rende
 * metade da altura do outro (58×24 e 21×26) — é o "fecha um olho" que o
 * usuário recusou. Sem elas, o cima-esquerda cai em `surprised-left`
 * (48×60 e 63×63, bem abertos).
 */

export interface Olhar {
  expressao: string;
  /** Graus medidos: 0 = cima, 90 = direita, ±180 = baixo, -90 = esquerda. */
  angulo: number;
}

export const OLHARES: Olhar[] = [
  { expressao: "far-right-glance", angulo: 85 },
  { expressao: "upward-side-glance", angulo: 47 },
  { expressao: "playful-right", angulo: 104 },
  { expressao: "small-attentive", angulo: 128 },
  { expressao: "wide-downward-gaze", angulo: 156 },
  { expressao: "downward-gaze", angulo: 168 },
  { expressao: "gentle-downward-gaze", angulo: -143 },
  { expressao: "surprised-wide-left", angulo: -139 },
  { expressao: "curious-left", angulo: -126 },
  { expressao: "surprised-left", angulo: -113 },
];

/** Raio morto ao redor do avatar: com o cursor em cima dele, o olhar volta ao `idle`. */
export const RAIO_MORTO_PX = 90;

/**
 * O nome da expressão para um vetor (dx, dy) do centro do avatar até o
 * cursor, ou `null` dentro do raio morto. Vizinho mais próximo por ângulo —
 * mover o mouse pela tela TROCA de expressão de verdade, em vez de travar
 * numa zona só (o defeito anterior: no canto da tela, tudo era "esquerda").
 */
export function olharPara(dx: number, dy: number): string | null {
  if (Math.hypot(dx, dy) < RAIO_MORTO_PX) return null;
  const alvo = (Math.atan2(dx, -dy) * 180) / Math.PI;
  let melhor = OLHARES[0]!.expressao;
  let menor = 360;
  for (const o of OLHARES) {
    let d = Math.abs(o.angulo - alvo) % 360;
    if (d > 180) d = 360 - d;
    if (d < menor) {
      menor = d;
      melhor = o.expressao;
    }
  }
  return melhor;
}
