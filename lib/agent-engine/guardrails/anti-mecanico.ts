/**
 * Anti-mecânico: detecta "muletas" de continuidade que anunciam que o bot está
 * retomando o fluxo, sem acrescentar conteúdo nenhum à conversa.
 *
 * É o que o dono descreveu como robótico:
 *   "como estamos falando disso, vamos continuar" — e variações próximas.
 *
 * Por que existe: quando a pergunta do fluxo é garantida pelo motor (trava "a
 * pergunta saiu?"), o modelo tende a emendar a pergunta com uma costura de
 * transição. A costura é o sintoma de que a fala virou script.
 *
 * Escopo DELIBERADAMENTE estreito: só as fórmulas de RETOMADA explícita. Frases
 * legítimas que apenas mencionam o contexto ("sobre a moto…", "então…") não
 * casam — falso positivo aqui vetaria a fala do modelo por estilo, não por dano.
 * O detector é puro; quem decide armar é o `before_send` (default desarmado).
 */

const MULETAS: ReadonlyArray<{ re: RegExp; rotulo: string }> = [
  {
    re: /\bcomo\s+(estamos|a gente)\s+(falando|conversando|a\s+falar)\b/i,
    rotulo: "como estamos falando",
  },
  {
    re: /\b(conforme|como)\s+(já\s+)?(conversamos|falamos|combinamos)\b/i,
    rotulo: "conforme conversamos",
  },
  {
    re: /\b(vamos|podemos)\s+continuar\s+(disso|de onde|o atendimento|a conversa|o papo|nosso)\b/i,
    rotulo: "vamos continuar disso",
  },
  {
    re: /\b(dando|dar)\s+continuidade\s+(ao|a|no|à)\s+(atendimento|conversa|papo|assunto)\b/i,
    rotulo: "dando continuidade",
  },
  {
    re: /\bretomando\s+(o|a|nosso|nossa)\s+(assunto|conversa|papo|atendimento)\b/i,
    rotulo: "retomando o assunto",
  },
  {
    re: /\bvoltando\s+(ao|para\s+o|pro)\s+(assunto|que\s+estávamos|nossa\s+conversa)\b/i,
    rotulo: "voltando ao assunto",
  },
];

/** Devolve o rótulo da muleta encontrada, ou `null` se o texto é limpo. */
export function detectarMuletaMecanica(texto: string): string | null {
  for (const { re, rotulo } of MULETAS) {
    if (re.test(texto)) return rotulo;
  }
  return null;
}
