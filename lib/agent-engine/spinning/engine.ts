/**
 * Gate de spinning anti-template-idêntico (F2-12; blueprint 5.2) — decisão PURA:
 * dado (candidata, janela das últimas N copies do NÚMERO, knobs) devolve {allow}
 * ou {veto, reason instrutivo pt-br}. Irmão do motor de pacing (F2-11): sem I/O
 * nenhum aqui — a leitura da janela e o registro da copy enviada ficam no store;
 * a integração na cadeia de envio é da F2-13 (o seam está declarado em store.ts).
 *
 * Detecção em duas frentes sobre a copy NORMALIZADA:
 *   - igualdade exata via sha256 do normalizado (barata, cobre o template puro);
 *   - quase-idêntica via Jaccard de TOKENS (palavras): dois textos que dividem a
 *     maioria das palavras são o mesmo template — trocar uma palavra (ou só o nome
 *     do lead) num template de 10+ palavras fica bem acima do limiar; um spin real
 *     (reordenar, reescrever, abrir diferente) muda palavras o bastante e passa.
 *     Set-based → robusto a reordenação; O(n) → barato na janela.
 *
 * Normalização: lowercase + colapso de whitespace + trim. Pontuação e emoji são
 * MANTIDOS de propósito — fazem parte da assinatura do template e removê-los só
 * baixaria a similaridade (menos veto = menos conservador). Um "spin" real varia
 * conteúdo, não só pontuação.
 */
import { createHash } from 'node:crypto';

import type { SpinningKnobs } from './defaults';

/** Linha da janela — a copy já normalizada e seu hash (o store guarda ambos). */
export interface RecentCopy {
  normalizedText: string;
  normalizedHash: string;
}

export interface SpinningInput {
  /** Corpo CRU da mensagem que o modelo quer enviar (normalizado aqui dentro). */
  candidate: string;
  /** Últimas N copies do número (a ordem é irrelevante — só a contagem de matches importa). */
  window: RecentCopy[];
  knobs: SpinningKnobs;
}

export type SpinningDecision =
  | { allow: true }
  | { allow: false; code: 'mass_identical'; matchCount: number; reason: string };

export function normalizeCopy(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function hashNormalized(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

export function decideSpinning(input: SpinningInput): SpinningDecision {
  const { knobs } = input;
  const normalized = normalizeCopy(input.candidate);

  // Allowlist: curtas utilitárias e padrões isentos (ex.: link de pagamento)
  // NUNCA são vetadas — repeti-las é legítimo, não é blast de template.
  if (isAllowlisted(normalized, knobs)) return { allow: true };

  // windowSize também é knob AQUI (o store já lê com LIMIT windowSize; o slice é
  // defesa em profundidade e torna a janela um knob provável no pure layer). A
  // janela chega mais-recente-primeiro, então slice(0, N) pega as N mais recentes.
  const window = input.window.slice(0, knobs.windowSize);
  const candHash = hashNormalized(normalized);
  const candTokens = tokens(normalized);

  let matchCount = 0;
  for (const copy of window) {
    if (copy.normalizedHash === candHash) {
      matchCount += 1; // idêntica exata
      continue;
    }
    if (jaccard(candTokens, tokens(copy.normalizedText)) >= knobs.similarityThreshold) {
      matchCount += 1; // quase-idêntica (spin superficial)
    }
  }

  if (matchCount >= knobs.repetitionThreshold) {
    return {
      allow: false,
      code: 'mass_identical',
      matchCount,
      reason:
        `copy repetida em massa: ${matchCount} envio(s) idêntico(s) ou quase-idêntico(s) ` +
        `nas últimas ${window.length} mensagens deste número. Template idêntico em massa é ` +
        `gatilho de ban — varie o texto (personalize com o contexto do lead, reordene, troque ` +
        `a abertura) antes de reenviar.`,
    };
  }
  return { allow: true };
}

function isAllowlisted(normalized: string, knobs: SpinningKnobs): boolean {
  if (normalized.length <= knobs.allowlistMaxLength) return true;
  for (const pattern of knobs.allowlistPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      // Padrão inválido do operador: falha FECHADO (não isenta) — anti-ban prefere
      // vetar de mais a liberar um blast por causa de um regex mal escrito. O store
      // registra o warn no load; aqui o pure layer só se protege (defesa em profundidade).
      continue;
    }
    if (re.test(normalized)) return true;
  }
  return false;
}

/** Conjunto de palavras do normalizado (whitespace já colapsado a espaço único). */
function tokens(s: string): Set<string> {
  return new Set(s.split(' ').filter((t) => t.length > 0));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}
