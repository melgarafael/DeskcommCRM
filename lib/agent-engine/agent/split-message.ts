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

/**
 * Outcome mínimo que o send do canal devolve (subconjunto usado aqui).
 * messageId casa com o shape real de ChannelSendResult (string | null | undefined
 * conforme o kind) — não apenas string opcional.
 */
export interface BubbleOutcome {
  kind: string;
  messageId?: string | null;
}

export interface SendInBubblesOpts<T extends BubbleOutcome = BubbleOutcome> {
  enabled: boolean;
  maxChars: number;
  send: (body: string) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  /** ms de jitter humano entre bolhas (só entre, não antes da 1ª). */
  jitter: () => number;
}

/**
 * Envia o corpo em bolhas quando `enabled`; senão um envio só. Cada bolha passa
 * pelo mesmo `send` (que no runtime é o channel.send pós-guardrails, com seq++).
 * Para no 1º outcome que não seja de sucesso ('sent'/'already_sent'/'queued')
 * e o devolve — não segue mandando bolha após veto/bloqueio/falha.
 *
 * LIMITAÇÃO CONHECIDA: o contador de cap diário do pacing anti-ban (recordSend)
 * conta o send lógico UMA vez por turno, então um turno de N bolhas avança o cap
 * em 1, não N — aceitável por ora (doutrina: "anti-ban gateia uma vez"); revisitar
 * se o warm-up precisar de precisão por mensagem física.
 */
const OK_KINDS = new Set(["sent", "already_sent", "queued"]);

export async function sendInBubbles<T extends BubbleOutcome>(
  body: string,
  opts: SendInBubblesOpts<T>,
): Promise<T> {
  const bubbles = opts.enabled ? splitIntoBubbles(body, opts.maxChars) : [body];
  if (bubbles.length === 0) return opts.send(body); // corpo vazio: deixa o canal decidir
  let last: T | undefined;
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) await opts.sleep(opts.jitter());
    last = await opts.send(bubbles[i]!);
    if (!OK_KINDS.has(last.kind)) return last; // veto/bloqueio/falha: para aqui
  }
  return last!;
}
