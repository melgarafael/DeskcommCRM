/**
 * Quebra o texto da resposta em "bolhas" curtas (Onda 4) — parágrafo → sentença
 * → palavra, juntando pedaços adjacentes que caibam em maxChars. Puro. Usado no
 * send do agente quando split_messages está on; o pacing anti-ban espaça cada
 * bolha. Nunca devolve bolha vazia nem (salvo palavra atômica gigante) > maxChars.
 */
export function splitIntoBubbles(text: string, maxChars: number): string[] {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return [];
  if (trimmed.length <= maxChars) return [trimmed];

  // Unidades atômicas: parágrafos → sentenças. Cada unidade que ainda estoura é
  // quebrada por palavra.
  const units: string[] = [];
  for (const para of trimmed.split(/\n{2,}/)) {
    const p = para.trim();
    if (p === "") continue;
    if (p.length <= maxChars) {
      units.push(p);
      continue;
    }
    for (const sentence of splitSentences(p)) {
      if (sentence.length <= maxChars) units.push(sentence);
      else units.push(...splitWords(sentence, maxChars));
    }
  }

  // Junta unidades adjacentes enquanto couberem (com espaço).
  const bubbles: string[] = [];
  let cur = "";
  for (const u of units) {
    const joined = cur === "" ? u : `${cur} ${u}`;
    if (joined.length <= maxChars) {
      cur = joined;
    } else {
      if (cur !== "") bubbles.push(cur);
      cur = u;
    }
  }
  if (cur !== "") bubbles.push(cur);
  return bubbles;
}

/** Divide em sentenças mantendo a pontuação final (. ! ?). */
function splitSentences(text: string): string[] {
  const out = text.match(/[^.!?]+[.!?]*/g);
  return (out ?? [text]).map((s) => s.trim()).filter((s) => s !== "");
}

/** Última linha de defesa: agrupa palavras até maxChars; palavra atômica > max vai sozinha. */
function splitWords(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    if (w === "") continue;
    const joined = cur === "" ? w : `${cur} ${w}`;
    if (joined.length <= maxChars) cur = joined;
    else {
      if (cur !== "") out.push(cur);
      cur = w;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}
