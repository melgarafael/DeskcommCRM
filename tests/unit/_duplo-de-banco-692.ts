/**
 * DUPLO DE BANCO para os testes da #4023 (satisfação).
 *
 * Um `SupabaseClient` de mentira que guarda LINHAS de verdade em memória — é o
 * que permite provar o pedido e a nota em vez de só conferir que uma função foi
 * chamada. Cobre apenas o subconjunto que a fatia usa: `select/insert/update`
 * com `eq`, `order`, `limit`, `maybeSingle` e `rpc`.
 *
 * Não é genérico de propósito: um duplo genérico acabaria reimplementando
 * PostgREST, e o que se quer medir aqui é o comportamento do NOSSO código.
 */

type Filtros = Record<string, unknown>;

export interface LinhaSatisfacao {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string | null;
  status: "aguardando" | "respondida" | "sem_nota";
  nota?: number | null;
  perguntado_em?: string;
  expira_em?: string;
  respondido_em?: string | null;
  mensagem_da_resposta_id?: string | null;
}

export interface EstadoDoBanco {
  settings: Record<string, unknown>;
  pedidos: LinhaSatisfacao[];
  atualizacoes: Array<{ tabela: string; filtros: Filtros; valores: Filtros }>;
  rpcs: Array<{ nome: string; args: Filtros }>;
  erroDeInsert: { tabela: string; code: string } | null;
}

export interface DuploDeBanco {
  client: never;
  estado: EstadoDoBanco;
}

function casa(linha: Record<string, unknown>, filtros: Filtros): boolean {
  return Object.entries(filtros).every(([chave, valor]) => linha[chave] === valor);
}

export function bancoFake(inicial: {
  settings?: Record<string, unknown>;
  pedidos?: LinhaSatisfacao[];
} = {}): DuploDeBanco {
  const estado: EstadoDoBanco = {
    settings: inicial.settings ?? {},
    pedidos: [...(inicial.pedidos ?? [])],
    atualizacoes: [],
    rpcs: [],
    erroDeInsert: null,
  };

  let sequencia = 0;
  const novoId = (prefixo: string) => `${prefixo}-${++sequencia}`;

  function resolver(tabela: string, op: "select" | "insert" | "update", valores: Filtros, filtros: Filtros): {
    data: unknown;
    error: { code?: string; message: string } | null;
  } {
    if (estado.erroDeInsert && estado.erroDeInsert.tabela === tabela && op === "insert") {
      const erro = estado.erroDeInsert;
      estado.erroDeInsert = null;
      return { data: null, error: { code: erro.code, message: "erro simulado" } };
    }

    if (tabela === "organizations") {
      if (op === "update") {
        estado.settings = valores.settings as Record<string, unknown>;
        return { data: { id: "org", settings: estado.settings }, error: null };
      }
      return { data: { settings: estado.settings }, error: null };
    }

    if (tabela === "satisfacao_do_atendimento") {
      if (op === "insert") {
        const conversa = valores.conversation_id as string;
        const aberto = estado.pedidos.some(
          (p) => p.conversation_id === conversa && p.status === "aguardando",
        );
        if (aberto) {
          // O índice parcial único da migration: um pedido ABERTO por conversa.
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        const linha: LinhaSatisfacao = {
          id: novoId("pedido"),
          organization_id: valores.organization_id as string,
          conversation_id: conversa,
          contact_id: (valores.contact_id as string | null) ?? null,
          status: "aguardando",
          perguntado_em: valores.perguntado_em as string,
          expira_em: valores.expira_em as string,
        };
        estado.pedidos.push(linha);
        return { data: { id: linha.id }, error: null };
      }
      if (op === "update") {
        const alvo = estado.pedidos.filter((p) => casa(p as unknown as Record<string, unknown>, filtros));
        const linha = alvo[0];
        if (!linha) return { data: null, error: null };
        Object.assign(linha, valores);
        estado.atualizacoes.push({ tabela, filtros, valores });
        return { data: { id: linha.id }, error: null };
      }
      const achado = estado.pedidos.find((p) => casa(p as unknown as Record<string, unknown>, filtros));
      return { data: achado ?? null, error: null };
    }

    return { data: null, error: null };
  }

  function construtor(tabela: string) {
    let op: "select" | "insert" | "update" = "select";
    let valores: Filtros = {};
    const filtros: Filtros = {};

    const terminar = () => resolver(tabela, op, valores, filtros);

    const api: Record<string, unknown> = {
      select: () => api,
      insert: (linha: Filtros) => {
        op = "insert";
        valores = linha;
        return api;
      },
      update: (linha: Filtros) => {
        op = "update";
        valores = linha;
        return api;
      },
      eq: (coluna: string, valor: unknown) => {
        filtros[coluna] = valor;
        return api;
      },
      order: () => api,
      limit: () => api,
      maybeSingle: async () => terminar(),
      single: async () => terminar(),
      then: (resolver_: (v: unknown) => unknown, rejeitar?: (e: unknown) => unknown) =>
        Promise.resolve(terminar()).then(resolver_, rejeitar),
    };
    return api;
  }

  const client = {
    from: (tabela: string) => construtor(tabela),
    rpc: async (nome: string, args: Filtros = {}) => {
      estado.rpcs.push({ nome, args });
      if (nome === "fn_satisfacao_fechar_vencidas") {
        const org = args.p_org as string | null;
        const vencidos = estado.pedidos.filter(
          (p) =>
            p.status === "aguardando" &&
            (!org || p.organization_id === org) &&
            new Date(p.expira_em ?? 0).getTime() < Date.now(),
        );
        for (const pedido of vencidos) pedido.status = "sem_nota";
        return { data: vencidos.length, error: null };
      }
      if (nome === "fn_satisfacao_resumo") {
        const org = args.p_org as string;
        const daOrg = estado.pedidos.filter((p) => p.organization_id === org);
        const respondidas = daOrg.filter((p) => p.status === "respondida");
        const soma = respondidas.reduce((total, p) => total + (p.nota ?? 0), 0);
        return {
          data: {
            respostas: respondidas.length,
            pedidos: daOrg.length,
            sem_nota: daOrg.filter((p) => p.status === "sem_nota").length,
            aguardando: daOrg.filter((p) => p.status === "aguardando").length,
            media: respondidas.length ? Math.round((soma / respondidas.length) * 100) / 100 : null,
            notas: {},
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };

  return { client: client as never, estado };
}
