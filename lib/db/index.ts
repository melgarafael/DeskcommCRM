/**
 * A PORTA ÚNICA DO POSTGRES (#3715, fase F0/F1).
 *
 * O produto falava com o banco pelo PostgREST (`supabase-js`): a consulta era
 * uma CADEIA de métodos (`from().select().eq().maybeSingle()`), o erro voltava
 * em `{ error }` e o `count`/`range` vinham de headers HTTP. Aqui a mesma
 * pergunta vira SQL escrito à mão, com parâmetros vinculados (`$1`, `$2`…) e
 * erro em EXCEÇÃO — nunca concatenação de string, nunca ORM.
 *
 * ═══ POR QUE ESTE ARQUIVO NÃO CRIA POOL ═══
 *
 * A fábrica já existe e é madura: `lib/agent-engine/db/pool.ts` (com
 * `query_timeout`, `keepAlive`, teto por `DB_POOL_MAX` e listener por cliente —
 * o comentário de lá explica os DOIS modos de crash que ela evita). Duplicar
 * `new pg.Pool(...)` aqui reintroduziria justamente os crashs que ela resolve,
 * e é o que `lib/ai/skills/db.ts` já evita. Esta porta só troca o consumidor:
 * um pool por processo, criado no primeiro uso (nunca no import do módulo) e
 * compartilhado por todo mundo que importar daqui.
 *
 * ═══ QUEM PODE IMPORTAR ═══
 *
 * `lib/` e `app/` (server). Nunca `components/`/`hooks/`: o frontend não fala
 * com o banco, e continua sem falar depois desta fase.
 */
import type pg from "pg";

import { createPool } from "@/lib/agent-engine/db/pool";
import { env } from "@/lib/env";

/** Parâmetros vinculados na ordem dos `$1`, `$2`… do SQL. */
export type Parametros = readonly unknown[];

/**
 * O que um domínio precisa do banco. Dois métodos, de propósito: é o formato
 * que cobre ~90% da superfície medida do produto (`select … where … limit 1`,
 * `insert … returning`, `update`) sem oferecer atalho para montar SQL por
 * concatenção — quem quiser mais escreve mais SQL, não um método novo.
 */
export interface Db {
  /** Todas as linhas. Sem `limit` no SQL, o banco devolve o que houver. */
  query<T>(sql: string, parametros?: Parametros): Promise<T[]>;
  /**
   * Zero ou uma linha — o `.maybeSingle()` do PostgREST.
   *
   * Mais de uma linha é ERRO, não "pega a primeira": o PostgREST devolvia
   * `PGRST116` nesse caso, e engolir isso transformaria um `where` frouxo em
   * resultado silenciosamente errado. Todo SQL que passa por aqui declara
   * `limit 1`; o throw é a rede para o dia em que alguém esquecer.
   */
  queryOne<T>(sql: string, parametros?: Parametros): Promise<T | null>;
}

class PortaDoPool implements Db {
  constructor(private readonly pool: pg.Pool) {}

  async query<T>(sql: string, parametros: Parametros = []): Promise<T[]> {
    const resultado = await this.pool.query(sql, parametros as unknown[]);
    return resultado.rows as T[];
  }

  async queryOne<T>(sql: string, parametros: Parametros = []): Promise<T | null> {
    const linhas = await this.query<T>(sql, parametros);
    if (linhas.length > 1) {
      throw new Error(`queryOne devolveu ${linhas.length} linhas — o SQL precisa de limit 1`);
    }
    return linhas[0] ?? null;
  }
}

/** Liga a porta a um pool já existente — a forma que os testes usam. */
export function criarPorta(pool: pg.Pool): Db {
  return new PortaDoPool(pool);
}

let porta: Db | undefined;

/** A porta do processo (singleton lazy): 1 pool, criado no primeiro uso. */
export function portaDaAplicacao(): Db {
  if (!porta) porta = criarPorta(createPool(env.SUPABASE_DB_URL));
  return porta;
}

export function query<T>(sql: string, parametros?: Parametros): Promise<T[]> {
  return portaDaAplicacao().query<T>(sql, parametros);
}

export function queryOne<T>(sql: string, parametros?: Parametros): Promise<T | null> {
  return portaDaAplicacao().queryOne<T>(sql, parametros);
}

