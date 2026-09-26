/**
 * Quebra o texto da resposta em "bolhas" curtas (Onda 4). Puro. Usado no send
 * do agente quando split_messages está on; o pacing anti-ban espaça cada bolha.
 * Nunca devolve bolha vazia nem (salvo palavra atômica gigante) > maxChars.
 *
 * O PARÁGRAFO É A FRONTEIRA DA BOLHA. Quem escreve em bolhas no WhatsApp decide
 * onde uma termina e a outra começa, e o modelo diz isso com a linha em branco
 * (é o que `instrucaoDeBolhas` pede). Cada parágrafo sai como bolha própria, na
 * ordem do texto; `maxChars` só entra para partir o parágrafo que sozinho
 * estoura — por sentença, depois por palavra —, juntando dentro DELE os
 * pedaços que caibam.
 *
 * Antes, parágrafos vizinhos eram juntados enquanto coubessem em maxChars, e o
 * texto inteiro abaixo do teto saía numa bolha só. Isso deixava a opção sem
 * ajuste possível: teto alto (600) e três parágrafos curtos viravam UMA bolha;
 * teto baixo e o resumo do pedido — uma lista numa linha por item, sem ponto —
 * era cortado por palavra no meio de uma linha, com as quebras de linha
 * perdidas. Medido numa VPS em produção (26/09/2026): com teto 500, o corte do
 * sistema quase nunca agia, e as "bolhas" que o cliente via eram o modelo
 * chamando send_message várias vezes — em paralelo, fora de ordem.
 */
export function splitIntoBubbles(text: string, maxChars: number): string[] {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return [];

  const bubbles: string[] = [];
  for (const para of trimmed.split(/\n{2,}/)) {
    const p = para.trim();
    if (p === "") continue;
    if (p.length <= maxChars) {
      bubbles.push(p);
      continue;
    }
    // Parágrafo que estoura: sentenças (palavra como último recurso), juntando
    // as vizinhas DESTE parágrafo enquanto couberem.
    const units: string[] = [];
    for (const sentence of splitSentences(p)) {
      if (sentence.length <= maxChars) units.push(sentence);
      else units.push(...splitWords(sentence, maxChars));
    }
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
  }
  return bubbles;
}

/**
 * Divide em sentenças mantendo a pontuação final (. ! ?).
 *
 * O "." NÃO conta como fim de frase quando está entre dois dígitos — separador
 * de milhar/decimal brasileiro ("R$ 10.990,00", "12.990"). Sem esta guarda,
 * TODO preço em reais virava duas "sentenças" ("R$ 10." e "990 no cartão…"),
 * que a bolha seguinte às vezes junta com espaço espúrio ("R$ 7. 990") e às
 * vezes manda em bolhas do WhatsApp SEPARADAS — e um cliente que só via a
 * primeira lia "R$ 10" como preço fechado de um produto de R$ 10.990.
 * Medido em produção (2026-09-04): a moto DT3 (R$ 10.990) anunciada
 * como "R$ 10" reais.
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const prevChar = text[m.index - 1];
    const nextChar = text[end];
    const isNumeroPartido =
      m[0] === "." &&
      prevChar !== undefined &&
      nextChar !== undefined &&
      /\d/.test(prevChar) &&
      /\d/.test(nextChar);
    if (isNumeroPartido) continue;
    out.push(text.slice(start, end).trim());
    start = end;
  }
  const resto = text.slice(start).trim();
  if (resto !== "") out.push(resto);
  return out.length > 0 ? out.filter((s) => s !== "") : [text];
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
  /**
   * Roda UMA vez, antes do 1º envio, recebendo a 1ª bolha — é o gancho do
   * atraso humano do turno ("digitando…" + espera proporcional; ver
   * `atraso-humano.ts`).
   *
   * Recebe a 1ª BOLHA, não o corpo inteiro, e a diferença é a que se vê no
   * aparelho: quem escreve em bolhas manda a primeira assim que ela fica
   * pronta, não depois de digitar as cinco. Dimensionar a espera pelo corpo
   * todo faria uma resposta longa e picotada ficar parada no teto antes da
   * primeira palavra aparecer.
   *
   * UMA vez, e não por bolha, porque entre bolhas já existe o jitter anti-ban:
   * chamá-lo a cada uma somaria duas esperas na mesma pausa.
   *
   * OPCIONAL — sem ele o comportamento é exatamente o de antes, que é o que
   * mantém os testes existentes intactos. Chamador de produção há UM só
   * (`inbound-turn.ts`); o turno de follow-up NÃO passa por aqui — ele fala com
   * `channel.send` direto (`followup-turn.ts:604`), então a mensagem proativa
   * segue saindo sem pausa humana. É escopo deliberado: o "rápido demais" que
   * este gancho conserta é o da RESPOSTA que chega junto com o "✓✓" do cliente,
   * e um follow-up não responde a nada que ele acabou de mandar.
   */
  antesDaPrimeira?: (primeiraBolha: string) => Promise<void>;
  /**
   * Quantas bolhas ainda cabem no teto de mensagens do turno (MAX_SENDS_PER_TURN).
   * Um parágrafo = uma bolha, então sem isto um único send_message de 7 parágrafos
   * sairia em 7 mensagens físicas, passando do teto que existe para barrar isso.
   * Ausente = sem teto (o comportamento de antes).
   */
  maxBubbles?: number;
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
export const OK_KINDS = new Set(["sent", "already_sent", "queued"]);

/**
 * O QUE O TURNO DIZ AO MODELO quando `split_messages` está ligado.
 *
 * A tela promete "a resposta sai em bolhas separadas… o agente também é
 * instruído a escrever em parágrafos curtos". O texto que ia ao modelo dizia
 * outra coisa — "Prefira várias mensagens curtas a um texto único e longo" — e
 * o modelo obedecia chamando `send_message` VÁRIAS vezes no mesmo passo. Essas
 * chamadas rodam em paralelo e disputam o envio: o cliente recebia a lista de
 * dados de entrega fora de ordem. Medido numa VPS em produção (26/09/2026, 50
 * turnos reais): 17 respostas saíram partidas pelo próprio modelo — enquanto o
 * corte do sistema, com o teto de 500 caracteres, quase nunca agia.
 *
 * Quem parte em bolhas, EM ORDEM e no ritmo de quem digita, é `sendInBubbles`.
 * O modelo só precisa escrever UM envio em parágrafos curtos.
 *
 * E só quando a resposta tem mais de uma ideia. Pedir parágrafos SEMPRE (a
 * primeira redação desta instrução) fez o agente partir em três bolhas até a
 * resposta de uma frase — "o preço é X" virava saudação + preço + pergunta —,
 * e a loja percebeu a conversa mais longa e mais insistente (medido, 26/09/2026).
 */
export function instrucaoDeBolhas(ligado: boolean): string {
  return ligado
    ? "Escreva cada resposta numa ÚNICA chamada de send_message. Resposta curta vai num parágrafo só; quando ela tiver mais de uma ideia (apresentar uma opção, pedir dados, resumir o que foi combinado), use parágrafos curtos separados por uma linha em branco — o sistema entrega cada parágrafo como uma mensagem, em ordem e com a pausa de quem digita, como uma pessoa no WhatsApp. Nunca chame send_message mais de uma vez no mesmo turno: mensagens enviadas juntas podem chegar fora de ordem."
    : "";
}

/**
 * A decisão de fatiamento do `sendInBubbles`, exposta separadamente (issue #654).
 *
 * O turno precisa saber QUAL é a primeira bolha ANTES de o guardrail tomar o
 * lock do número: desde o conserto da #654 a pausa humana é paga fora da
 * transação (no `esperaForaDoLock` do turno; o dimensionamento é o de
 * `atraso-humano.ts`), e ela é medida pela primeira bolha — não pelo corpo todo.
 * Duas cópias desta lógica fariam a
 * pausa medir um texto e o canal mandar outro.
 *
 * Pura: sem I/O, sem relógio, sem canal. Devolve `[]` para corpo vazio (quem
 * chama decide — o `sendInBubbles` passa o corpo original ao `send`).
 */
export function splitForSend(
  body: string,
  enabled: boolean,
  maxChars: number,
  maxBubbles: number = Number.POSITIVE_INFINITY,
): string[] {
  if (!enabled) return [body];
  const bubbles = splitIntoBubbles(body, maxChars);
  if (bubbles.length <= maxBubbles || maxBubbles < 1) return bubbles;
  // Teto de mensagens FÍSICAS do turno (MAX_SENDS_PER_TURN, "bolhas incluídas"): o que
  // passa dele segue junto na última bolha, na ordem — nada do texto se perde.
  // ponytail: a última bolha pode passar de maxChars; é o preço de não picotar além do teto.
  return [
    ...bubbles.slice(0, maxBubbles - 1),
    bubbles.slice(maxBubbles - 1).join("\n\n"),
  ];
}

export async function sendInBubbles<T extends BubbleOutcome>(
  body: string,
  opts: SendInBubblesOpts<T>,
): Promise<T> {
  const bubbles = splitForSend(body, opts.enabled, opts.maxChars, opts.maxBubbles);
  if (bubbles.length === 0) return opts.send(body); // corpo vazio: deixa o canal decidir
  let last: T | undefined;
  for (let i = 0; i < bubbles.length; i++) {
    // Antes da 1ª: o atraso humano do turno. Entre as demais: o jitter anti-ban
    // que já existia. Nunca os dois na mesma pausa.
    if (i === 0) await opts.antesDaPrimeira?.(bubbles[0]!);
    else await opts.sleep(opts.jitter());
    last = await opts.send(bubbles[i]!);
    if (!OK_KINDS.has(last.kind)) return last; // veto/bloqueio/falha: para aqui
  }
  return last!;
}
