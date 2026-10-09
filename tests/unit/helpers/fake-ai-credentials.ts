/**
 * Um PostgREST ENXUTO em memória, para os testes da conta por empresa.
 *
 * Só o que `ai_provider_credentials` precisa: `select`/`update`/`insert`/`delete`
 * com `eq` e `lt`, `maybeSingle`/`single` e o builder aguardável (o `update`
 * SEM `select` que a trava usa). A parte que importa é a SEMÂNTICA DO UPDATE
 * CONDICIONAL: o filtro é avaliado contra o estado ATUAL da linha, e o patch
 * só entra se ele casar — é o mesmo que o Postgres faz ao serializar dois
 * `update ... where updated_at < ...` na mesma linha, e é o que a trava de
 * renovação depende para que só um processo vença.
 */
export type Linha = Record<string, unknown>;

type Filtro = { col: string; op: "eq" | "lt"; v: unknown };

export class FakeSupabase {
  linha: Linha | null = null;
  /** Cada operação registrada, para os testes lerem o que foi gravado. */
  operacoes: Array<{ tipo: string; tabela: string; dados?: Record<string, unknown>; filtros: Filtro[] }> = [];

  from(tabela: string) {
    return new Query(this, tabela, undefined);
  }
  fromComLinha(tabela: string, linha: Linha) {
    this.linha = linha;
    return new Query(this, tabela, undefined);
  }
}

class Query {
  private filtros: Filtro[] = [];
  dados?: Record<string, unknown>;
  tipo = "select";
  constructor(
    private db: FakeSupabase,
    private tabela: string,
    dados?: Record<string, unknown>,
  ) {
    this.dados = dados;
  }

  select(_cols?: string) {
    return this;
  }
  eq(col: string, v: unknown) {
    this.filtros.push({ col, op: "eq", v });
    return this;
  }
  lt(col: string, v: unknown) {
    this.filtros.push({ col, op: "lt", v });
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filtros.push({ col, op: "eq", v: vals });
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  update(dados: Record<string, unknown>) {
    this.dados = dados;
    this.tipo = "update";
    return this;
  }
  insert(dados: Record<string, unknown>) {
    this.dados = dados;
    this.tipo = "insert";
    return this;
  }
  delete() {
    this.tipo = "delete";
    return this;
  }

  private casa(linha: Linha): boolean {
    return this.filtros.every((f) => {
      const valor = linha[f.col];
      if (f.op === "eq") {
        if (Array.isArray(f.v)) return f.v.includes(valor);
        return valor === f.v;
      }
      // `lt` sobre timestamp em ISO: a comparação lexicográfica de ISO-8601
      // com o mesmo formato é a mesma ordem do Postgres.
      return String(valor ?? "") < String(f.v);
    });
  }

  private async resolver(unico: boolean) {
    await Promise.resolve();
    const db = this.db;
    db.operacoes.push({ tipo: this.tipo, tabela: this.tabela, dados: this.dados, filtros: this.filtros });
    if (this.tipo === "insert") {
      db.linha = { id: "cred-1", ...this.dados };
      return { data: { id: db.linha.id }, error: null };
    }
    const atual = db.linha;
    if (!atual || !this.casa(atual)) {
      // update que não casa = 0 linhas, igual ao Postgres; select sem match = null.
      return { data: null, error: null };
    }
    if (this.tipo === "delete") {
      db.linha = null;
      return { data: null, error: null };
    }
    if (this.tipo === "update") {
      db.linha = { ...atual, ...this.dados };
      return { data: unico ? { ...db.linha } : { ...db.linha }, error: null };
    }
    return { data: { ...atual }, error: null };
  }

  single() {
    return this.resolver(true);
  }
  maybeSingle() {
    return this.resolver(false);
  }
  then<A, B>(
    onfulfilled?: ((v: { data: unknown; error: null }) => A | Promise<A>) | null,
    onrejected?: ((e: unknown) => B | Promise<B>) | null,
  ): Promise<A | B> {
    return this.resolver(false).then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}
