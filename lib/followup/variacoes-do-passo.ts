import { createHash } from "node:crypto";

import { colisoesNaJanela, type RecentCopy } from "@/lib/agent-engine/spinning/engine";
import type { SpinningKnobs } from "@/lib/agent-engine/spinning/defaults";

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
 * ─── A JANELA DE REPETIÇÃO (segunda metade da #4429) ────────────────────────
 *
 * A rotação sozinha é CEGA à janela: ela pode devolver justamente a redação que
 * o número acabou de mandar duas vezes, e o gate `spinning` veta. Antes desta
 * metade o veto caía como `skipped` no turno — e `skipped` na ponte CANCELA a
 * inscrição: o lead não recebe nada e o fluxo morre.
 *
 * `redacoesNaOrdemDaVez` + `redacaoQuePassaNaJanela` fecham isso no lugar certo:
 * a ORDEM continua sendo a da rotação (determinística, sem estado novo), e a
 * ESCOLHA passa a olhar a janela — vence a de MENOR colisão, com o empate
 * ficando com a preferida da rotação, então sem pressão de janela o texto que
 * sai é exatamente o de antes. `null` (nenhuma passa) é o sinal de ADIAR, e
 * quem adia é o caminho de envio, como já faz com `outside_window`.
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
  return redacoesNaOrdemDaVez(redacoes, semente, enviados)[0]!;
}

/**
 * As redações na ORDEM DESTA VEZ: a preferida da rotação primeiro, e depois as
 * seguintes na mesma volta (a última fecha o ciclo na preferida).
 *
 * É a rotação de `redacaoDaVez` sem perder as outras: o primeiro elemento é,
 * byte a byte, o que a rotação escolheria sozinha; os demais existem para a
 * escolha poder desviar de uma redação que a janela já viu, sem inventar ordem
 * nova (a mesma inscrição, no mesmo estado, devolve sempre a mesma lista).
 */
export function redacoesNaOrdemDaVez(
  redacoes: readonly string[],
  semente: string,
  enviados: number,
): string[] {
  if (redacoes.length <= 1) return [...redacoes];
  const volta = Number.isFinite(enviados) ? Math.max(0, Math.trunc(enviados)) : 0;
  const inicio = (sementeEmUint32(semente) + volta) % redacoes.length;
  return redacoes.map((_, passo) => redacoes[(inicio + passo) % redacoes.length]!);
}

/**
 * A redação que a JANELA DE REPETIÇÃO aceita — a escolha da segunda metade da
 * #4429, e a única pergunta que este módulo responde sobre a janela.
 *
 * Vence a de MENOR colisão (`colisoesNaJanela`, a mesma medida do gate); empate
 * fica com a que vem antes em `redacoes`, que é a preferida da rotação. Com a
 * janela limpa todas empatam em zero e sai a preferida — o comportamento de
 * antes, byte a byte.
 *
 * `null` NÃO é "pule o passo": é "nenhuma redação passa agora", e o turno
 * traduz isso em ADIAMENTO (o caso vizinho `outside_window` reagenda pela mesma
 * ponte). Quem chamar daqui sem tratar o `null` como adiamento reintroduz o
 * defeito que esta função fecha.
 */
export function redacaoQuePassaNaJanela(
  redacoes: readonly string[],
  janela: readonly RecentCopy[],
  knobs: SpinningKnobs,
): string | null {
  let melhor: { redacao: string; colisoes: number } | null = null;
  for (const redacao of redacoes) {
    const colisoes = colisoesNaJanela({ candidate: redacao, window: [...janela], knobs });
    if (melhor === null || colisoes < melhor.colisoes) melhor = { redacao, colisoes };
  }
  if (melhor === null || melhor.colisoes >= knobs.repetitionThreshold) return null;
  return melhor.redacao;
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
