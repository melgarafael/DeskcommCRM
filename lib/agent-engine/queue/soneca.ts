/**
 * A SONECA do laço da fila: dormir até o instante pedido, com dois motivos para
 * sair antes — chegou trabalho (`acordar`) e desligou (`signal`).
 *
 * O DEFEITO QUE ELA FECHA (#3688, medido pelo @melgarafael com relógio falso e
 * `dormir` de verdade): com o recuo exponencial da fila vazia LIGADO (opt-in,
 * doc 242), uma instalação parada dorme até o teto `QUEUE_IDLE_MAX_INTERVAL_MS`. O inbound que
 * chega NO MEIO dessa soneca vira job em segundos — o `runDrainLoop` roda no
 * mesmo worker e o enfileira —, mas o laço só o enxerga quando a soneca termina.
 * Chegada 125 s depois da fila esvaziar custava 49,25 s de atraso no claim;
 * 330 s custava 24,25 s; o pior caso é o teto inteiro. É a PRIMEIRA resposta a
 * um lead que escreveu depois de um período parado.
 *
 * QUEM ACORDA, QUEM CONSOME, E O QUE SOBRA:
 *
 *   - quem acorda é quem ENFILEIRA (o drain, via `DrainKnobs.acordarFila`), no
 *     mesmo processo do laço — nada de polling novo, nada de `setInterval`;
 *   - quem consome é a soneca em curso: `acordar()` resolve a promessa de corte
 *     e o `Promise.race` do `dormir` devolve na hora;
 *   - wake SEM ninguém dormindo é CONSUMIDO, não guardado: `cortar` é `null` e
 *     o `acordar()` só avança a geração. Guardar o sinal para cortar a PRÓXIMA
 *     soneca faria toda soneca nascer cortada — o laço voltaria ao ritmo curto
 *     de antes da #3688 e a economia de egress evaporaria, que é o defeito
 *     oposto ao desta correção;
 *   - mas o wake não se perde no intervalo em que o laço TRABALHA: a geração é
 *     o que o laço compara entre o topo da volta e a hora de dormir. Job
 *     enfileirado enquanto a volta consultava o relógio ou claimava muda a
 *     geração, e o laço não dorme — volta a perguntar. Sem isso sobraria uma
 *     janela (a duração do claim) em que o job esperaria o teto inteiro, que é
 *     o mesmo defeito com probabilidade menor e igual de difícil de explicar.
 *
 * Duas sonecas, nunca: `cortar` guarda UMA promessa por vez e o laço é serial —
 * `acordar()` duas vezes seguidas corta a mesma soneca e a segunda é no-op.
 *
 * O DESLIGAMENTO CONTINUA IMEDIATO: o `signal` vai para o `dormir` cru, que
 * REJEITA no abort — e a rejeição atravessa o `race` (o laço já trata: `catch {
 * break }`). O `catch` que este módulo põe na promessa da dormida é para o
 * PERDEDOR da corrida não virar `unhandledRejection` (no Node 22 isso derruba o
 * processo): soneca cortada pelo wake e abortada depois pelo `docker stop` é o
 * caminho normal do shutdown, não um erro.
 */
import { setTimeout as esperar } from 'node:timers/promises';

/**
 * A dormida crua — a assinatura de `node:timers/promises.setTimeout` (o repo o
 * importa como `sleep`; `timers/promises` NÃO exporta um `sleep`, e chamá-lo
 * assim derrubava a soneca com `sleep is not a function`).
 */
export type DormirCru = (ms: number, opcoes: { signal?: AbortSignal }) => Promise<unknown>;

export interface OpcoesDaSoneca {
  /**
   * Como dormir de verdade. Injetável para o teste dirigir o RELÓGIO: o
   * `vi.useFakeTimers()` não fakeia o `setTimeout` de `node:timers/promises`
   * (medido neste repo), então quem prova o corte do wake é um relógio virtual
   * passado por aqui, não um timer de mentira.
   */
  dormirCru?: DormirCru;
  /** Desligamento do worker. Abortar REJEITA a soneca em curso. */
  signal?: AbortSignal;
}

export interface SonecaDaFila {
  /** Corta a soneca EM CURSO. Sem ninguém dormindo, só avança a geração. */
  acordar: () => void;
  /**
   * Muda a cada `acordar()`. O laço guarda o valor no topo da volta e compara
   * antes de dormir: geração diferente = chegou trabalho enquanto esta volta
   * rodava, e dormir aqui seria o atraso que a soneca existe para evitar.
   */
  geracao: () => number;
  /** Dorme `ms`, sai antes no wake, rejeita no abort do desligamento. */
  dormir: (ms: number) => Promise<void>;
}

export function criarSonecaDaFila(opcoes: OpcoesDaSoneca = {}): SonecaDaFila {
  const dormirCru: DormirCru = opcoes.dormirCru ?? ((ms, o) => esperar(ms, undefined, o));
  const { signal } = opcoes;

  let geracao = 0;
  // Quem está dormindo AGORA. `null` = ninguém; nesse caso `acordar()` não tem
  // o que cortar e não inventa um pendente.
  let cortar: (() => void) | null = null;

  return {
    acordar(): void {
      geracao += 1;
      const emCurso = cortar;
      cortar = null;
      emCurso?.();
    },

    geracao: () => geracao,

    async dormir(ms: number): Promise<void> {
      let cortarEsta!: () => void;
      const acordada = new Promise<void>((resolve) => {
        cortarEsta = resolve;
      });
      // Registro síncrono, antes de qualquer `await`: entre a conferência da
      // geração no laço e este ponto não há suspensão, então o wake ou chega
      // antes (e a conferência pega) ou chega depois (e cai neste `cortar`).
      cortar = cortarEsta;

      const dormida = dormirCru(ms, signal === undefined ? {} : { signal });
      // O perdedor da corrida precisa de handler: soneca cortada no wake e
      // abortada depois no shutdown é o caminho NORMAL, e a rejeição tardia do
      // `sleep` derrubaria o processo por `unhandledRejection`.
      dormida.catch(() => undefined);

      try {
        await Promise.race([dormida, acordada]);
      } finally {
        // Devolve o registro só se ainda for desta soneca: um wake que chegou
        // durante ela já zerou, e deixar aqui uma promessa JÁ resolvida cortaria
        // a soneca seguinte no nascimento.
        if (cortar === cortarEsta) cortar = null;
      }
    },
  };
}
