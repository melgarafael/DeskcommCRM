/**
 * UM DRENO POR VEZ — a trava de PASSADA do `event_log` (issue #2235).
 *
 * ## O defeito
 *
 * `app/api/v1/cron/event-log-drain` é armado por DOIS agendadores na mesma
 * instalação:
 *
 *   1. o cron do contêiner — `docker/scheduler/entrypoint.sh:59`
 *      (`* * * * *|45|api/v1/cron/event-log-drain`);
 *   2. o crontab do host que o kit grava — `hostgator-setup-kit/_common.sh`,
 *      `setup_event_log_drain_cron` (`install.sh` e `update.sh` chamam), que
 *      aponta para `${NEXT_PUBLIC_APP_URL}/api/v1/cron/event-log-drain`.
 *
 * Numa instalação que usa o contêiner E rodou o kit, os dois batem na MESMA
 * rota no mesmo minuto. Medido na issue: com as abas do painel fechadas, ~62%
 * das chamadas `service_role` ao PostgREST eram na `event_log` — duas varreduras
 * de até 50 linhas por minuto onde uma bastava, que é egress pago no free.
 *
 * ## Por que a trava é no BANCO
 *
 * Os dois agendadores são processos DIFERENTES (cron do contêiner `scheduler` e
 * cron do host), e a rota pode rodar em mais de uma instância do app. Uma flag
 * de módulo (`let drenando = false`) só enxergaria o próprio processo: é
 * exatamente o tipo de trava que "funciona" no teste de um processo só e não
 * serializa nada entre contêineres. O único ponto que TODOS os drenos
 * compartilham é o Postgres — então é lá que a trava mora.
 *
 * ## Por que `pg_try_advisory_lock` de SESSÃO, e não `pg_try_advisory_xact_lock`
 *
 * A passada é feita de dezenas de statements independentes pelo PostgREST; cada
 * um é a SUA transação. Um `xact_lock` morreria no fim do primeiro statement e
 * não cobriria nada do que vem depois. O lock de sessão fica preso na conexão
 * dedicada que este módulo pega do pool (`pool.connect()`), atravessa a passada
 * inteira e é liberado em `finally` — por `pg_advisory_unlock` no caso normal e,
 * se o unlock falhar, `release(erro)` derruba a conexão (o lock de sessão morre
 * junto), que é a mesma disciplina de `lib/prospecting/store.ts` (#2624).
 *
 * Bônus sobre uma trava por linha de tabela (`locked_until`): não existe TTL nem
 * lease vencido. Se o processo levar SIGKILL no meio da passada, o Postgres
 * derruba a conexão e o lock some sozinho — sem varredura de "trava órfã".
 *
 * ## Por que quem não pega responde 200, e não 409
 *
 * Os dois agendadores são `curl` de crontab: QUALQUER resposta não-2xx vira
 * falha (e, no kit, sai no log/relatório a cada minuto). "Outro dreno está
 * rodando agora" não é erro — é o funcionamento normal da redundância. Então o
 * segundo dreno responde 200 com um campo explícito (`pulado: "outro_dreno"`) e
 * não processa nada.
 *
 * ## Sem `SUPABASE_DB_URL` não há trava — e o dreno segue
 *
 * A conexão direta é opcional no produto (a porta normal é o PostgREST). Sem
 * ela, `poolDoDreno()` devolve `null` e a passada roda SEM serializar, com um
 * `warn` — degradar a serialização é melhor que parar a fila de eventos de uma
 * instalação inteira. O claim por linha (`lib/event-log/drain.ts`, "Claim
 * otimista") continua impedindo que a MESMA linha seja executada duas vezes;
 * o que se perde nesse modo é só o corte da passada duplicada.
 */
import type pg from "pg";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { drainEventLog, type DrainSummary } from "@/lib/event-log/drain";
import { logger } from "@/lib/logger";

/**
 * A chave é CONSTANTE de propósito: a passada é global (a fila de todas as
 * organizações), não uma por organização. `hashtextextended` é a mesma função
 * que `lib/prospecting/store.ts` usa para as chaves dele.
 */
const CHAVE_DA_PASSADA = "event-log:drain";

export interface TravaDaPassada {
  /** `true` só quando ESTA passada é a dona do dreno agora. */
  pega: boolean;
  /**
   * `outro_dreno` — outro agendador está drenando; esta passada não faz nada.
   * `sem_conexao` — não há conexão direta para travar (ou a trava falhou);
   *                   a passada segue sem serializar (ver o cabeçalho).
   */
  motivo: "outro_dreno" | "sem_conexao" | null;
  /** Idempotente: chamar duas vezes não estraga nada. */
  liberar(): Promise<void>;
}

/** O que a rota responde quando outra passada está drenando — 200, nunca 409. */
export interface ResumoPulado {
  ok: true;
  pulado: "outro_dreno";
}

/**
 * O pool da conexão direta, ou `null` quando a instalação não tem
 * `SUPABASE_DB_URL`. Nunca lança: quem chama decide o que fazer sem trava.
 */
export function poolDoDreno(): pg.Pool | null {
  try {
    return getRequestPool();
  } catch {
    return null;
  }
}

/** Pega a trava de passada numa conexão DEDICADA do pool. Nunca lança. */
export async function pegarTravaDoDreno(pool: pg.Pool | null): Promise<TravaDaPassada> {
  if (!pool) return { pega: false, motivo: "sem_conexao", liberar: async () => {} };

  let cliente: pg.PoolClient;
  try {
    cliente = await pool.connect();
  } catch (err) {
    logger.warn("[event-log.drain] sem conexão para a trava — passada segue sem serializar", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { pega: false, motivo: "sem_conexao", liberar: async () => {} };
  }

  let pega = false;
  try {
    const { rows } = await cliente.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [CHAVE_DA_PASSADA],
    );
    pega = rows[0]?.locked === true;
  } catch (err) {
    logger.warn("[event-log.drain] pg_try_advisory_lock falhou — passada segue sem serializar", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Estado da conexão é incerto: ela NÃO volta ao pool.
    cliente.release(err instanceof Error ? err : new Error(String(err)));
    return { pega: false, motivo: "sem_conexao", liberar: async () => {} };
  }

  if (!pega) {
    cliente.release();
    return { pega: false, motivo: "outro_dreno", liberar: async () => {} };
  }

  return {
    pega: true,
    motivo: null,
    liberar: async () => {
      let erroNoUnlock: Error | undefined;
      try {
        await cliente.query("select pg_advisory_unlock(hashtextextended($1, 0))", [CHAVE_DA_PASSADA]);
      } catch (err) {
        // Como em `withProspectingLock` (#2624): o lock de sessão só morre com a
        // conexão. Devolver o cliente COM erro faz o pool derrubá-la em vez de
        // reemprestá-la com o bloqueio ainda preso.
        erroNoUnlock = err instanceof Error ? err : new Error(String(err));
      }
      cliente.release(erroNoUnlock);
    },
  };
}

/**
 * A passada do cron: trava → drena → solta. É o ÚNICO caminho que a rota usa.
 *
 * `opts.pool === undefined` resolve o pool do processo (`SUPABASE_DB_URL`);
 * `null` explícito diz "não trave" (é o que o teste de concorrência NÃO usa —
 * ele injeta um pool de verdade para provar a trava contra o Postgres).
 */
export async function drenarSozinho(
  admin: Parameters<typeof drainEventLog>[0],
  opts: {
    limit?: number;
    varrerPresos?: boolean;
    pool?: pg.Pool | null;
  } = {},
): Promise<DrainSummary | ResumoPulado> {
  const pool = opts.pool === undefined ? poolDoDreno() : opts.pool;
  const trava = await pegarTravaDoDreno(pool);

  if (!trava.pega && trava.motivo === "outro_dreno") {
    logger.info("[event-log.drain] outra passada está drenando — esta não toca a fila");
    return { ok: true, pulado: "outro_dreno" };
  }

  try {
    return await drainEventLog(admin, { limit: opts.limit, varrerPresos: opts.varrerPresos });
  } finally {
    await trava.liberar();
  }
}
