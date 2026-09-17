/**
 * Um `SupabaseClient` de MENTIRA, feito de `pg` de VERDADE.
 *
 * ═══ POR QUE ISTO EXISTE ═══
 *
 * `pnpm test:db` sobe Postgres puro, **sem PostgREST** — de propósito
 * (`vitest.db.config.ts` aponta `NEXT_PUBLIC_SUPABASE_URL` para uma porta
 * inalcançável). Então código que fala `supabase.from(...)` não tinha como ser
 * exercitado ali: só dava para reescrever a consulta em SQL ao lado e conferir
 * que o banco se defende — o que prova o BANCO, nunca o CÓDIGO.
 *
 * Aqui a decisão do código roda de verdade: quais filtros ele aplica, em que
 * ordem, o que faz com o que volta. O que muda é só o transporte.
 *
 * ═══ O QUE ELE NÃO REPRODUZ (declarado, não estimado) ═══
 *
 * 1. **RLS.** `pg` conecta como `postgres` e passa por cima. Isolamento entre
 *    organizações é medido pelos invariantes que usam papel restrito — não aqui.
 * 2. **Rede.** Timeout, retry e erro de transporte não existem neste caminho.
 * 3. **A superfície inteira do PostgREST.** Só o que está implementado abaixo:
 *    `select/insert` com `eq`, `order`, `limit`, `maybeSingle`, `single` e
 *    embed to-one (`alias:coluna_fk(colunas)`, traduzido para subquery). Um
 *    método não implementado **estoura** em vez de ser ignorado em silêncio —
 *    ver `naoImplementado`. Silêncio aqui viraria teste verde medindo nada.
 *
 * ═══ E SE ELE MENTIR? ═══
 *
 * Um adaptador que ignorasse um `.eq()` deixaria o teste passar pelo motivo
 * errado. Por isso `tests/invariants/pg-como-supabase.test.ts` sabota o próprio
 * adaptador: filtro que não filtra, ordem que não ordena e `maybeSingle` com
 * duas linhas têm caso próprio. O instrumento é medido antes de medir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

interface ErroPg {
  message: string;
  code?: string;
}

export interface RespostaFalsa<T> {
  data: T | null;
  error: ErroPg | null;
}

function naoImplementado(metodo: string): never {
  throw new Error(
    `[pg-como-supabase] '${metodo}' não está implementado. ` +
      "Implemente-o (com caso no teste do adaptador) em vez de contornar — " +
      "método ausente que devolvesse vazio faria o teste passar medindo nada.",
  );
}

function erroDe(e: unknown): ErroPg {
  const bruto = e as { message?: string; code?: string };
  return { message: bruto?.message ?? String(e), code: bruto?.code };
}

/** Aspas em cada coluna: `slug`, `position` e afins são palavras vivas no SQL. */
function colunasSql(colunas: string): string {
  if (colunas.trim() === "*") return "*";
  return fatiarNoTopo(colunas)
    .map((c) => `"${c.trim()}"`)
    .join(", ");
}

/**
 * Fatia por vírgula **de topo** — a que está fora de parênteses.
 *
 * `"id, contacts:contact_id(a, b)"` tem três vírgulas e só DUAS colunas. Um
 * `split(",")` cru quebraria o embed no meio e pediria ao Postgres uma coluna
 * chamada `contacts:contact_id(a`.
 */
function fatiarNoTopo(lista: string): string[] {
  const partes: string[] = [];
  let profundidade = 0;
  let atual = "";
  for (const ch of lista) {
    if (ch === "(") profundidade += 1;
    if (ch === ")") profundidade -= 1;
    if (ch === "," && profundidade === 0) {
      partes.push(atual);
      atual = "";
      continue;
    }
    atual += ch;
  }
  if (atual.trim() !== "") partes.push(atual);
  return partes;
}

/**
 * EMBED do PostgREST — `alias:coluna_fk(colunas)`.
 *
 * Nasceu porque `sendMessageHandler` (a ÚNICA porta de saída de mensagem do
 * produto) lê a conversa com dois embeds — `contacts:contact_id(...)` e
 * `channel_sessions:channel_session_id(...)`. Sem tradução, esse select
 * ESTOURAVA no adaptador, e qualquer invariante sobre o caminho de envio
 * morria num 500 genérico em vez de medir a decisão do handler.
 *
 * A tabela do embed é o ALIAS. É a convenção que o repo inteiro usa (o alias
 * nomeia a tabela referenciada), e o custo de errar é barulhento — `relation
 * "x" does not exist` — nunca silencioso.
 *
 * Zero linhas vira `null`, como o PostgREST devolve para um embed to-one sem
 * correspondente. É o caso real de conversa sem canal.
 */
interface Embed {
  alias: string;
  colunaFk: string;
  colunas: string;
}

function lerEmbed(pedaco: string): Embed | null {
  const m = /^\s*([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)\s*\(([^]*)\)\s*$/.exec(pedaco);
  if (!m) return null;
  return { alias: m[1]!, colunaFk: m[2]!, colunas: m[3]! };
}

function embedSql(e: Embed, aliasExterno: string): string {
  const cols = fatiarNoTopo(e.colunas)
    .map((c) => `"${c.trim()}"`)
    .join(", ");
  return (
    `(select to_jsonb(emb) from (select ${cols} from public."${e.alias}" ` +
    `where "id" = ${aliasExterno}."${e.colunaFk}") emb) as "${e.alias}"`
  );
}

/**
 * Projeção do `select`, já com os embeds traduzidos. Devolve também se houve
 * embed: quando há, o FROM precisa de alias para a subquery poder apontar para
 * a coluna de FK da linha externa.
 */
function projecaoSql(colunas: string, aliasExterno: string): { sql: string; temEmbed: boolean } {
  if (colunas.trim() === "*") return { sql: "*", temEmbed: false };
  let temEmbed = false;
  const sql = fatiarNoTopo(colunas)
    .map((pedaco) => {
      const embed = lerEmbed(pedaco);
      if (!embed) return `"${pedaco.trim()}"`;
      temEmbed = true;
      return embedSql(embed, aliasExterno);
    })
    .join(", ");
  return { sql, temEmbed };
}

class ConsultaPg<T> implements PromiseLike<RespostaFalsa<T[]>> {
  /** [operador, coluna, valor] — o operador entra porque `.lt`/`.gt` existem. */
  private filtros: Array<[string, string, unknown]> = [];
  private ordem: { coluna: string; asc: boolean } | null = null;
  private teto: number | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly tabela: string,
    private readonly colunas: string,
  ) {}

  eq(coluna: string, valor: unknown): this {
    this.filtros.push(["=", coluna, valor]);
    return this;
  }

  /**
   * `<` e `>` — nasceram porque `vencePropostasDeDado` os usa e o adaptador
   * ESTOUROU ao ser chamado. Terceira vez que o `naoImplementado` paga o
   * próprio custo: devolver vazio teria deixado 7 casos verdes medindo nada.
   */
  lt(coluna: string, valor: unknown): this {
    this.filtros.push(["<", coluna, valor]);
    return this;
  }

  gt(coluna: string, valor: unknown): this {
    this.filtros.push([">", coluna, valor]);
    return this;
  }

  /**
   * `>=` e `<=` — QUARTA vez que o `naoImplementado` se paga. Nasceram porque
   * `horariosLivresDaOrg` (consulta.ts:209) filtra as exceções de jornada por
   * intervalo de datas, e o adaptador ESTOUROU no primeiro invariante que
   * exercitou o handler de marcar.
   *
   * E o estouro veio no CONTROLE POSITIVO do teste, não no caso principal: o
   * caso "não marca para o contato de outra org" teria passado por o handler
   * não marcar NADA. Adaptador que devolve vazio em vez de estourar teria
   * transformado um gate de isolamento em decoração.
   */
  gte(coluna: string, valor: unknown): this {
    this.filtros.push([">=", coluna, valor]);
    return this;
  }

  lte(coluna: string, valor: unknown): this {
    this.filtros.push(["<=", coluna, valor]);
    return this;
  }

  order(coluna: string, opts?: { ascending?: boolean }): this {
    this.ordem = { coluna, asc: opts?.ascending !== false };
    return this;
  }

  limit(n: number): this {
    this.teto = n;
    return this;
  }

  /**
   * `in` — QUINTA vez que o `naoImplementado` se paga, e desta vez o estouro
   * veio de um PR de contribuidor: a cascata de LGPD passou a cancelar a régua
   * do contato anonimizado com `.in("status", STATUS_DA_REGUA_VIVA)`
   * (`lib/lgpd/cascata.ts:221`), e o invariante que exercita a anonimização
   * estourou aqui em vez de ficar verde.
   *
   * O que teria acontecido com um `in` que devolvesse vazio: "nenhuma régua
   * viva" é o desfecho natural de uma lista vazia, então o teste passaria
   * afirmando que a cascata cancelou a régua — sem ela ter cancelado nada.
   *
   * `= any($n)` e não `in ($1,$2,…)` porque a lista é um parâmetro só: número
   * variável de placeholders reabriria a porta de montar SQL por concatenação.
   */
  in(coluna: string, valores: readonly unknown[]): this {
    this.filtros.push(["= any", coluna, [...valores]]);
    return this;
  }

  /** Presentes para ESTOURAR: o código que os usar precisa de implementação real. */
  neq(): never {
    return naoImplementado("neq");
  }

  private montar(): { texto: string; valores: unknown[] } {
    const valores: unknown[] = [];
    const onde = this.filtros.map(([op, c, v]) => {
      valores.push(v);
      // `= any` recebe o array inteiro num placeholder só; os demais operadores
      // são infixos comuns.
      if (op === "= any") return `"${c}" = any($${valores.length})`;
      return `"${c}" ${op} $${valores.length}`;
    });
    const projecao = projecaoSql(this.colunas, "linha");
    let texto = `select ${projecao.sql} from public."${this.tabela}"`;
    // O alias só entra quando há embed: a subquery precisa apontar para a
    // coluna de FK DA LINHA EXTERNA, e sem alias a referência seria ambígua.
    if (projecao.temEmbed) texto += " linha";
    if (onde.length > 0) texto += ` where ${onde.join(" and ")}`;
    if (this.ordem) texto += ` order by "${this.ordem.coluna}" ${this.ordem.asc ? "asc" : "desc"}`;
    if (this.teto !== null) texto += ` limit ${this.teto}`;
    return { texto, valores };
  }

  private async linhas(): Promise<{ rows: T[]; error: ErroPg | null }> {
    const { texto, valores } = this.montar();
    try {
      const r = await this.pool.query(texto, valores);
      return { rows: r.rows as T[], error: null };
    } catch (e) {
      return { rows: [], error: erroDe(e) };
    }
  }

  /** Zero linhas → `data: null` SEM erro. Mais de uma → ERRO, como o PostgREST. */
  async maybeSingle(): Promise<RespostaFalsa<T>> {
    const { rows, error } = await this.linhas();
    if (error) return { data: null, error };
    if (rows.length > 1) {
      return {
        data: null,
        error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" },
      };
    }
    return { data: rows[0] ?? null, error: null };
  }

  /** Exige exatamente uma. Zero também é erro — a diferença para `maybeSingle`. */
  async single(): Promise<RespostaFalsa<T>> {
    const { rows, error } = await this.linhas();
    if (error) return { data: null, error };
    if (rows.length !== 1) {
      return {
        data: null,
        error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" },
      };
    }
    return { data: rows[0]!, error: null };
  }

  then<R1 = RespostaFalsa<T[]>, R2 = never>(
    aoResolver?: ((v: RespostaFalsa<T[]>) => R1 | PromiseLike<R1>) | null,
    aoRejeitar?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.linhas()
      .then(({ rows, error }) => (error ? { data: null, error } : { data: rows, error: null }))
      .then(aoResolver, aoRejeitar);
  }
}

class InsercaoPg<T> implements PromiseLike<RespostaFalsa<null>> {
  private colunasDeVolta: string | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly tabela: string,
    private readonly linha: Record<string, unknown>,
  ) {}

  select(colunas = "*"): this {
    this.colunasDeVolta = colunas;
    return this;
  }

  private montar(): { texto: string; valores: unknown[] } {
    const chaves = Object.keys(this.linha);
    const valores = chaves.map((k) => {
      const v = this.linha[k];
      // jsonb/array vão como parâmetro; objeto solto o driver não converte.
      return v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v;
    });
    const marcas = chaves.map((_, i) => `$${i + 1}`).join(", ");
    const texto =
      `insert into public."${this.tabela}" (${chaves.map((k) => `"${k}"`).join(", ")}) values (${marcas})` +
      (this.colunasDeVolta ? ` returning ${colunasSql(this.colunasDeVolta)}` : "");
    return { texto, valores };
  }

  async single(): Promise<RespostaFalsa<T>> {
    const { texto, valores } = this.montar();
    try {
      const r = await this.pool.query(texto, valores);
      return { data: (r.rows[0] ?? null) as T, error: null };
    } catch (e) {
      return { data: null, error: erroDe(e) };
    }
  }

  /**
   * Difere de `single` no que faz com o ERRO, não com o sucesso: quem usa
   * `maybeSingle` num insert está dizendo "se não deu, sigo sem" — é o caso do
   * item da Central, que não pode derrubar o vencimento das propostas.
   */
  async maybeSingle(): Promise<RespostaFalsa<T>> {
    return this.single();
  }

  then<R1 = RespostaFalsa<null>, R2 = never>(
    aoResolver?: ((v: RespostaFalsa<null>) => R1 | PromiseLike<R1>) | null,
    aoRejeitar?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    const { texto, valores } = this.montar();
    return this.pool
      .query(texto, valores)
      .then(() => ({ data: null, error: null }) as RespostaFalsa<null>)
      .catch((e: unknown) => ({ data: null, error: erroDe(e) }) as RespostaFalsa<null>)
      .then(aoResolver, aoRejeitar);
  }
}


/**
 * UPDATE com filtros — a forma `.update(obj).eq(a,b).select(cols).maybeSingle()`.
 *
 * Nasceu porque `patchContactHandler` a usa, e o adaptador ESTOUROU ao ser
 * chamado (em vez de devolver vazio, que teria deixado o teste verde medindo
 * nada). O `naoImplementado` fez o trabalho dele.
 */
class AtualizacaoPg<T> implements PromiseLike<RespostaFalsa<unknown>> {
  private filtros: Array<[string, unknown]> = [];
  private colunasDeVolta: string | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly tabela: string,
    private readonly patch: Record<string, unknown>,
  ) {}

  eq(coluna: string, valor: unknown): this {
    this.filtros.push([coluna, valor]);
    return this;
  }

  select(colunas = "*"): this {
    this.colunasDeVolta = colunas;
    return this;
  }

  private montar(): { texto: string; valores: unknown[] } {
    const valores: unknown[] = [];
    const sets = Object.keys(this.patch).map((k) => {
      const v = this.patch[k];
      valores.push(v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);
      return `"${k}" = $${valores.length}`;
    });
    const onde = this.filtros.map(([c, v]) => {
      valores.push(v);
      return `"${c}" = $${valores.length}`;
    });
    let texto = `update public."${this.tabela}" set ${sets.join(", ")}`;
    if (onde.length > 0) texto += ` where ${onde.join(" and ")}`;
    if (this.colunasDeVolta) texto += ` returning ${colunasSql(this.colunasDeVolta)}`;
    return { texto, valores };
  }

  async maybeSingle(): Promise<RespostaFalsa<T>> {
    const { texto, valores } = this.montar();
    try {
      const r = await this.pool.query(texto, valores);
      if (r.rows.length > 1) {
        return { data: null, error: { message: "multiple rows returned", code: "PGRST116" } };
      }
      return { data: (r.rows[0] ?? null) as T, error: null };
    } catch (e) {
      return { data: null, error: erroDe(e) };
    }
  }

  async single(): Promise<RespostaFalsa<T>> {
    const r = await this.maybeSingle();
    if (r.error) return r;
    if (r.data === null) {
      return { data: null, error: { message: "no rows returned", code: "PGRST116" } };
    }
    return r;
  }

  /**
   * ⚠️ Com `.select()`, o `await` direto devolve AS LINHAS — não `null`.
   *
   * A primeira versão devolvia `{data: null}` sempre, e isso quebrava um padrão
   * que o repo usa como TRAVA: `update().eq(id).eq(stage_id).select("id")` e
   * depois `if (linhas.length === 0)` para detectar "um humano moveu o card no
   * meio da operação". Com `null`, toda escrita bem-sucedida virava
   * `conflito_humano` — o adaptador afirmava que a trava tinha disparado
   * quando o UPDATE tinha funcionado.
   *
   * Sem `.select()`, `data: null` continua certo: é o que o PostgREST devolve.
   */
  then<R1 = RespostaFalsa<unknown>, R2 = never>(
    aoResolver?: ((v: RespostaFalsa<unknown>) => R1 | PromiseLike<R1>) | null,
    aoRejeitar?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    const { texto, valores } = this.montar();
    const pediuRetorno = this.colunasDeVolta !== null;
    return this.pool
      .query(texto, valores)
      .then(
        (r) =>
          ({ data: pediuRetorno ? r.rows : null, error: null }) as RespostaFalsa<unknown>,
      )
      .catch((e: unknown) => ({ data: null, error: erroDe(e) }) as RespostaFalsa<unknown>)
      .then(aoResolver, aoRejeitar);
  }
}

/**
 * `rpc(nome, args)` — chamada de função por argumentos NOMEADOS, como o
 * PostgREST faz. Sem isto, todo caminho que emite evento (`emit_event`) morre no
 * meio do handler sob teste.
 */
async function chamarRpc(
  pool: pg.Pool,
  nome: string,
  args: Record<string, unknown>,
): Promise<RespostaFalsa<unknown>> {
  const chaves = Object.keys(args);
  const valores = chaves.map((k) => {
    const v = args[k];
    return v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v;
  });
  const nomeados = chaves.map((k, i) => `${k} => $${i + 1}`).join(", ");
  try {
    const r = await pool.query(`select public."${nome}"(${nomeados}) as valor`, valores);
    return { data: (r.rows[0] as { valor: unknown } | undefined)?.valor ?? null, error: null };
  } catch (e) {
    return { data: null, error: erroDe(e) };
  }
}

/**
 * O cast para `SupabaseClient` é deliberado e está confinado a esta linha: o
 * tipo real tem dezenas de membros que este objeto não tem, e listá-los como
 * `undefined` só esconderia a mesma verdade com mais texto.
 */
export function pgComoSupabase(pool: pg.Pool): SupabaseClient {
  return {
    from(tabela: string) {
      return {
        select: (colunas = "*") => new ConsultaPg(pool, tabela, colunas),
        insert: (linha: Record<string, unknown>) => new InsercaoPg(pool, tabela, linha),
        update: (patch: Record<string, unknown>) => new AtualizacaoPg(pool, tabela, patch),
        delete: () => naoImplementado("delete"),
        upsert: () => naoImplementado("upsert"),
      };
    },
    rpc: (nome: string, args: Record<string, unknown> = {}) => chamarRpc(pool, nome, args),
  } as unknown as SupabaseClient;
}
