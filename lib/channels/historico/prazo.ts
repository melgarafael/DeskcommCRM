/**
 * O relógio da importação do histórico (#999).
 *
 * O agendador chama `api/v1/cron/historico-import` a cada minuto e corta o
 * `curl` no `-m` da linha do job (`docker/scheduler/entrypoint.sh`). A chamada
 * inteira, com TODAS as rodadas que ela fizer, cabe em `PRAZO_DA_CHAMADA_MS`; o
 * `-m` do job fica acima dele com folga para as gravações no banco que vêm
 * depois da última chamada ao canal (`tests/unit/historico-cron.test.ts` mede).
 *
 * A rodada só começa uma chamada ao canal com pelo menos `MARGEM_PARA_CHAMADA_MS`
 * pela frente: a página tem o teto padrão do cliente do WAHA (15 s), e o
 * download leva `TETO_DO_DOWNLOAD_MS` no próprio `AbortSignal`. Sem tempo, a
 * rodada para com o cursor firme e a próxima segue dali.
 *
 * Arquivo separado de `rodada.ts` de propósito: os testes do cron dublam a
 * rodada e precisam do prazo de verdade.
 */

/** Passado isto, a chamada do cron não começa outra chamada ao canal. */
export const PRAZO_DA_CHAMADA_MS = 45_000;

/** Teto de UM download de mídia (o `AbortSignal` do pedido ao canal). */
export const TETO_DO_DOWNLOAD_MS = 15_000;

/**
 * Tempo mínimo pela frente para começar uma chamada ao canal. Igual ao
 * `TETO_PADRAO_MS` do cliente do WAHA (página de conversas ou de mensagens) e
 * não menor que `TETO_DO_DOWNLOAD_MS`: a chamada que começa termina no prazo.
 * Literal, e não importado de `lib/waha/client`, porque os testes da rodada
 * dublam o cliente inteiro; a igualdade é cobrada em
 * `tests/unit/historico-cron.test.ts`.
 */
export const MARGEM_PARA_CHAMADA_MS = 15_000;
