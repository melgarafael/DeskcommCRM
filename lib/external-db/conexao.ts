/**
 * Pool de conexões com o banco externo — e a transversal de SOMENTE LEITURA.
 *
 * Cada conexão cadastrada tem o seu pool, memoizado por processo e chaveado por
 * `id + updated_at`: editar a credencial derruba o pool antigo, senão a senha
 * velha continuaria viva em memória depois de trocada.
 *
 * Toda query passa por `consultar()`, que abre `BEGIN READ ONLY` e aplica
 * `statement_timeout`/`lock_timeout` LOCAIS. Fazer isso por transação — e não
 * pelo parâmetro `options` do pool — é deliberado: `options` de startup é
 * recusado por alguns poolers (o PgBouncer do Supabase, por exemplo) e derruba a
 * conexão inteira; `SET LOCAL` funciona em qualquer um e garante o mesmo efeito
 * de leitura obrigatória.
 *
 * O teto de pools é finito: sem ele, uma instalação com muitas conexões abertas
 * esgota sockets do processo.
 */
import pg from "pg";

import { logger } from "@/lib/logger";

import type { ConexaoExterna, ModoTls } from "./types";

const MAX_POOLS = 32;
const MAX_CONEXOES_POR_POOL = 2;
const CONNECTION_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;
const STATEMENT_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_TX_TIMEOUT_MS = 15_000;

type Entrada = { chave: string; pool: pg.Pool };
const pools = new Map<string, Entrada>();

function chaveDaConexao(c: ConexaoExterna): string {
  return [c.id, c.versao, c.host, c.port, c.database, c.username, c.sslMode].join("\u0000");
}

function sslPara(modo: ModoTls): pg.PoolConfig["ssl"] {
  switch (modo) {
    case "disable":
      return false;
    case "prefer":
    case "require":
      // Sem CA configurada não há como verificar a cadeia; `require` cifra mesmo
      // assim. `verify-*` usa as CAs do sistema e falha fechado se não bater.
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
  }
}

function configDe(c: ConexaoExterna): pg.PoolConfig {
  return {
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.username,
    password: c.password,
    ssl: sslPara(c.sslMode),
    max: MAX_CONEXOES_POR_POOL,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    application_name: "external-db-readonly",
  };
}

function handlerDeErro(connectionId: string): (err: Error) => void {
  return (err: Error) => {
    const erro = (err.message.split("\n", 1)[0] ?? "").slice(0, 300);
    logger.warn("[external-db.pool] conexão caiu — recria no próximo uso", { connectionId, erro });
  };
}

function evictarSeNecessario(): void {
  while (pools.size > MAX_POOLS) {
    const primeira = pools.keys().next().value as string | undefined;
    if (primeira === undefined) return;
    const entrada = pools.get(primeira);
    pools.delete(primeira);
    if (entrada) void entrada.pool.end().catch(() => undefined);
  }
}

/** Pool da conexão, criando/invalidando conforme o cadastro atual. */
export function obterPool(c: ConexaoExterna): pg.Pool {
  const chave = chaveDaConexao(c);
  const existente = pools.get(c.id);
  if (existente && existente.chave === chave) {
    pools.delete(c.id);
    pools.set(c.id, existente); // toque de LRU
    return existente.pool;
  }
  if (existente) {
    pools.delete(c.id);
    void existente.pool.end().catch(() => undefined);
  }
  const pool = new pg.Pool(configDe(c));
  pool.on("connect", (client) => client.on("error", handlerDeErro(c.id)));
  pool.on("error", () => undefined);
  pools.set(c.id, { chave, pool });
  evictarSeNecessario();
  return pool;
}

/** Derruba o pool da conexão (usar ao desabilitar/editar/apagar). */
export async function fecharPool(connectionId: string): Promise<void> {
  const entrada = pools.get(connectionId);
  if (!entrada) return;
  pools.delete(connectionId);
  await entrada.pool.end().catch(() => undefined);
}

/** Encerra todos os pools — usado em testes e no desligamento do processo. */
export async function fecharTodosOsPools(): Promise<void> {
  const entradas = [...pools.values()];
  pools.clear();
  await Promise.all(entradas.map((e) => e.pool.end().catch(() => undefined)));
}

/**
 * Roda um SELECT dentro de `BEGIN READ ONLY`. A seleção só-leitura é imposta
 * pelo Postgres, não por análise de string: mesmo que algo escapasse da
 * validação de identificadores, um `INSERT`/`UPDATE`/DDL seria recusado aqui.
 */
export async function consultar<T extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool,
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`set local lock_timeout = ${LOCK_TIMEOUT_MS}`);
    await client.query(`set local idle_in_transaction_session_timeout = ${IDLE_TX_TIMEOUT_MS}`);
    const resultado = await client.query<T>(text, values);
    await client.query("commit");
    return resultado;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type ResultadoDeTeste = { ok: true } | { ok: false; erro: string };

function mensagemSegura(err: unknown): string {
  if (err instanceof Error) {
    // Primeira linha, truncada. A senha não aparece em erro do pg; ainda assim
    // não ecoamos o objeto inteiro.
    return (err.message.split("\n", 1)[0] ?? "erro desconhecido").slice(0, 300);
  }
  return "erro desconhecido";
}

/** Testa a conexão com um Client descartável, sem poluir o cache de pools. */
export async function testarConexao(c: ConexaoExterna): Promise<ResultadoDeTeste> {
  const client = new pg.Client(configDe(c));
  // O erro do socket é tratado pelo catch; sem listener o Node derruba o processo
  // se o servidor cair no meio do teste.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, erro: mensagemSegura(err) };
  } finally {
    await client.end().catch(() => undefined);
  }
}
