/**
 * Dublê do cliente de serviço (`createAdminClient()`) para as rotas do dono da
 * cobrança.
 *
 * Grava cada cadeia do PostgREST (tabela, método, argumentos) e responde pelo
 * `responder` do caso. É o que deixa o teste afirmar O QUE a rota mandou ao
 * banco: o payload do UPDATE, o filtro do compare-and-set, a ausência de
 * escrita. Não é só o status HTTP. Toda cadeia é `await`-ável em qualquer
 * ponto, como a do cliente real.
 */
export interface Passo {
  metodo: string;
  args: unknown[];
}
export interface Cadeia {
  tabela: string;
  passos: Passo[];
}
export interface Resposta {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number | null;
}

const ENCADEIAM = ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "or", "not", "gte", "order", "limit"] as const;
const ESCRITAS = new Set(["insert", "update", "delete", "upsert"]);
const FILTROS = new Set(["eq", "neq", "is", "in", "or", "not"]);

export function bancoFalso(
  responder: (cadeia: Cadeia) => Resposta = () => ({}),
  responderRpc: (nome: string, args: Record<string, unknown>) => Resposta = () => ({}),
) {
  const cadeias: Cadeia[] = [];
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const resolver = (cadeia: Cadeia) =>
    Promise.resolve({ data: null, error: null, count: null, ...responder(cadeia) });

  const cliente = {
    from(tabela: string) {
      const cadeia: Cadeia = { tabela, passos: [] };
      cadeias.push(cadeia);
      const builder: Record<string, unknown> = {};
      for (const metodo of ENCADEIAM) {
        builder[metodo] = (...args: unknown[]) => {
          cadeia.passos.push({ metodo, args });
          return builder;
        };
      }
      for (const fim of ["maybeSingle", "single"]) {
        builder[fim] = () => {
          cadeia.passos.push({ metodo: fim, args: [] });
          return resolver(cadeia);
        };
      }
      builder.then = (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
        resolver(cadeia).then(ok, erro);
      return builder;
    },
    async rpc(nome: string, args: Record<string, unknown>) {
      rpcs.push({ nome, args });
      return { data: null, error: null, ...responderRpc(nome, args) };
    },
  };
  return { cliente, cadeias, rpcs };
}
export type BancoFalso = ReturnType<typeof bancoFalso>;

/** A operação da cadeia: a escrita que ela faz, ou `select`. */
export function operacao(cadeia: Cadeia): string {
  return cadeia.passos.find((p) => ESCRITAS.has(p.metodo))?.metodo ?? "select";
}
export function argumentos(cadeia: Cadeia, metodo: string): unknown[] | undefined {
  return cadeia.passos.find((p) => p.metodo === metodo)?.args;
}
export function valorDoFiltro(cadeia: Cadeia, metodo: string, coluna: string): unknown {
  return cadeia.passos.find((p) => p.metodo === metodo && p.args[0] === coluna)?.args[1];
}
/** Os filtros da cadeia, na ordem, como `[metodo, ...args]`. */
export function filtros(cadeia: Cadeia): unknown[][] {
  return cadeia.passos.filter((p) => FILTROS.has(p.metodo)).map((p) => [p.metodo, ...p.args]);
}
