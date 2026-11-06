/**
 * Banco falso da publicação de Status (#3397), dividido entre o teste do caminho
 * do canal e o da ferramenta MCP: os dois passam pela idempotência de verdade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type Linha = Record<string, unknown>;
type Filtro = [string, unknown];

/**
 * Banco falso: `channel_sessions` só é LIDO (e as escritas são CONTADAS, para
 * provar que a publicação não liga o acervo sozinha), e `idempotency_keys`
 * implementa o mínimo que `comIdempotencia` usa — unicidade por
 * (endpoint, chave), filtro de janela e recibo terminal na mesma linha.
 */
export function bancoFalso(opcoes: { sessao?: Linha | null; idem?: Map<string, Linha> } = {}) {
  const idem = opcoes.idem ?? new Map<string, Linha>();
  const contagem = { escritasEmCanais: 0 };

  const casa = (l: Linha, filtros: Filtro[]) => filtros.every(([c, v]) => l[c] === v);
  const chaveDe = (l: Linha) => `${String(l.endpoint)}|${String(l.key)}`;

  const selecaoIdem = () => {
    const filtros: Filtro[] = [];
    let dentroDaJanela: Filtro | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return b;
      },
      gt: (c: string, v: unknown) => {
        dentroDaJanela = [c, v];
        return b;
      },
      maybeSingle: async () => {
        const achada = [...idem.values()].find(
          (l) =>
            casa(l, filtros) &&
            (dentroDaJanela === null ||
              String(l[dentroDaJanela[0]]) > String(dentroDaJanela[1])),
        );
        return { data: achada ?? null, error: null };
      },
    };
    return b;
  };

  const insercaoIdem = (linha: Linha) => {
    const gravar = async () => {
      if (idem.has(chaveDe(linha))) {
        return { data: null, error: { code: "23505", message: "duplicate key value" } };
      }
      idem.set(chaveDe(linha), { ...linha, id: `idem-${idem.size + 1}` });
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      maybeSingle: gravar,
      then: (r?: (v: unknown) => unknown) => gravar().then(r ?? ((v: unknown) => v)),
    };
    return b;
  };

  const atualizacaoIdem = (patch: Linha) => {
    const filtros: Filtro[] = [];
    const aplicar = () => {
      const alvos = [...idem.values()].filter((l) => casa(l, filtros));
      for (const alvo of alvos) Object.assign(alvo, patch);
      return alvos;
    };
    const b: Record<string, unknown> = {
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return b;
      },
      select: () => b,
      maybeSingle: async () => {
        const alvos = aplicar();
        return { data: alvos[0] ? { id: alvos[0].id } : null, error: null };
      },
      then: (r?: (v: unknown) => unknown) => {
        aplicar();
        return Promise.resolve({ data: null, error: null }).then(r ?? ((v: unknown) => v));
      },
    };
    return b;
  };

  const selecaoSessao = () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: opcoes.sessao ?? null, error: null }),
    };
    return b;
  };

  const escritaProibida = () => {
    contagem.escritasEmCanais += 1;
    const resultado = { data: null, error: null };
    return {
      select: () => ({ maybeSingle: async () => resultado }),
      maybeSingle: async () => resultado,
      then: (r?: (v: unknown) => unknown) => Promise.resolve(resultado).then(r ?? ((v: unknown) => v)),
    };
  };

  const db = {
    from: (tabela: string) =>
      tabela === "idempotency_keys"
        ? {
            select: () => selecaoIdem(),
            insert: (linha: Linha) => insercaoIdem(linha),
            update: (patch: Linha) => atualizacaoIdem(patch),
          }
        : {
            select: () => selecaoSessao(),
            insert: escritaProibida,
            update: escritaProibida,
          },
  };

  return { db: db as unknown as SupabaseClient, contagem, idem };
}
