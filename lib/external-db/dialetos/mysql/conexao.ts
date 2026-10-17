/**
 * Pool, consulta SOMENTE LEITURA e teste de conexão do MySQL.
 *
 * Espelha `lib/external-db/conexao.ts` (PostgreSQL): um pool por conexão
 * cadastrada, memoizado por processo e chaveado pela versão do cadastro
 * (editar a credencial derruba o pool antigo); teto de pools; `consultar` por
 * transação `READ ONLY`.
 *
 * AS TRAVAS SÃO APLICADAS A CADA VEZ QUE A CONEXÃO É EMPRESTADA — nunca só na
 * criação do pool. No PostgreSQL o `SET LOCAL` morre no fim da transação; no
 * MySQL o `SET SESSION` FICA PRESO na conexão reutilizada, então ele é refeito a
 * cada empréstimo (e só vale para a sessão que o MySQL devolveu).
 *
 * `execute` (preparado de verdade no servidor) em vez de `query` (que escapa no
 * cliente): o valor nunca vira texto do SQL, como o `$n` do PostgreSQL.
 * `flags: ["-LOCAL_FILES"]`: um servidor hostil não pode pedir arquivo da máquina
 * do cliente (`LOAD DATA LOCAL`). Fatos do driver INFERIDOS (documentação): a
 * Fatia 4a-2b os mede num MySQL de verdade.
 */
import mysql from "mysql2/promise";
import type { PoolOptions } from "mysql2/promise";

import { logger } from "@/lib/logger";

import { interpretarGrants, AVISO_SEM_CONFERIR } from "./grants";
import type { ResultadoDeTeste } from "../../conexao";
import type { ConexaoExterna, ModoTls } from "../../types";

const MAX_POOLS = 32;
const MAX_CONEXOES_POR_POOL = 2;
const CONNECTION_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_EXECUTION_TIME_MS = 10_000;
const LOCK_WAIT_TIMEOUT_S = 5;

/** O mínimo que o código usa de uma conexão emprestada — e que os testes simulam. */
export interface ConexaoEmprestada {
  query(sql: string): Promise<unknown>;
  execute(sql: string, values: unknown[]): Promise<[unknown, Array<{ name: string }>]>;
  release(): void;
}

export interface PoolMysql {
  getConnection(): Promise<ConexaoEmprestada>;
  end(): Promise<void>;
}

type Entrada = { chave: string; pool: PoolMysql };
const pools = new Map<string, Entrada>();

function chaveDaConexao(c: ConexaoExterna): string {
  return [c.id, c.versao, c.dbType, c.host, c.port, c.database, c.username, c.sslMode].join("\u0000");
}

function sslPara(modo: ModoTls): PoolOptions["ssl"] | undefined {
  switch (modo) {
    case "disable":
      return undefined; // a opção é OMITIDA (não `false`): proposta da spec, confirmada na 4a-2b
    case "prefer":
    case "require":
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
  }
}

/** As opções do `mysql2` de uma conexão. Pura: é o que os testes conferem. */
export function configMysql(c: ConexaoExterna): PoolOptions {
  const ssl = sslPara(c.sslMode);
  return {
    host: c.host,
    port: c.port,
    user: c.username,
    password: c.password,
    database: c.database,
    ...(ssl === undefined ? {} : { ssl }),
    connectionLimit: MAX_CONEXOES_POR_POOL,
    connectTimeout: CONNECTION_TIMEOUT_MS,
    idleTimeout: IDLE_TIMEOUT_MS,
    // Sem LOAD DATA LOCAL, sem segunda sentença, sem converter data pelo fuso do processo.
    flags: ["-LOCAL_FILES"],
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
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
export function obterPoolMysql(c: ConexaoExterna): PoolMysql {
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
  const pool = mysql.createPool(configMysql(c)) as unknown as PoolMysql;
  pools.set(c.id, { chave, pool });
  evictarSeNecessario();
  return pool;
}

export async function fecharPoolMysql(connectionId: string): Promise<void> {
  const entrada = pools.get(connectionId);
  if (!entrada) return;
  pools.delete(connectionId);
  await entrada.pool.end().catch(() => undefined);
}

export async function fecharTodosOsPoolsMysql(): Promise<void> {
  const entradas = [...pools.values()];
  pools.clear();
  await Promise.all(entradas.map((e) => e.pool.end().catch(() => undefined)));
}

export interface ResultadoMysql<T> {
  rows: T[];
  fields: Array<{ name: string }>;
}

/**
 * Roda um SELECT dentro de `START TRANSACTION READ ONLY`, com as travas de tempo
 * refeitas neste empréstimo. A garantia final para tabela MyISAM é NÃO MEDIDA
 * (C1a, Fatia 4a-2b): por isso há outras camadas (só geramos `SELECT`, usuário
 * só-leitura, aviso no teste).
 */
export async function consultarMysql<T = Record<string, unknown>>(
  pool: PoolMysql,
  sql: string,
  values: unknown[] = [],
): Promise<ResultadoMysql<T>> {
  const conexao = await pool.getConnection();
  try {
    await conexao.query(`SET SESSION max_execution_time = ${MAX_EXECUTION_TIME_MS}`);
    await conexao.query(`SET SESSION lock_wait_timeout = ${LOCK_WAIT_TIMEOUT_S}`);
    await conexao.query("START TRANSACTION READ ONLY");
    // `execute` não aceita `undefined`.
    const [rows, fields] = await conexao.execute(sql, values.map((v) => (v === undefined ? null : v)));
    await conexao.query("COMMIT");
    return { rows: rows as T[], fields };
  } catch (err) {
    await conexao.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    conexao.release();
  }
}

function mensagemSegura(err: unknown): string {
  if (err instanceof Error) {
    // Primeira linha, truncada: o erro do driver pode citar host/porta, nunca a senha.
    return (err.message.split("\n", 1)[0] ?? "erro desconhecido").slice(0, 300);
  }
  return "erro desconhecido";
}

/**
 * Testa a conexão com um cliente descartável (sem poluir o cache de pools) e lê o
 * `SHOW GRANTS` para o aviso de privilégio. Falhar ao ler os privilégios NÃO
 * derruba o teste: a conexão funciona, só não deu para conferir o usuário.
 */
export async function testarConexaoMysql(c: ConexaoExterna): Promise<ResultadoDeTeste> {
  let cliente: Awaited<ReturnType<typeof mysql.createConnection>> | null = null;
  try {
    cliente = await mysql.createConnection(configMysql(c));
    cliente.on("error", () => undefined);
    await cliente.query("SELECT 1");
    let aviso: string | null;
    try {
      const [linhas] = (await cliente.query("SHOW GRANTS")) as unknown as [Array<Record<string, unknown>>, unknown];
      aviso = interpretarGrants(
        linhas.map((l) => String(Object.values(l)[0] ?? "")),
        c.database,
      );
    } catch (err) {
      logger.warn("[external-db.mysql] SHOW GRANTS falhou", { connectionId: c.id, erro: mensagemSegura(err) });
      aviso = AVISO_SEM_CONFERIR;
    }
    return aviso === null ? { ok: true } : { ok: true, aviso };
  } catch (err) {
    return { ok: false, erro: mensagemSegura(err) };
  } finally {
    await cliente?.end().catch(() => undefined);
  }
}
