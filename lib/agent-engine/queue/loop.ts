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
 * Antes (issue #258), toda rodada abria uma transação de claim com 5 statements e
 * dormia 250 ms fixos quando voltava vazia: ~17 statements/s para sempre numa
 * instalação que não atende ninguém, 8,09 GB/mês de egress medidos pelo autor da
 * issue numa VPS com Supabase free, cuja cota é 5 GB/mês. Agora a rodada ociosa é
 * UM statement de 54 B, e o teto só é atingido quando não há nada agendado.
 */
import type { Logger } from '../obs/logger';

export interface IntervalosDaFila {
  /** Teto de espera / ritmo ocioso — `QUEUE_POLL_INTERVAL_MS`. */
  ociosoMs: number;
  /** "Havia trabalho e eu não peguei" — `QUEUE_CLAIM_RETRY_INTERVAL_MS`. */
  retryMs: number;
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
 */
export function intervaloDeEspera(faltaMs: number | null, intervalos: IntervalosDaFila): number {
  if (faltaMs === null) return intervalos.ociosoMs;
  if (faltaMs <= 0) return intervalos.retryMs;
  return Math.min(faltaMs, intervalos.ociosoMs);
}

export interface DepsDoLoopDaFila<J> {
  /** Milissegundos até o próximo job claimável, ou `null` se a fila está vazia. */
  relogio: () => Promise<number | null>;
  claimar: () => Promise<J[]>;
  /** Despacha os jobs claimados (o `runJob` do worker). Não é aguardado. */
  aoClaimar: (jobs: J[]) => void;
  /** Espera abortável. Rejeita quando o desligamento aborta o sinal. */
  dormir: (ms: number) => Promise<unknown>;
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

  while (!deps.deveParar()) {
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
      try {
        await deps.dormir(intervaloDeEspera(faltaMs, deps.intervalos));
      } catch {
        // Sinal de desligamento abortou a espera: sair é o comportamento certo,
        // e o `deveParar()` do topo confirmaria na volta de qualquer forma.
        break;
      }
    }
  }
}
