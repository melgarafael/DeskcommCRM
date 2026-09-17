/**
 * O laço que roda os handlers do `event_log` DENTRO do worker.
 *
 * ─── Por que ele existe ──────────────────────────────────────────────────────
 *
 * Os 12 handlers de `register-handlers.ts` (mídia, branding, follow-up…) só
 * tinham UM acionador: o cron `app/api/v1/cron/event-log-drain`, agendado
 * `* * * * *` em `docker/scheduler/entrypoint.sh`. Um tick por minuto.
 *
 * Isso é caro quando a cadeia tem mais de um salto. Medido nesta VPS em
 * 2026-08-25, com um áudio recebido pelo canal:
 *
 *   áudio chega → media.persist_requested → (até 60s de fila) → baixa do
 *   provedor do canal → media.derive_requested → (até 60s de fila) →
 *   Whisper transcreve em 3,9s
 *
 * Total real: 103s e 188s em duas medições. Enquanto isso, o drain do turno
 * (`lib/agent-engine/edge/crm/drain.ts`) espera no máximo 45s pela derivação e
 * então despacha SEM o texto — e o agente responde "não consigo ouvir áudio"
 * com a transcrição chegando ao banco meio minuto depois. Os 3,9s provam que a
 * lentidão não é do Whisper: é fila de cron.
 *
 * 45s é menor que UM tick de cron. Com dois saltos, perder a janela não é azar,
 * é aritmética. Este laço tira o cron do caminho crítico.
 *
 * ─── Por que o cron continua ─────────────────────────────────────────────────
 *
 * Ele vira rede de segurança: worker fora do ar não pode significar event_log
 * parado. Rodar os dois em paralelo é seguro porque `drainEventLog` reivindica
 * cada linha com um claim otimista (`update … where id = $1 and status =
 * 'pending'`) e pula o que outra instância já pegou — ver `drain.ts`.
 *
 * ─── Por que os imports são dinâmicos ────────────────────────────────────────
 *
 * A cadeia `drain → register-handlers → handlers → createAdminClient` termina em
 * `@/lib/env`, que valida ~15 variáveis obrigatórias e faz `throw` no topo do
 * módulo (`lib/env.ts:339`). Importada estaticamente aqui, uma instalação com
 * `.env` mais enxuto veria o WORKER INTEIRO morrer no boot — fila durável, cron
 * e turnos junto — por causa de um laço acessório. É a mesma lei que o CLAUDE.md
 * já escreve para a marca ("resolvedor NUNCA lança"), aplicada onde também vale:
 * o laço se desliga sozinho, avisa, e o resto do worker sobe.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Logger } from '@/lib/agent-engine/obs/logger';
// `import type` e nunca import de valor: em runtime esta linha desaparece, e é
// isso que mantém a cadeia que termina em `@/lib/env` fora do boot do worker.
import type { DrainSummary } from '@/lib/event-log/drain';

export interface EventLogDrainKnobs {
  /** Espera entre ticks que FIZERAM trabalho. */
  intervalMs: number;
  /** Espera entre ticks ociosos — o event_log costuma estar vazio. */
  idleIntervalMs: number;
  /** Teto de eventos por tick. */
  batchSize: number;
}

// Assinatura escrita à mão em vez de `typeof import(...)`: a regra
// `consistent-type-imports` proíbe a anotação `import()`. A atribuição em
// `carregarDepsDoLaco` é o que mantém as duas honestas — divergiu, o typecheck acusa.
type DrainFn = (admin: SupabaseClient, opts?: { limit?: number }) => Promise<DrainSummary>;

interface Deps {
  drainEventLog: DrainFn;
  admin: SupabaseClient;
}

/**
 * A marca que o gate de publicação procura no log do worker.
 *
 * Existe porque `/healthz` de pé NÃO prova laço carregado: na #648 o `import`
 * de `@react-pdf/hyphenate` estourava só sob `tsx`, `carregarDeps()` engolia o
 * erro num `log.warn` e o worker seguiu saudável por dez dias com o event_log
 * parado (issue #604).
 *
 * O texto é CONTRATO entre três lugares: este arquivo,
 * `scripts/sonda-do-laco-de-event-log.ts` e o job do
 * `.github/workflows/publish-image.yml`. O teste
 * `tests/unit/gate-de-publicacao-do-laco-de-event-log.test.ts` compara os dois
 * últimos com este literal — mudar a marca sem mudar quem a procura deixa o
 * CI vermelho, em vez de deixar o gate cego em silêncio.
 */
export const MARCA_LACO_CARREGADO = 'event-log drain: laço carregado';

/** Estado do laço para quem pergunta de fora — hoje, o `/healthz` do worker. */
export interface ProntidaoDoLacoDeEventLog {
  /** `true` só depois de a cadeia inteira (drain + handlers + admin) montar. */
  carregado: boolean;
  /** Motivo curto quando `carregado: false`; `null` quando carregou. */
  motivo: string | null;
}

const AINDA_NAO_TENTOU = 'o laço ainda não tentou carregar';

let prontidao: ProntidaoDoLacoDeEventLog = {
  carregado: false,
  motivo: AINDA_NAO_TENTOU,
};

/**
 * Cópia do estado. Nunca lança: o `/healthz` não pode ser o motivo de o worker
 * cair — quem está degradado não ganha o direito de derrubar o resto.
 */
export function prontidaoDoLacoDeEventLog(): ProntidaoDoLacoDeEventLog {
  return { carregado: prontidao.carregado, motivo: prontidao.motivo };
}

/** Só para teste: volta ao estado de quem ainda não tentou carregar. */
export function _reiniciarProntidaoDoLaco(): void {
  prontidao = { carregado: false, motivo: AINDA_NAO_TENTOU };
}

/**
 * Carrega a cadeia do drain sem deixar que ela derrube o worker.
 *
 * `null` = o laço não roda (e o porquê já foi para o log). Nunca lança.
 *
 * É exportada de propósito: o gate de publicação roda ESTA função, dentro da
 * imagem, antes de publicar (`scripts/sonda-do-laco-de-event-log.ts`). Era
 * exatamente o caminho de boot que ficou quebrado dez dias com o teste verde —
 * um gate que exercitasse uma cópia da cadeia poderia ficar verde enquanto a
 * produção quebrava.
 */
export async function carregarDepsDoLaco(log: Logger): Promise<Deps | null> {
  try {
    const { drainEventLog } = await import('@/lib/event-log/drain');
    const { ensureHandlersRegistered } = await import('@/lib/event-log/register-handlers');
    const { createAdminClient } = await import('@/lib/supabase/admin');
    ensureHandlersRegistered();
    const deps: Deps = { drainEventLog, admin: createAdminClient() };
    prontidao = { carregado: true, motivo: null };
    log.info(MARCA_LACO_CARREGADO, { carregado: true });
    return deps;
  } catch (err) {
    const motivo = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    prontidao = { carregado: false, motivo };
    // `error`, e não o `warn` de antes: laço que não carrega é INCIDENTE, não
    // aviso. Com `warn` o defeito da #648 era indistinguível de ruído por dez
    // dias; agora ele é o que o gate procura no log e o que o `/healthz`
    // publica em `event_log_drain`.
    log.error(
      'event-log drain OFF — não consegui montar o admin client; os handlers seguem só pelo cron event-log-drain',
      { error: motivo },
    );
    return null;
  }
}

/**
 * A regra de ritmo, sem relógio: tick que MEXEU em alguma linha mantém o laço
 * rápido; tick ocioso recua.
 *
 * `scanned` fica de fora da conta de propósito. Linha que outra instância (o
 * cron, outro worker) reivindicou primeiro é varrida e NÃO processada —
 * contá-la manteria o laço no ritmo rápido girando à toa toda vez que o cron
 * chegasse antes.
 */
export function proximaEspera(resumo: DrainSummary, knobs: EventLogDrainKnobs): number {
  const feitos = resumo.done + resumo.retried + resumo.failed + resumo.dead;
  return feitos > 0 ? knobs.intervalMs : knobs.idleIntervalMs;
}

function esperar(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runEventLogDrainLoop(
  knobs: EventLogDrainKnobs,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  const deps = await carregarDepsDoLaco(log);
  if (!deps) return;

  while (!signal.aborted) {
    // Tick que EXPLODE não pode acelerar o laço: sem resumo, vale a espera
    // ociosa. Um banco fora do ar lançaria a cada iteração, e o ritmo rápido
    // transformaria a indisponibilidade numa tempestade de tentativas.
    let espera = knobs.idleIntervalMs;
    try {
      const resumo = await deps.drainEventLog(deps.admin, { limit: knobs.batchSize });
      espera = proximaEspera(resumo, knobs);
      if (resumo.done + resumo.retried + resumo.failed + resumo.dead > 0) {
        log.info('event-log drain: tick', { ...resumo });
      }
    } catch (err) {
      log.error('event-log drain: tick falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
    await esperar(espera, signal);
  }
}
