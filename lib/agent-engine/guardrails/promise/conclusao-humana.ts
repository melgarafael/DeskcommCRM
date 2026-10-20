/** Rede local de degradação; não decide fidelidade, beneficiário ou autoridade.
 * Só é usada com fonte/devolutiva humana quando o sinal independente está ausente.
 * O revisor julga a mensagem inteira; estas formas não são uma lista de liberações.
 */
export function detectHumanCompletion(body: string): boolean {
  const text = body.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const clauses = text.split(/(?<=[.!?\n;])/);
  return clauses.some(clause => {
    if (clause.trim().endsWith('?')) return false;
    // Negação, hipótese e relato citado não afirmam uma conclusão do vendedor.
    if (/\b(?:se|caso|suponha|hipoteticamente)\b/.test(clause) ||
        /\b(?:voce|cliente)\s+(?:disse|escreveu|perguntou)\b/.test(clause)) return false;
    const completion = /\b(?:confirmou|confirmaram|aprovou|aprovaram|autorizou|autorizaram|liberou|liberaram|concluiu|concluiram|resolveu|resolveram)\b|\b(?:esta|estao|ficou|ficaram|foi|foram)\s+(?:\w+\s+){0,3}(?:confirmad[oa]s?|aprovad[oa]s?|autorizad[oa]s?|liberad[oa]s?|concluid[oa]s?|resolvid[oa]s?)\b/g;
    return [...clause.matchAll(completion)].some(match => {
      const prefix = clause.slice(Math.max(0, match.index - 30), match.index);
      return !/\b(?:nao|nunca|ainda nao|sem)\s+(?:\w+\s+){0,3}$/.test(prefix);
    });
  });
}
