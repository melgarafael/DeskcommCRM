import type { SupabaseClient } from "@supabase/supabase-js";

export type LinhaDoDuble = Record<string, unknown>;
export type FiltroDoDuble = { coluna: string; valor: unknown };

export interface CapturasDoDubleDoHandler {
  patches: Record<string, LinhaDoDuble[]>;
  filtros: Record<string, FiltroDoDuble[]>;
  inserts: Record<string, LinhaDoDuble[]>;
  selects: Record<string, string[]>;
}

export interface OpcoesDoDubleDoHandler {
  conversation: LinhaDoDuble;
  channelMetadata?: LinhaDoDuble;
  templateRow?: LinhaDoDuble | null;
  rpcData?: unknown | (() => unknown);
}

interface CadeiaAguardavel extends PromiseLike<{ error: null }> {
  eq: (coluna: string, valor: unknown) => CadeiaAguardavel;
}

function cadeiaAguardavel(
  tabela: string,
  capturas: CapturasDoDubleDoHandler,
): CadeiaAguardavel {
  const cadeia: CadeiaAguardavel = {
    eq: (coluna, valor) => {
      capturas.filtros[tabela]!.push({ coluna, valor });
      return cadeia;
    },
    then: (resolve, reject) => Promise.resolve({ error: null }).then(resolve, reject),
  };
  return cadeia;
}

/**
 * Dublê compartilhado do `sendMessageHandler`.
 *
 * As cadeias de filtro são ilimitadas e aguardáveis, para que acrescentar um
 * `.eq()` de segurança no código de produção não quebre testes alheios. Ao
 * mesmo tempo, filtros, patches e inserts ficam registrados: o teste pode
 * cobrar o comportamento que realmente importa em vez de ignorar a query.
 *
 * Só cobre as tabelas que o handler toca diretamente hoje. Uma tabela nova no
 * handler deve ser adicionada aqui uma vez, não em cinco fakes diferentes.
 */
export function criarDubleDoHandler(opcoes: OpcoesDoDubleDoHandler): {
  supabase: SupabaseClient;
  capturas: CapturasDoDubleDoHandler;
} {
  const capturas: CapturasDoDubleDoHandler = {
    patches: { conversations: [], messages: [], contacts: [] },
    filtros: {
      conversations: [],
      messages: [],
      contacts: [],
      meta_templates: [],
      channel_sessions: [],
    },
    inserts: { messages: [] },
    selects: { conversations: [], messages: [], meta_templates: [], channel_sessions: [] },
  };

  let mensagem: LinhaDoDuble | null = null;

  const client = {
    from(tabela: string) {
      if (tabela === "conversations") {
        return {
          select: (colunas = "") => {
            capturas.selects.conversations!.push(colunas);
            const cadeia = {
              eq: (coluna: string, valor: unknown) => {
                capturas.filtros.conversations!.push({ coluna, valor });
                return cadeia;
              },
              maybeSingle: async () => ({ data: opcoes.conversation, error: null }),
            };
            return cadeia;
          },
          update: (patch: LinhaDoDuble) => {
            capturas.patches.conversations!.push(patch);
            return cadeiaAguardavel("conversations", capturas);
          },
        };
      }

      if (tabela === "channel_sessions") {
        const cadeia = {
          select: (colunas = "") => {
            capturas.selects.channel_sessions!.push(colunas);
            return cadeia;
          },
          eq: (coluna: string, valor: unknown) => {
            capturas.filtros.channel_sessions!.push({ coluna, valor });
            return cadeia;
          },
          maybeSingle: async () => ({ data: { metadata: opcoes.channelMetadata ?? {} }, error: null }),
        };
        return cadeia;
      }

      if (tabela === "meta_templates") {
        const cadeia = {
          eq: (coluna: string, valor: unknown) => {
            capturas.filtros.meta_templates!.push({ coluna, valor });
            return cadeia;
          },
          maybeSingle: async () => ({ data: opcoes.templateRow ?? null, error: null }),
        };
        return {
          select: (colunas = "") => {
            capturas.selects.meta_templates!.push(colunas);
            return cadeia;
          },
        };
      }

      if (tabela === "contacts") {
        return {
          update: (patch: LinhaDoDuble) => {
            capturas.patches.contacts!.push(patch);
            return cadeiaAguardavel("contacts", capturas);
          },
        };
      }

      if (tabela === "messages") {
        return {
          insert: (row: LinhaDoDuble) => {
            capturas.inserts.messages!.push(row);
            mensagem = {
              id: "msg-1",
              external_id: null,
              ack: null,
              error_code: null,
              error_message: null,
              ...row,
            };
            return {
              select: (colunas = "") => {
                capturas.selects.messages!.push(colunas);
                return { single: async () => ({ data: { ...mensagem }, error: null }) };
              },
            };
          },
          update: (patch: LinhaDoDuble) => {
            capturas.patches.messages!.push(patch);
            mensagem = { ...(mensagem ?? { id: "msg-1" }), ...patch };
            const cadeia = {
              eq: (coluna: string, valor: unknown) => {
                capturas.filtros.messages!.push({ coluna, valor });
                return cadeia;
              },
              select: (colunas = "") => {
                capturas.selects.messages!.push(colunas);
                return cadeia;
              },
              maybeSingle: async () => ({ data: { ...mensagem }, error: null }),
              single: async () => ({ data: { ...mensagem }, error: null }),
            };
            return cadeia;
          },
        };
      }

      throw new Error(`duble-do-handler: tabela inesperada '${tabela}'`);
    },
    rpc: async () => ({
      data: typeof opcoes.rpcData === "function" ? opcoes.rpcData() : opcoes.rpcData,
      error: null,
    }),
  };

  return { supabase: client as unknown as SupabaseClient, capturas };
}
