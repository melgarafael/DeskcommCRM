/**
 * Cliente Supabase de MENTIRA, em memória, que de fato APLICA os filtros `.eq()`.
 *
 * Existe porque um mock que devolve sempre a mesma linha não prova isolamento por
 * organização: o teste passaria mesmo se a consulta esquecesse o `organization_id`.
 * Aqui a linha de outra organização só aparece se o código a pedir.
 */
type Linha = Record<string, unknown>;

export interface TabelasEmMemoria {
  [tabela: string]: Linha[];
}

export interface BancoEmMemoria {
  from: (tabela: string) => unknown;
  /** O que foi inserido, por tabela. */
  inseridos: Record<string, Linha[]>;
  /** As tabelas consultadas, na ordem. */
  consultas: string[];
}

export function bancoEmMemoria(tabelas: TabelasEmMemoria): BancoEmMemoria {
  const inseridos: Record<string, Linha[]> = {};
  const consultas: string[] = [];
  return {
    inseridos,
    consultas,
    from(tabela: string) {
      consultas.push(tabela);
      const filtros: Array<[string, unknown]> = [];
      let limite = Infinity;
      const aplicar = (): Linha[] =>
        (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v)).slice(0, limite);
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: (c: string, v: unknown) => (filtros.push([c, v]), cadeia),
        limit: (n: number) => ((limite = n), cadeia),
        order: () => cadeia,
        maybeSingle: async () => ({ data: aplicar()[0] ?? null, error: null }),
        insert: async (linha: Linha) => {
          (inseridos[tabela] ??= []).push(linha);
          return { error: null };
        },
        then: (ok: (v: unknown) => unknown) => ok({ data: aplicar(), error: null }),
      };
      return cadeia;
    },
  };
}
