/**
 * O sinal que ACORDA o laço do `event_log` quando trabalho aparece no meio da
 * soneca.
 *
 * ─── Por que ele existe ──────────────────────────────────────────────────────
 *
 * O recuo ocioso do laço (`drain-loop.ts`) vai de 10s ao teto (30s por default,
 * `EVENT_LOG_DRAIN_IDLE_MAX_INTERVAL_MS`). Ele é o que segura
 * o tráfego de quem não tem atendimento, mas ele também é o que um evento novo
 * paga: depois de minutos parado — a noite de uma clínica, o fim de semana — o
 * primeiro evento espera ATÉ o teto só para ser visto. E esse atraso entra no
 * caminho crítico da PRIMEIRA resposta a um áudio:
 *
 *   áudio chega → `media.persist_requested` no event_log → (até o teto de soneca)
 *   → baixa do provedor → `media.derive_requested` → (até o teto de soneca) →
 *   Whisper transcreve em 3,9s
 *
 * Enquanto isso o drain do turno (`lib/agent-engine/edge/crm/drain.ts`) adia o
 * turno esperando a derivação, com teto de 120s (`TETO_ESPERA_DERIVACAO_MS`).
 * Com o recuo em 60s, um áudio lento — 86s documentados no cabeçalho do
 * `drain.ts` — faz 60+86 passar de 120s (com o teto default de 30s, 30+86
 * deixa só 4s de folga) e a resposta volta a ser "não consegui
 * ouvir seu áudio", que é exatamente o defeito que fez o teto subir de 45s para
 * 120s.
 *
 * ─── Quem acorda, quem consome ───────────────────────────────────────────────
 *
 * ACORDA: o `runDrainLoop` do CRM, no ponto em que ele constata "mídia ainda
 * sendo transcrita — turno adiado". Ele roda no MESMO processo do laço do
 * event_log (os dois sobem em `workers/agent-worker/main.ts`) e é o único ponto
 * que sabe, de dentro do worker, que a derivação está pendente. Por isso não há
 * LISTEN/NOTIFY: um `import` resolve o que o banco resolveria com uma conexão
 * a mais por worker.
 *
 * CONSOME: a própria soneca. `acordar()` não enfileira eventos nem conta
 * quantos chegaram — ele corta a espera em curso, e `dormir()` consome o pedido
 * ao sair.
 *
 * ─── Os três estados, e por que são três ─────────────────────────────────────
 *
 * `pedido` (sinal binário): houve um `acordar()` sem ninguém dormindo. Como é
 * BOOLEANO, dez acordares seguidos viram UM pedido — não existe fila para onde
 * acumular. O próximo `dormir()` gasta o pedido e sai na hora: é a semântica de
 * semáforo binário, em que um `post` antes do `wait` não se perde.
 *
 * `cortado`: uma soneca já foi cortada (ou um pedido já está marcado) e o tick
 * que a paga ainda não começou. É o que absorve o SEGUNDO `acordar()` do mesmo
 * instante — dois acordares seguidos valem UMA soneca cortada, não duas, senão
 * o laço faria um tick extra por cada evento que chegasse junto. O loop limpa
 * com `inicioDoTick()`, no topo de cada volta.
 *
 * `dormindo`: o resolvedor da espera em curso. Só existe um por vez; o laço é
 * sequencial.
 *
 * ─── O que este sinal NÃO cobre ──────────────────────────────────────────────
 *
 * O `insert` de `media.persist_requested` feito pelo INGEST do canal acontece
 * em OUTRO processo (a rota HTTP do webhook). Acordar o worker de lá exigiria
 * LISTEN/NOTIFY — que este PR evita de propósito. Esse salto continua limitado
 * pelo teto do recuo; o que este sinal cobre é a janela em que o worker já sabe
 * que a mídia está pendente, que é a que carrega os 86s da transcrição lenta.
 *
 * O módulo não importa NADA de propósito: ele entra no caminho de boot do
 * worker (`drain-loop` → este arquivo) e a cadeia `@/lib/env` já derrubou um
 * worker inteiro uma vez (#648). Um arquivo sem dependências não tem como
 * fazer isso de novo.
 */

/** Por que a soneca terminou. */
export type MotivoDaSoneca = 'prazo' | 'trabalho' | 'abortado';

/**
 * O sinal. `dormir` NUNCA rejeita: abortar resolve com `'abortado'` — o mesmo
 * contrato do `sleep(..., { signal })` que ele substitui, e o que mantém o
 * desligamento imediato (quem rejeita no abort derruba o `shutdown`, lição do
 * #3690).
 */
export interface SinalDeTrabalhoDeEventLog {
  /** Chamado pelo laço no topo de cada volta: o tick paga o corte anterior. */
  inicioDoTick(): void;
  /** Pede um tick agora. Idempotente; nunca acumula. */
  acordar(): void;
  /** Espera até `ms`, até um `acordar()`, ou até o `signal` abortar. */
  dormir(ms: number, signal: AbortSignal): Promise<MotivoDaSoneca>;
}

export function criarSinalDeTrabalho(): SinalDeTrabalhoDeEventLog {
  let pedido = false;
  let cortado = false;
  let dormindo: (() => void) | null = null;

  return {
    inicioDoTick(): void {
      cortado = false;
    },

    acordar(): void {
      // Já há um corte a caminho (ou o pedido já está marcado): este acordar não
      // compra um segundo tick. É a regra "dois acordares = uma soneca cortada".
      if (cortado) return;
      cortado = true;
      if (dormindo !== null) {
        const acorda = dormindo;
        dormindo = null;
        acorda();
        return;
      }
      // Ninguém dormindo (o laço está dentro de um tick, ou nem começou): o
      // pedido fica marcado e a PRÓXIMA soneca sai na hora. Deixar pendente e
      // não perder: o tick em curso pode ter consultado o banco ANTES de a
      // linha chegar, e é justamente esse caso que o teto do recuo punia.
      pedido = true;
    },

    dormir(ms: number, signal: AbortSignal): Promise<MotivoDaSoneca> {
      if (signal.aborted) return Promise.resolve('abortado');
      if (pedido) {
        pedido = false;
        cortado = true;
        return Promise.resolve('trabalho');
      }

      return new Promise<MotivoDaSoneca>((resolve) => {
        // O timer mora num objeto: `terminar` precisa dele e é declarado antes,
        // e um `let` solto aqui só satisfaria o lint com uma atribuição falsa.
        const relogio: { timer?: ReturnType<typeof setTimeout> } = {};
        let encerrada = false;
        const terminar = (motivo: MotivoDaSoneca): void => {
          // Idempotente: o abort e o acordar podem disputar a mesma soneca. Um
          // segundo `terminar` que passasse adiante apagaria o `dormindo` de
          // OUTRA espera e uma soneca seguinte nasceria surda.
          if (encerrada) return;
          encerrada = true;
          if (relogio.timer !== undefined) clearTimeout(relogio.timer);
          signal.removeEventListener('abort', aoAbortar);
          dormindo = null;
          resolve(motivo);
        };
        // Um `setTimeout(NaN)` dispara no tick seguinte e um valor negativo
        // idem: sem o clamp, uma espera mal calculada viraria laço quente.
        const espera = Number.isFinite(ms) && ms > 0 ? ms : 0;
        const acorda = (): void => terminar('trabalho');
        const aoAbortar = (): void => terminar('abortado');

        relogio.timer = setTimeout(() => {
          cortado = false;
          terminar('prazo');
        }, espera);
        dormindo = acorda;
        // `once` + `removeEventListener` explícito: um laço de dias acumularia
        // um listener por soneca no mesmo AbortSignal — vazamento que só
        // aparece como memória crescendo no worker, sem erro nenhum.
        signal.addEventListener('abort', aoAbortar, { once: true });
      });
    },
  };
}

/**
 * O sinal de produção. Um por processo: o `runDrainLoop` do CRM (quem chama
 * `acordar()`) e o `runEventLogDrainLoop` (quem dorme) sobem em
 * `workers/agent-worker/main.ts`, no mesmo processo.
 *
 * É uma FUNÇÃO e não uma constante porque o teste precisa de um sinal limpo por
 * caso: um singleton com estado mutável entre testes é como se escreve um teste
 * que passa sozinho e falha na suíte.
 */
let sinalDeProducao = criarSinalDeTrabalho();

export function sinalDeTrabalhoDoLacoDeEventLog(): SinalDeTrabalhoDeEventLog {
  return sinalDeProducao;
}

/**
 * O acordar, para quem está do outro módulo. Nunca lança: quem perdeu um
 * `acordar()` paga uma soneca a mais, e isso não é motivo para derrubar um tick
 * do drain do turno.
 */
export function acordarLacoDeEventLog(): void {
  sinalDeProducao.acordar();
}

/** Só para teste: um sinal novo, sem pedido, sem corte e sem soneca em curso. */
export function _reiniciarSinalDeTrabalho(): void {
  sinalDeProducao = criarSinalDeTrabalho();
}
