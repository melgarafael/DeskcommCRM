/**
 * O POSTGREST DE DUAS EMPRESAS — um dublê que APLICA os filtros.
 *
 * Os dublês do resto da suíte costumam responder o que o teste mandar
 * (`maybeSingle: async () => ({ data: linha })`). Para a #4845 isso não serve:
 * o defeito é justamente o `.eq("organization_id", …)` que FALTA, e um dublê que
 * devolve a linha escrita à mão passaria verde com e sem o filtro.
 *
 * Aqui as linhas ficam guardadas por tabela e o construtor do PostgREST é
 * aplicado de verdade: `eq`/`neq`/`in`/`gte`/`lt` filtram, `update` e `delete`
 * mudam só o que casou, `insert` acumula. É essa aplicação que faz o teste de
 * duas empresas medir o comportamento — a empresa A não recebe a linha da B
 * porque o filtro existe, e a contagem depois da recusa prova que nada foi
 * escrito.
 *
 * O que ele NÃO prova: que a RLS e o Postgres reagem assim. Isso é a suíte de
 * banco (`pnpm test:db`), e o defeito desta issue é anterior a ela — a rota não
 * pedia o recorte.
 */
export type Linha = Record<string, unknown>;

export type Chamada = {
  tabela: string;
  operacao: "select" | "insert" | "update" | "delete";
  filtros: Array<[string, unknown]>;
};

/** Relações que as rotas do financeiro embutem no `select`. */
const EMBUTIDAS = ["sale_items(", "calendar_event_types(", "calendar_appointments("];

/** O construtor do supabase-js, reduzido ao que as rotas citadas usam. */
export interface ConstrutorDoPostgrest {
  select(cols?: string): ConstrutorDoPostgrest;
  eq(coluna: string, valor: unknown): ConstrutorDoPostgrest;
  neq(coluna: string, valor: unknown): ConstrutorDoPostgrest;
  in(coluna: string, valores: readonly unknown[]): ConstrutorDoPostgrest;
  gte(coluna: string, valor: unknown): ConstrutorDoPostgrest;
  lt(coluna: string, valor: unknown): ConstrutorDoPostgrest;
  lte(coluna: string, valor: unknown): ConstrutorDoPostgrest;
  order(coluna: string, opcoes?: { ascending?: boolean }): ConstrutorDoPostgrest;
  limit(n: number): ConstrutorDoPostgrest;
  insert(linhas: Linha | Linha[]): ConstrutorDoPostgrest;
  update(alteracao: Linha): ConstrutorDoPostgrest;
  delete(): ConstrutorDoPostgrest;
  maybeSingle(): Promise<{ data: Linha | null; error: unknown }>;
  single(): Promise<{ data: Linha | null; error: unknown }>;
  then(
    aoResolver?: (v: unknown) => unknown,
    aoRejeitar?: (e: unknown) => unknown,
  ): Promise<unknown>;
}

export function bancoDeDuasEmpresas(inicial: Record<string, Linha[]> = {}) {
  const tabelas = new Map<string, Linha[]>();
  for (const [nome, linhas] of Object.entries(inicial)) {
    tabelas.set(
      nome,
      linhas.map((l) => ({ ...l })),
    );
  }

  const chamadas: Chamada[] = [];
  let sequencia = 0;

  const linhasDe = (tabela: string): Linha[] => {
    if (!tabelas.has(tabela)) tabelas.set(tabela, []);
    return tabelas.get(tabela)!;
  };

  const embutir = (linha: Linha, colunas: string): Linha => {
    const saida: Linha = { ...linha };
    if (!EMBUTIDAS.some((e) => colunas.includes(e))) return saida;

    if (colunas.includes("sale_items(")) {
      saida.sale_items = linhasDe("sale_items")
        .filter((i) => i.sale_id === linha.id)
        .map((i) => ({ ...i }));
    }
    if (colunas.includes("calendar_event_types(")) {
      const tipo = linhasDe("calendar_event_types").find((t) => t.id === linha.event_type_id);
      saida.calendar_event_types = tipo ? { ...tipo } : null;
    }
    if (colunas.includes("calendar_appointments(")) {
      const compromisso = linhasDe("calendar_appointments").find((a) => a.id === linha.appointment_id);
      saida.calendar_appointments = compromisso ? { ...compromisso } : null;
    }
    return saida;
  };

  /**
   * O construtor de UMA consulta. Os métodos devolvem o próprio construtor, como
   * no supabase-js; a execução acontece no `await`/`maybeSingle`.
   */
  function consulta(tabela: string, operacao: Chamada["operacao"]) {
    const filtros: Array<[string, unknown]> = [];
    const predicados: Array<(l: Linha) => boolean> = [];
    let colunas = "";
    let ordem: { coluna: string; ascendente: boolean } | null = null;
    let limite: number | null = null;
    let alteracao: Linha | null = null;
    let novasLinhas: Linha[] = [];

    const casam = (linha: Linha) =>
      filtros.every(([coluna, valor]) => linha[coluna] === valor) &&
      predicados.every((p) => p(linha));

    const executar = () => {
      chamadas.push({ tabela, operacao, filtros: filtros.map((f) => [...f] as [string, unknown]) });
      const todas = linhasDe(tabela);

      if (operacao === "insert") {
        const gravadas = novasLinhas.map((l) => ({
          ...l,
          id: l.id ?? `${tabela}-${++sequencia}`,
        }));
        todas.push(...gravadas);
        return { data: gravadas.map((l) => embutir(l, colunas)), error: null };
      }

      const alvo = [...todas].filter(casam);

      if (operacao === "update") {
        for (const linha of alvo) Object.assign(linha, alteracao);
        return { data: alvo.map((l) => embutir({ ...l }, colunas)), error: null };
      }

      if (operacao === "delete") {
        // A remoção é por posição na lista viva: linha apagada é a que casou.
        const restantes = todas.filter((l) => !alvo.some((a) => a === l));
        tabelas.set(tabela, restantes);
        return { data: alvo.map((l) => ({ ...l })), error: null };
      }

      let resultado = alvo.map((l) => embutir(l, colunas));
      if (ordem) {
        const { coluna, ascendente } = ordem;
        resultado = [...resultado].sort((a, b) => {
          const va = a[coluna];
          const vb = b[coluna];
          if (typeof va === "number" && typeof vb === "number") {
            return ascendente ? va - vb : vb - va;
          }
          return ascendente
            ? String(va ?? "").localeCompare(String(vb ?? ""))
            : String(vb ?? "").localeCompare(String(va ?? ""));
        });
      }
      if (limite !== null) resultado = resultado.slice(0, limite);
      return { data: resultado, error: null };
    };

    const construtor: ConstrutorDoPostgrest = {
      select(cols?: string) {
        if (cols) colunas = cols;
        return construtor;
      },
      eq(coluna: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return construtor;
      },
      neq(coluna: string, valor: unknown) {
        predicados.push((l) => l[coluna] !== valor);
        return construtor;
      },
      in(coluna: string, valores: readonly unknown[]) {
        predicados.push((l) => valores.includes(l[coluna]));
        return construtor;
      },
      gte(coluna: string, valor: unknown) {
        predicados.push((l) => String(l[coluna] ?? "") >= String(valor));
        return construtor;
      },
      lt(coluna: string, valor: unknown) {
        predicados.push((l) => String(l[coluna] ?? "") < String(valor));
        return construtor;
      },
      lte(coluna: string, valor: unknown) {
        predicados.push((l) => String(l[coluna] ?? "") <= String(valor));
        return construtor;
      },
      order(coluna: string, opcoes?: { ascending?: boolean }) {
        ordem = { coluna, ascendente: opcoes?.ascending !== false };
        return construtor;
      },
      limit(n: number) {
        limite = n;
        return construtor;
      },
      insert(linhas: Linha | Linha[]) {
        novasLinhas = Array.isArray(linhas) ? linhas : [linhas];
        return construtor;
      },
      update(alteracaoDaLinha: Linha) {
        alteracao = alteracaoDaLinha;
        return construtor;
      },
      delete() {
        return construtor;
      },
      async maybeSingle() {
        const { data, error } = executar();
        if (error) return { data: null, error };
        const primeira = (data as Linha[])[0] ?? null;
        return { data: primeira, error: null };
      },
      async single() {
        const { data, error } = executar();
        if (error) return { data: null, error };
        return { data: (data as Linha[])[0] ?? null, error: null };
      },
      then(
        aoResolver?: (v: unknown) => unknown,
        aoRejeitar?: (e: unknown) => unknown,
      ) {
        return Promise.resolve(executar()).then(aoResolver, aoRejeitar);
      },
    };

    return construtor;
  }

  const cliente = {
    from(tabela: string) {
      return {
        select: (cols?: string) => consulta(tabela, "select").select(cols),
        insert: (linhas: Linha | Linha[]) => consulta(tabela, "insert").insert(linhas),
        update: (alteracao: Linha) => consulta(tabela, "update").update(alteracao),
        delete: () => consulta(tabela, "delete"),
      };
    },
    /**
     * As duas funções que as rotas citadas chamam. O saldo é somado das linhas de
     * `loyalty_ledger` da `p_org` — é o que `fn_saldo_de_fidelidade` faz no banco,
     * e é o que permite comparar o extrato com ele.
     */
    async rpc(nome: string, args: Record<string, unknown> = {}) {
      if (nome === "fn_saldo_de_fidelidade") {
        const total = linhasDe("loyalty_ledger")
          .filter((l) => l.organization_id === args.p_org && l.contact_id === args.p_contact)
          .reduce((acc, l) => acc + Number(l.points ?? 0), 0);
        return { data: total, error: null };
      }
      return { data: null, error: { message: `rpc não dublada: ${nome}` } };
    },
  };

  return {
    cliente,
    chamadas,
    semear(tabela: string, linhas: Linha[]) {
      linhasDe(tabela).push(...linhas.map((l) => ({ ...l })));
    },
    linhas: (tabela: string) => linhasDe(tabela).map((l) => ({ ...l })),
    contar: (tabela: string) => linhasDe(tabela).length,
    porId(tabela: string, id: unknown) {
      return linhasDe(tabela).find((l) => l.id === id) ?? null;
    },
    /** Chamadas de ESCRITA emitidas — a prova de que a recusa não escreveu. */
    escritas: () => chamadas.filter((c) => c.operacao !== "select"),
  };
}
