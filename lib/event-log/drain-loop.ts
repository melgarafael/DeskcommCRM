/**
 * O laço que roda os handlers do `event_log` DENTRO do worker.
 *
 * ─── Por que ele existe ──────────────────────────────────────────────────────
 *
 * Os handlers de `register-handlers.ts` (mídia, branding, follow-up, aviso ao
 * suporte…) só tinham UM acionador: o cron `app/api/v1/cron/event-log-drain`,
 * agendado
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
 * (`lib/agent-engine/edge/crm/drain.ts`) espera no máximo 120s pela derivação e
 * então despacha SEM o texto — e o agente responde "não consigo ouvir áudio"
 * com a transcrição chegando ao banco meio minuto depois. Os 3,9s provam que a
 * lentidão não é do Whisper: é fila de cron.
 *
 * 120s cobre dois saltos de cron, mas mal cobre um salto de RECUO: o recuo
 * ocioso deste laço chega a 30s (teto default), e um áudio lento (86s medidos)
 * faz 30+86 = 116 — 4s de folga; com o teto a 60s seriam 146 > 120 e o "não
 * consegui ouvir" voltaria. É por isso que existe o
 * `sinal-de-trabalho.ts`: quando o drain do turno adia por mídia ainda sendo
 * transcrita, ele ACORDA este laço, e a soneca sai na hora em vez de esperar o
 * teto do recuo. Sem ele, o recuo teria de voltar a 10s (o tráfego que o #3693
 * tirou) para o teto de 120s voltar a caber.
 *
 * ─── Por que o cron continua ─────────────────────────────────────────────────
 *
 * Ele vira rede de segurança: worker fora do ar não pode significar event_log
 * parado. Rodar os dois em paralelo é seguro porque `drainEventLog` reivindica
 * cada linha com um claim otimista (`update … where id = $1 and status =
 * 'pending'` e prazo de retry elegível) e pula o que outra instância já pegou
 * ou adiou — ver `drain.ts`.
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
import { sincronizarAvisoDoLacoDeEventLog } from '@/lib/event-log/aviso-do-laco';
import {
  sinalDeTrabalhoDoLacoDeEventLog,
  type SinalDeTrabalhoDeEventLog,
} from '@/lib/event-log/sinal-de-trabalho';
// `import type` e nunca import de valor: em runtime esta linha desaparece, e é
// isso que mantém a cadeia que termina em `@/lib/env` fora do boot do worker.
import type { DrainSummary } from '@/lib/event-log/drain';

export interface EventLogDrainKnobs {
  /** Espera entre ticks que FIZERAM trabalho. */
  intervalMs: number;
  /** Espera entre ticks ociosos — o piso do recuo. */
  idleIntervalMs: number;
  /**
   * Teto do recuo exponencial do ocioso. Sem ele o recuo cresceria sem limite e
   * um evento que chegasse às 3h esperaria horas pelo próximo tick.
   */
  idleMaxMs: number;
  /**
   * Intervalo MÁXIMO entre duas varreduras de `processing` preso. A varredura
   * procura linhas minutos atrasadas (`PROCESSING_STALE_MS` = 10 min), então
   * executá-la a cada tick é 6× mais trabalho do que a janela exige.
   */
  staleSweepMs: number;
  /** Teto de eventos por tick. */
  batchSize: number;
}

// Assinatura escrita à mão em vez de `typeof import(...)`: a regra
// `consistent-type-imports` proíbe a anotação `import()`. A atribuição em
// `carregarDepsDoLaco` é o que mantém as duas honestas — divergiu, o typecheck acusa.
type DrainFn = (
  admin: SupabaseClient,
  opts?: { limit?: number; varrerPresos?: boolean },
) => Promise<DrainSummary>;

interface Deps {
  drainEventLog: DrainFn;
  admin: SupabaseClient;
}

/**
 * O que o laço aceita de fora, além dos knobs. Hoje só o sinal de trabalho: o
 * teste injeta um sinal próprio para medir o corte da soneca com relógio falso,
 * sem que o caso anterior deixe um pedido pendente para o seguinte.
 */
export interface DepsDoLaco {
  sinal?: SinalDeTrabalhoDeEventLog;
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
  let adminParaAviso: SupabaseClient | null = null;

  try {
    // O admin sobe PRIMEIRO de propósito: se um import posterior do drain ou dos
    // handlers quebrar, ainda existe um canal independente para contar o
    // incidente na Central. Se o próprio admin não subir, o /healthz + log.error
    // continuam sendo as redes de segurança e a notificação vira best-effort.
    const { createAdminClient } = await import('@/lib/supabase/admin');
    adminParaAviso = createAdminClient();
    const { drainEventLog } = await import('@/lib/event-log/drain');
    const { ensureHandlersRegistered } = await import('@/lib/event-log/register-handlers');
    ensureHandlersRegistered();

    const deps: Deps = { drainEventLog, admin: adminParaAviso };
    // A prontidão sai ANTES de resolver o aviso antigo: ela depende só das deps,
    // e o round-trip até a Central não pode deixar o /healthz dizendo
    // `carregado:false` com o laço já montado.
    prontidao = { carregado: true, motivo: null };
    log.info(MARCA_LACO_CARREGADO, { carregado: true });
    await sincronizarAvisoDoLacoDeEventLog(adminParaAviso, 'saudavel', log);
    return deps;
  } catch (err) {
    const motivo = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    prontidao = { carregado: false, motivo };
    // `error`, e não o `warn` de antes: laço que não carrega é INCIDENTE, não
    // aviso. Com `warn` o defeito da #648 era indistinguível de ruído por dez
    // dias; agora ele é o que o gate procura no log e o que o `/healthz`
    // publica em `event_log_drain`.
    //
    // Não nomeia mais "admin client": `drain`, `register-handlers` OU o admin
    // podem ter sido a dependência que falhou. Acusar uma só manda o operador
    // investigar o componente errado.
    log.error(
      'event-log drain OFF — falha ao carregar dependências do laço; os handlers seguem só pelo cron event-log-drain',
      { error: motivo },
    );

    // Sem o admin client não há por onde avisar a Central: tentar de novo
    // falharia pelo mesmo motivo. O /healthz e o log.error acima seguem sendo
    // o sinal.
    if (adminParaAviso) {
      await sincronizarAvisoDoLacoDeEventLog(adminParaAviso, 'degradado', log);
    }
    return null;
  }
}

/**
 * Clamp do expoente. `2 ** 30` já supera qualquer teto razoável (10 s × 2³⁰ ≈
 * 340 anos) e segue sendo um número exato — sem isto, um contador absurdo
 * (`MAX_SAFE_INTEGER`, `Infinity`) faria `2 ** rodadas` virar `Infinity`, e a
 * espera do laço deixaria de ser um número.
 */
const EXPOENTE_MAXIMO = 30;

/**
 * O teto do recuo, normalizado.
 *
 * `Math.max(idleIntervalMs, idleMaxMs)` porque um teto ABAIXO do piso não pode
 * tornar o ocioso MAIS rápido que o de hoje: quem configurar errado paga o ritmo
 * antigo, não um laço girando mais que antes. Teto não numérico cai no piso.
 */
function tetoDoRecuo(knobs: EventLogDrainKnobs): number {
  const teto = knobs.idleMaxMs;
  if (!Number.isFinite(teto) || teto <= 0) return knobs.idleIntervalMs;
  return Math.max(knobs.idleIntervalMs, teto);
}

/** Contador de rodadas ociosas saneado: inteiro, não negativo, dentro do clamp. */
function rodadasValidas(rodadas: number): number {
  if (!Number.isFinite(rodadas) || rodadas <= 0) return 0;
  return Math.min(Math.floor(rodadas), EXPOENTE_MAXIMO);
}

/**
 * Quantas rodadas ociosas até o recuo bater no teto — `ceil(log2(teto/piso))`.
 *
 * O laço usa isto para saber quando está no teto: lá a varredura de presos roda
 * SEMPRE, e é assim que a varredura menos frequente nunca fica sem um teto
 * superior de espera.
 */
export function rodadasAteOTeto(knobs: EventLogDrainKnobs): number {
  const teto = tetoDoRecuo(knobs);
  if (!(knobs.idleIntervalMs > 0) || teto <= knobs.idleIntervalMs) return 0;
  return Math.min(Math.ceil(Math.log2(teto / knobs.idleIntervalMs)), EXPOENTE_MAXIMO);
}

/** A espera de uma rodada ociosa: `min(piso × 2^rodadas, teto)`. */
export function esperaOciosa(knobs: EventLogDrainKnobs, rodadasOciosas: number): number {
  const espera = knobs.idleIntervalMs * 2 ** rodadasValidas(rodadasOciosas);
  return Math.min(espera, tetoDoRecuo(knobs));
}

/** O contador da PRÓXIMA rodada: trabalho zera, ocioso soma um. */
export function proximaRodadaOciosa(resumo: DrainSummary, rodadasOciosas: number): number {
  const feitos = resumo.done + resumo.retried + resumo.failed + resumo.dead;
  if (feitos > 0) return 0;
  return Math.min(rodadasValidas(rodadasOciosas) + 1, EXPOENTE_MAXIMO);
}

/**
 * A regra de ritmo, sem relógio: tick que MEXEU em alguma linha mantém o laço
 * rápido (e zera o recuo); tick ocioso recua — 10 s, 20 s, 30 s, 30 s… (com o teto default)
 *
 * `rodadasOciosas` é quantas rodadas ociosas CONSECUTIVAS já passaram. O relógio
 * e o contador moram no laço (`runEventLogDrainLoop`), não aqui: esta função
 * continua pura, e é por isso que o teste consegue medir a regra sem esperar.
 *
 * `scanned` fica de fora da conta de propósito. Linha que outra instância (o
 * cron, outro worker) reivindicou primeiro é varrida e NÃO processada —
 * contá-la manteria o laço no ritmo rápido girando à toa toda vez que o cron
 * chegasse antes.
 */
export function proximaEspera(
  resumo: DrainSummary,
  knobs: EventLogDrainKnobs,
  rodadasOciosas = 0,
): number {
  const feitos = resumo.done + resumo.retried + resumo.failed + resumo.dead;
  return feitos > 0 ? knobs.intervalMs : esperaOciosa(knobs, rodadasOciosas);
}

/**
 * A soneca do laço. Quem corta é `dormir()` do sinal: `acordar()` resolve a
 * espera em curso, e o pedido feito sem ninguém dormindo é gasto aqui — o
 * `esperar(ms, signal)` local que existia antes não tinha como ser acordado, e o
 * teto do recuo era o preço que o primeiro evento de uma instalação parada
 * pagava (ver `sinal-de-trabalho.ts`).
 */
export async function runEventLogDrainLoop(
  knobs: EventLogDrainKnobs,
  log: Logger,
  signal: AbortSignal,
  opts: DepsDoLaco = {},
): Promise<void> {
  const deps = await carregarDepsDoLaco(log);
  if (!deps) return;

  const sinal = opts.sinal ?? sinalDeTrabalhoDoLacoDeEventLog();

  // O contador e o relógio moram AQUI, não na regra: `proximaEspera` continua
  // pura e é o laço quem sabe quantas voltas ociosas já passaram.
  let rodadasOciosas = 0;
  // `-Infinity` = o PRIMEIRO tick sempre varre `processing` preso; sem isso o
  // worker recém-subido esperaria um minuto para recuperar o evento que a
  // queda anterior deixou preso.
  let ultimaVarreduraMs = Number.NEGATIVE_INFINITY;
  const noTetoAPartirDe = rodadasAteOTeto(knobs);
  const vazio: DrainSummary = { scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 };

  while (!signal.aborted) {
    // O tick paga o corte da soneca anterior: daqui para baixo, um `acordar()`
    // novo volta a comprar um tick.
    sinal.inicioDoTick();
    // Tick que EXPLODE não pode acelerar o laço: no erro não há resumo, e o
    // erro conta como rodada ociosa — um banco fora do ar lançaria a cada
    // iteração, e o ritmo rápido transformaria a indisponibilidade numa
    // tempestade de tentativas.
    let espera = esperaOciosa(knobs, rodadasOciosas);
    try {
      // A segunda leitura da rodada (os `processing` com `updated_at` velho)
      // procura linhas MINUTOS atrasadas — rodá-la a cada 10 s era trabalho sem
      // retorno. Ela roda no primeiro tick, sempre que o recuo chega ao teto
      // (logo, no máximo um teto de espera entre duas varreduras) e no máximo
      // uma vez por `staleSweepMs`.
      const agora = Date.now();
      const noTeto = rodadasOciosas >= noTetoAPartirDe;
      const varrerPresos = noTeto || agora - ultimaVarreduraMs >= knobs.staleSweepMs;
      if (varrerPresos) ultimaVarreduraMs = agora;

      const resumo = await deps.drainEventLog(deps.admin, {
        limit: knobs.batchSize,
        varrerPresos,
      });
      espera = proximaEspera(resumo, knobs, rodadasOciosas);
      rodadasOciosas = proximaRodadaOciosa(resumo, rodadasOciosas);
      if (resumo.done + resumo.retried + resumo.failed + resumo.dead > 0) {
        log.info('event-log drain: tick', { ...resumo });
      }
    } catch (err) {
      log.error('event-log drain: tick falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
      rodadasOciosas = proximaRodadaOciosa(vazio, rodadasOciosas);
      espera = esperaOciosa(knobs, rodadasOciosas);
    }
    await sinal.dormir(espera, signal);
  }
}
