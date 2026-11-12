import { createHash } from "node:crypto";

/**
 * #4429 — AS REDAÇÕES DO PASSO DE MENSAGEM E A ROTAÇÃO ENTRE ELAS.
 *
 * ─── O que este arquivo resolve, e por que ele existe ────────────────────────
 *
 * O passo `action` / `mode: "text"` tem UM texto (`graph-schema.ts`,
 * `actionConfigSchema`). Prospecção em massa manda o mesmo corpo para o número
 * inteiro, e a trava de repetição da cadeia de envio
 * (`lib/agent-engine/spinning/engine.ts`) — janela por SESSÃO DE CANAL, ou
 * seja, CRUZA leads — veta a partir do 3º envio parecido. A trava está certa;
 * o que faltava era o fluxo poder variar DENTRO dela. O produto já fazia isso
 * num canto (`lib/escalacao/aviso-ao-lead.ts`: variantes por hash do lead,
 * "porque um texto FIXO se veta sozinho").
 *
 * ─── Por que ROTAÇÃO, e não sorteio ─────────────────────────────────────────
 *
 * Sorteio puro repete: dois envios seguidos podem cair na mesma redação com
 * 1/n de chance a cada um, e é exatamente o caso que o cliente vê — duas
 * frases iguais na mesma conversa. Rotação anda de um em um: o envio seguinte
 * NUNCA é o mesmo do anterior, enquanto houver mais de uma redação.
 *
 * ─── Determinismo: mesma inscrição + mesmo histórico ⇒ mesma frase ──────────
 *
 * O índice é `(hash(contato) + envios já feitos) % n`, sem estado novo no banco
 * e sem relógio. Duas consequências, as duas de propósito:
 *
 *   1. Re-tentar o MESMO job não troca a frase: o histórico é o mesmo, a
 *      escolha é a mesma. (Sorteio por `Math.random()` trocaria, e o cliente
 *      receberia numa re-entrega uma redação que ninguém escolheu.)
 *   2. Contatos diferentes não começam todos na mesma redação: o hash espalha
 *      o PONTO DE PARTIDA pela base, e a rotação anda a partir dele. Sem o
 *      hash, todo lead novo receberia primeiro o `body` — e a primeira leva de
 *      uma campanha inteira sairia idêntica, que é o defeito medido na issue.
 *
 * O que este módulo NÃO faz (decisão de produto da issue, fora desta fatia):
 * escolher a redação com MENOR similaridade contra a janela de `outbound_copies`
 * e reagendar quando nenhuma passa. Aqui a escolha é cega à janela.
 */

/** O que o motor precisa saber de um evento da inscrição para contar envios. */
type EventoDeEnvio = { event_type?: string | null };

/**
 * As redações do passo, na ordem em que o motor as percorre.
 *
 * `body` é SEMPRE a primeira: é o campo que o grafo publicado já tem, o que o
 * cartão do nó e a prévia mostram, e o que qualquer leitor antigo entende.
 * `variacoes` são as redações ADICIONAIS. Passo sem variação devolve
 * `[body]` — e aí a rotação é o caminho de sempre, byte a byte.
 */
export function redacoesDoPasso(config: {
  body: string;
  variacoes?: readonly string[] | null;
}): string[] {
  const extras = (config.variacoes ?? [])
    .map((redacao) => redacao.trim())
    .filter((redacao) => redacao.length > 0);
  return extras.length === 0 ? [config.body] : [config.body, ...extras];
}

/**
 * A redação desta vez.
 *
 * `enviados` é quantas mensagens esta inscrição JÁ mandou (`action_sent`), não
 * quantas vezes este passo rodou: a mensagem que o cliente vê é a sequência da
 * conversa, e é ela que não pode repetir a frase anterior. `semente` é o
 * contato, para o ponto de partida variar entre leads.
 *
 * Com uma redação só não há giro: devolve `redacoes[0]`, que é o `body` — o
 * comportamento de hoje.
 */
export function redacaoDaVez(
  redacoes: readonly string[],
  semente: string,
  enviados: number,
): string {
  if (redacoes.length <= 1) return redacoes[0]!;
  const volta = Number.isFinite(enviados) ? Math.max(0, Math.trunc(enviados)) : 0;
  const indice = (sementeEmUint32(semente) + volta) % redacoes.length;
  return redacoes[indice]!;
}

/** Quantas mensagens esta inscrição já enviou — a volta da rotação. */
export function enviosJaFeitos(eventos: readonly EventoDeEnvio[]): number {
  let enviados = 0;
  for (const evento of eventos) if (evento.event_type === "action_sent") enviados++;
  return enviados;
}

/**
 * O ponto de partida estável do contato.
 *
 * sha256 (e não `Math.random`, nem `created_at`) pela mesma razão de
 * `lib/escalacao/aviso-ao-lead.ts`: o mesmo contato tem de cair sempre na
 * mesma redação para o mesmo histórico, inclusive entre réplicas do worker.
 */
function sementeEmUint32(semente: string): number {
  return createHash("sha256").update(semente).digest().readUInt32BE(0);
}
