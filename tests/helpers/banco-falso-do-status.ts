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
export function bancoFalso(
  opcoes: {
    sessao?: Linha | null;
    idem?: Map<string, Linha>;
    /** Linhas de `contacts`: `{ phone_number, is_blocked, is_anonymized, is_personal }`. */
    contatos?: Linha[];
    /** Linhas de `contact_phones`, com a ficha embutida em `contacts`, como o PostgREST devolve. */
    telefonesExtras?: Linha[];
    /** Erro de leitura em `contacts`, para medir a falha fechada. */
    erroEmContatos?: { message: string };
    /** Dígitos que a marca de apagamento reconhece: o que sobra de quem passou pela cascata. */
    apagados?: string[];
    /** O que `fn_titular_apagado_a_pedido` responde, quando não é sim nem não. */
    respostaDaMarca?: { data: unknown; error: { message: string } | null };
  } = {},
) {
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

  /** Só o que o SELECT pediu: coluna esquecida chega `undefined`, como no PostgREST. */
  const projetar = (linha: Linha, colunas: string): Linha => {
    const embed = /(\w+):\w+\(([^)]*)\)/.exec(colunas);
    const nomes = (lista: string) => lista.split(",").map((c) => c.trim()).filter(Boolean);
    const saida: Linha = {};
    for (const coluna of nomes(colunas.replace(embed?.[0] ?? "", ""))) saida[coluna] = linha[coluna];
    if (embed) {
      const ficha = linha[embed[1] as string] as Linha | null | undefined;
      saida[embed[1] as string] = ficha
        ? Object.fromEntries(nomes(embed[2] as string).map((c) => [c, ficha[c]]))
        : null;
    }
    return saida;
  };

  const leituraDeContatos = (linhas: Linha[], erro: { message: string } | null) => (colunas: string) => {
    let grafias: unknown[] = [];
    const b: Record<string, unknown> = {
      eq: () => b,
      in: (_coluna: string, valores: unknown[]) => {
        grafias = valores;
        return b;
      },
      then: (r?: (v: unknown) => unknown) => {
        const data = linhas.filter((l) => grafias.includes(l.phone_number)).map((l) => projetar(l, colunas));
        return Promise.resolve(erro ? { data: null, error: erro } : { data, error: null }).then(
          r ?? ((v: unknown) => v),
        );
      },
    };
    return b;
  };

  const db = {
    rpc: async (funcao: string, args: { p_org: string; p_telefone: string; p_lid: null }) => {
      if (funcao !== "fn_titular_apagado_a_pedido") throw new Error(`rpc inesperada: ${funcao}`);
      return (
        opcoes.respostaDaMarca ?? {
          data: (opcoes.apagados ?? []).includes(args.p_telefone),
          error: null,
        }
      );
    },
    from: (tabela: string) =>
      tabela === "contacts"
        ? { select: leituraDeContatos(opcoes.contatos ?? [], opcoes.erroEmContatos ?? null) }
        : tabela === "contact_phones"
          ? { select: leituraDeContatos(opcoes.telefonesExtras ?? [], null) }
          : tabela === "idempotency_keys"
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
