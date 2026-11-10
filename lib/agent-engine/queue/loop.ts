/**
 * O laço que consome a fila. Mora aqui, e não inline no `main.ts`, por um motivo
 * de prova: as duas coisas que derrubam produção neste laço são comportamento do
 * CALL SITE, não aritmética — a rejeição do sleep abortado (que quebrava o
 * shutdown) e o que fazer quando o relógio falha. Um teste da função pura de
 * espera ficaria verde com o shutdown quebrado. Com as dependências injetadas, o
 * teste dirige o laço INTEIRO sem Postgres e sem fake timers (`vi.useFakeTimers`
 * não fakeia `node:timers/promises`, medido neste repo).
 *
 * O DESENHO, em uma frase: o worker pergunta ao banco QUANDO tem trabalho, não SE
 * — e dorme exatamente até lá, limitado por um teto.
 *
 * E QUEM DORME ACORDA: o teto do recuo da fila vazia (#3688, opt-in) é uma soneca
 * que o inbound pode ter de furar. O `runDrainLoop` roda neste mesmo worker e é
 * quem transforma evento em job, então ele avisa (`SonecaDaFila.acordar`) e a
 * soneca sai na hora, em vez de o job esperar o fim dela — 49,25 s medidos pelo
 * @melgarafael numa chegada 125 s depois da fila esvaziar. O desenho e os
 * contratos estão em `./soneca.ts`.
 *
 * Antes (issue #258), toda rodada abria uma transação de claim com 5 statements e
 * dormia 250 ms fixos quando voltava vazia: ~17 statements/s para sempre numa
 * instalação que não atende ninguém, 8,09 GB/mês de egress medidos pelo autor da
 * issue numa VPS com Supabase free, cuja cota é 5 GB/mês. Agora a rodada ociosa é
 * UM statement de 54 B, e o teto só é atingido quando não há nada agendado.
 */
import type { Logger } from '../obs/logger';
import type { SonecaDaFila } from './soneca';

export interface IntervalosDaFila {
  /** Piso da espera ociosa — `QUEUE_POLL_INTERVAL_MS`. */
  ociosoMs: number;
  /** "Havia trabalho e eu não peguei" — `QUEUE_CLAIM_RETRY_INTERVAL_MS`. */
  retryMs: number;
  /**
   * Teto do recuo exponencial com a fila vazia — `QUEUE_IDLE_MAX_INTERVAL_MS`.
   * AUSENTE = recuo DESLIGADO: a fila vazia dorme sempre o piso, que é o
   * comportamento de antes da #3688. Decisão do dono (doc 242, opção C): a fila
   * de respostas do agente é o caminho que o cliente sente na hora, e nem todo
   * enfileiramento acorda a soneca (o `case_reply_turn` nasce na API do app, fora
   * do worker), então economizar consultas é escolha de quem opera, não default.
   */
  ociosoMaxMs?: number | undefined;
}

/**
 * Quanto dormir, dado o que o relógio da fila respondeu.
 *
 * `null` = fila vazia; `<= 0` = já venceu (e o claim não trouxe nada: o cap
 * `QUEUE_MAX_CONCURRENCY` está cheio, ou a lane do contato está ocupada, ou outra
 * transação segura a linha) — esse é o único estado que merece o ritmo curto,
 * porque há trabalho de verdade esperando uma vaga. `> 0` = acorda no vencimento,
 * limitado pelo teto, que é o que impede o laço de dormir através da janela do
 * `INBOUND_DEBOUNCE_MS`.
 *
 * `rodadasOciosas` = quantas rodadas SEGUIDAS o relógio respondeu "fila vazia"
 * antes desta. É o que separa "acabei de ficar ocioso" de "estou ocioso há uma
 * hora": com o piso fixo, a instalação parada consultava o banco 30×/min para
 * sempre — medido pelo autor da #3688 em 3.880 chamadas em 2h19 (~28/min), a
 * maior fonte de consumo ocioso do produto. Aqui a espera DOBRA por rodada
 * ociosa até o teto `ociosoMaxMs` (60 s dá ~1 consulta/min; sem teto, não há
 * recuo) e volta ao
 * piso na primeira rodada em que houver trabalho, que é o único momento em que o
 * ritmo curto compra latência de verdade.
 *
 * Função pura de propósito: o recuo é aritmética, e aritmética se prova com
 * números, não com um laço e relógio de parede.
 */
export function intervaloDeEspera(
  faltaMs: number | null,
  intervalos: IntervalosDaFila,
  rodadasOciosas = 0,
): number {
  if (faltaMs === null) {
    // `2 ** 30` estoura para Infinity bem antes de qualquer contador real; o
    // `Math.min` com o teto já o domina, mas clampar o expoente mantém o número
    // finito e a leitura óbvia.
    const fator = 2 ** Math.min(Math.max(rodadasOciosas, 0), 30);
    const teto = Math.max(intervalos.ociosoMaxMs ?? intervalos.ociosoMs, intervalos.ociosoMs);
    return Math.min(intervalos.ociosoMs * fator, teto);
  }
  if (faltaMs <= 0) return intervalos.retryMs;
  return Math.min(faltaMs, intervalos.ociosoMs);
}

export interface DepsDoLoopDaFila<J> {
  /** Milissegundos até o próximo job claimável, ou `null` se a fila está vazia. */
  relogio: () => Promise<number | null>;
  claimar: () => Promise<J[]>;
  /** Despacha os jobs claimados (o `runJob` do worker). Não é aguardado. */
  aoClaimar: (jobs: J[]) => void;
  /**
   * Espera abortável E interrompível: sai no desligamento (rejeita) e também
   * quando chega trabalho novo (`acordar`). Ver `./soneca.ts`.
   */
  soneca: SonecaDaFila;
  deveParar: () => boolean;
  intervalos: IntervalosDaFila;
  log: Logger;
}

/**
 * Roda até `deveParar()`. Resolve — nunca rejeita — porque o `shutdown` do worker
 * faz `await` nele antes de drenar os jobs em voo: uma rejeição aqui derrubaria o
 * processo com os jobs claimados presos em `running`, invisíveis até o
 * `QUEUE_VISIBILITY_TIMEOUT_MS` (10 minutos) — a cada `docker stop`.
 */
export async function rodarLoopDaFila<J>(deps: DepsDoLoopDaFila<J>): Promise<void> {
  // O relógio só é consultado quando a rodada anterior voltou vazia. Sob carga o
  // laço claima em sequência, no ritmo de hoje, sem pagar o statement extra.
  let ultimaTrouxe = true;
  // Quantas rodadas SEGUIDAS o relógio respondeu "fila vazia". É o expoente do
  // recuo: 0 = primeira espera ociosa (piso), 1 = o dobro, ... até o teto. Sai de
  // zero no mesmo instante em que o relógio volta a acusar trabalho — a fila que
  // acorda não paga o recuo que acumulou dormindo.
  let rodadasOciosa = 0;

  while (!deps.deveParar()) {
    // A geração do wake no TOPO da volta: é a régua contra a qual a hora de
    // dormir vai ser comparada. Se o drain enfileirar um job enquanto esta volta
    // consulta o relógio ou claima, a geração muda e o laço não dorme — sem
    // isso, o job esperaria o teto inteiro (o mesmo defeito que o wake fecha).
    const geracaoNoInicio = deps.soneca.geracao();
    let faltaMs: number | null = 0;
    if (!ultimaTrouxe) {
      try {
        faltaMs = await deps.relogio();
      } catch (err) {
        // Falha ABERTA de propósito: banco instável não pode virar "não há
        // trabalho". Sem o claim a seguir, um blip de rede adormeceria a fila
        // pelo teto inteiro — e o erro de verdade aparece no claim logo abaixo,
        // que é quem tem o tratamento e o log de sempre.
        deps.log.error('relógio da fila indisponível — claim segue no ritmo curto', {
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        });
        faltaMs = 0;
      }
    }

    let claimados: J[] = [];
    // (c) A checagem de parada DEPOIS do await do relógio (#2823): o
    // desligamento pode ter chegado enquanto a consulta estava em voo, e claimar
    // assim abriria uma transação NOVA que o drain já não vai esperar — o lease
    // ficaria preso até o reaper (QUEUE_VISIBILITY_TIMEOUT_MS), invisível, a cada
    // `docker stop`. Um claim JÁ iniciado NÃO é interrompido por esta linha (o
    // await do `claimar` abaixo é quem começa, e ele roda até o fim): ele precisa
    // terminar para não largar o lease no meio.
    if (deps.deveParar()) break;
    if (faltaMs !== null && faltaMs <= 0) {
      try {
        claimados = await deps.claimar();
      } catch (err) {
        deps.log.error('claim falhou', {
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        });
      }
    }

    deps.aoClaimar(claimados);
    ultimaTrouxe = claimados.length > 0;

    if (claimados.length === 0 || deps.deveParar()) {
      // Trabalho que chegou ENQUANTO esta volta rodava: o `acordar` já disparou,
      // mas não havia soneca para cortar. Dormir aqui é exatamente o atraso que
      // o wake existe para eliminar, então volta a perguntar ao relógio — que
      // agora enxerga o job recém-enfileirado. Não é soneca pendente: a geração
      // é reabsorvida no topo da próxima volta.
      if (deps.soneca.geracao() !== geracaoNoInicio) continue;
      const espera = intervaloDeEspera(faltaMs, deps.intervalos, rodadasOciosa);
      // O contador avança DEPOIS de calcular a espera desta rodada: a primeira
      // volta com a fila vazia dorme o piso, não o piso dobrado. Só o relógio
      // dizendo `null` acumula recuo; `faltaMs` numérico (inclusive o vencido que
      // o claim não pegou) significa que HÁ trabalho e zera a contagem.
      rodadasOciosa = faltaMs === null ? rodadasOciosa + 1 : 0;
      try {
        await deps.soneca.dormir(espera);
      } catch {
        // Sinal de desligamento abortou a espera: sair é o comportamento certo,
        // e o `deveParar()` do topo confirmaria na volta de qualquer forma. Um
        // wake NÃO passa por aqui — ele resolve, não rejeita.
        break;
      }
    }
  }
}
