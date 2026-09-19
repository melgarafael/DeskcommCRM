import type { PacingKnobs } from "@/lib/agent-engine/pacing/defaults";
import { warmupCapFor } from "@/lib/agent-engine/pacing/engine";

/**
 * O RITMO DA ESTEIRA FRIA É MAIS LENTO QUE O DA ESTEIRA DE RESPOSTA.
 *
 * ## Por que os degraus da casa não servem aqui
 *
 * `PACING_DEFAULTS.warmupDailyCaps` começa em **20 mensagens no primeiro dia**.
 * Esse degrau foi calibrado para a esteira de RESPOSTA — alguém escreveu, o
 * agente responde. Ali, 20 conversas no dia 1 é uso normal e o canal lê como
 * tal: há mensagem de entrada para cada saída.
 *
 * Na esteira fria não há entrada nenhuma. Vinte PRIMEIRAS abordagens saindo de
 * um número recém-conectado, todas para quem nunca falou com a empresa, é o
 * retrato exato do que a plataforma pune — e o número que morre é o do cliente
 * que instalou o produto, não o nosso.
 *
 * ## De onde sai o número, para não ser chute
 *
 * A doutrina do repo (`CLAUDE.md`, a seção do transporte de mensagem) já fixa
 * a proporção entre as duas esteiras no eixo do tempo: **resposta 1 msg/1,2s, campanha 1 msg/5s** — a
 * campanha é ~4× mais lenta. Este módulo aplica a MESMA proporção ao eixo do
 * volume diário, em vez de inventar uma tabela nova: o teto frio é o teto da
 * casa dividido por 4.
 *
 * Com os padrões de hoje, isso dá 5 / 13 / 25 / 50 / sem teto, contra
 * 20 / 50 / 100 / 200 / sem teto. E derivar em vez de copiar tem uma
 * consequência que importa: quem ajustar os degraus da instalação (eles são
 * knobs por canal) ajusta os dois juntos, sem descobrir meses depois que existia
 * uma segunda tabela escondida aqui.
 *
 * ## O último degrau continua sem teto
 *
 * `cap: null` significa "warm-up terminou". Manter `null` é deliberado: passado
 * o período, quem limita é o `daily_limit` da campanha e o `daily_message_limit`
 * do canal, que são escolha de quem opera. Inventar um teto eterno aqui seria
 * este módulo decidindo pela instalação.
 */

/** A proporção entre as duas esteiras, fixada na doutrina pelo eixo do tempo. */
export const FATOR_DA_ESTEIRA_FRIA = 4;

/**
 * Quantas abordagens frias este número pode fazer hoje.
 *
 * `null` = o warm-up terminou e este módulo não impõe teto.
 */
export function tetoDiarioDaEsteiraFria(knobs: PacingKnobs, ageDays: number): number | null {
  // FALHA FECHADO, como o motor da casa declara para o warm-up. Knobs sem
  // degraus (configuração incompleta, leitura que não veio) não pode virar
  // "sem teto" — o sentido do erro aqui é sempre o mais lento, porque o custo
  // do erro oposto é o número do cliente.
  const degraus = knobs.warmupDailyCaps;
  if (!Array.isArray(degraus) || degraus.length === 0) return 1;

  const capDaCasa = warmupCapFor(ageDays, degraus);
  if (capDaCasa === null) return null;
  // Piso de 1: um teto que arredonda para zero PARARIA a esteira em vez de
  // desacelerá-la, e uma campanha que nunca envia é um defeito diferente —
  // silencioso, e que o operador descobre olhando uma tela que não muda.
  return Math.max(1, Math.floor(capDaCasa / FATOR_DA_ESTEIRA_FRIA));
}

/**
 * O intervalo até a próxima abordagem, com variação.
 *
 * O intervalo da campanha era EXATO: `now + interval_minutes`, sempre o mesmo
 * número de milissegundos. Cadência perfeitamente regular é assinatura de robô
 * — é justamente o padrão que a detecção de automação procura, e a doutrina da
 * casa manda `throttle + jitter` em todo envio por isso.
 *
 * O jitter aqui só ATRASA (nunca adianta): adiantar poderia furar o intervalo
 * mínimo que o operador configurou, e o sentido do erro tem de ser sempre o
 * mais lento.
 */
export function proximoEnvioDaEsteiraFria(
  agora: Date,
  intervalMinutes: number,
  knobs: PacingKnobs,
  rng: () => number = Math.random,
): Date {
  const base = intervalMinutes * 60_000;
  const jitter = Math.floor(rng() * (knobs.jitterMaxMs + 1));
  return new Date(agora.getTime() + base + jitter);
}
