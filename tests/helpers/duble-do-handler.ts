import type { SupabaseClient } from "@supabase/supabase-js";

export type LinhaDoDuble = Record<string, unknown>;
export type FiltroDoDuble = { coluna: string; valor: unknown };

export interface CapturasDoDubleDoHandler {
  patches: Record<string, LinhaDoDuble[]>;
  filtros: Record<string, FiltroDoDuble[]>;
  inserts: Record<string, LinhaDoDuble[]>;
  selects: Record<string, string[]>;
  /**
   * Cada `rpc(nome, args)` chamada pelo handler, na ordem.
   *
   * Sem isto o teste do evento `message.failed` (#1614) só conseguiria provar
   * que a chamada NÃO explodiu — e o que importa é QUAL evento saiu e com
   * QUAL payload. Um capture por helper, não um fake novo por teste.
   */
  rpcs: { nome: string; args: Record<string, unknown> }[];
}

export interface OpcoesDoDubleDoHandler {
  conversation: LinhaDoDuble;
  channelMetadata?: LinhaDoDuble;
  templateRow?: LinhaDoDuble | null;
  rpcData?: unknown | (() => unknown);
  /**
   * Banco em que a migration 0106 ainda não rodou: pedir `archived_at` devolve
   * `42703` e o handler cai na consulta tolerante (desfecho nº 9).
   */
  semColunaArquivada?: boolean;
  /**
   * Honra o `select` da conversa, como o PostgREST: coluna que não foi pedida
   * não chega. Só quem prova o elo coluna → select liga isto (o arquivo do
   * canal intermediado); nos demais casos a linha volta inteira, como antes.
   */
  projetarConversa?: boolean;
  /** Linhas que já estavam em `messages` antes deste envio (eco do webhook). */
  mensagensIniciais?: LinhaDoDuble[];
  /**
   * Reproduz o índice único `(organization_id, external_id)` de `messages`:
   * gravar um `external_id` que outra linha já tem devolve `23505` em vez de
   * gravar em cima.
   *
   * LIGADO SÓ por quem prova o desfecho de eco. Nos demais casos o stub do
   * canal devolve o MESMO id em todo envio, e o índice puniria o segundo envio
   * — um vermelho que denunciaria o stub, não o código.
   */
  indiceUnicoMensagem?: boolean;
  /** Linha de `organizations` lida pelo aviso ao lead, pela guarda de agenda e pelo assert de org operante. Padrão: `{ settings: {}, status: "active" }`. */
  organizacao?: LinhaDoDuble;
  /** Linhas de `calendar_appointments` lidas pela guarda de agenda. Padrão: `[]`. */
  agenda?: LinhaDoDuble[];
  /**
   * A linha de `ai_agents` que a conferência da operação do agente lê pela REST
   * (`assertAgentOperationSupabase`). Função = estado vivo: o teste pausa o
   * agente entre uma bolha e outra.
   */
  agente?: LinhaDoDuble | null | (() => LinhaDoDuble | null);
}

export interface RetornoDoDubleDoHandler {
  supabase: SupabaseClient;
  capturas: CapturasDoDubleDoHandler;
  /** A tabela `messages` VIVA: o teste lê o que sobrou depois do envio. */
  mensagens: LinhaDoDuble[];
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
 * Colunas de PRIMEIRO NÍVEL de um `select` do PostgREST.
 *
 * `id, a, b:c(x, y), d` → `["id", "a", "b", "d"]`. Embeds entram pelo apelido
 * (o que vem antes de `:`), que é a chave que o PostgREST devolve.
 */
export function colunasDoSelect(select: string): string[] {
  let profundidade = 0;
  let atual = "";
  const partes: string[] = [];
  for (const ch of select) {
    if (ch === "(") profundidade++;
    else if (ch === ")") profundidade--;
    if (ch === "," && profundidade === 0) {
      partes.push(atual);
      atual = "";
      continue;
    }
    atual += ch;
  }
  partes.push(atual);
  return partes
    .map((p) => p.trim().split("(")[0]!.split(":")[0]!.trim())
    .filter((p) => p.length > 0);
}

/**
 * Colunas de DENTRO de um embed (`contacts:contact_id(phone_number, wa_lid)`).
 * `colunasDoSelect` devolve só o primeiro nível e descarta o miolo do embed —
 * e é ali que a perda de uma coluna passa despercebida.
 */
export function colunasDoEmbed(select: string, apelido: string): string[] {
  const m = new RegExp(`${apelido}\\s*:[^(]*\\(([^)]*)\\)`).exec(select);
  if (m === null) return [];
  return m[1]!.split(",").map((c) => c.trim()).filter(Boolean);
}

/** A linha como o PostgREST a devolveria: só o que o `select` pediu. */
export function projetar(linha: LinhaDoDuble, select: string): LinhaDoDuble {
  const querem = new Set(colunasDoSelect(select));
  return Object.fromEntries(Object.entries(linha).filter(([k]) => querem.has(k)));
}

/**
 * Dublê compartilhado do `sendMessageHandler`.
 *
 * As cadeias de filtro são ilimitadas e aguardáveis, para que acrescentar um
 * `.eq()` de segurança no código de produção não quebre testes alheios. Ao
 * mesmo tempo, filtros, patches e inserts ficam registrados: o teste pode
 * cobrar o comportamento que realmente importa em vez de ignorar a query.
 *
 * Só cobre as tabelas que o handler — e os caminhos que ele chama (gate de IA,
 * espelho do canal, aviso ao lead, guarda de agenda) — toca hoje. Uma tabela
 * nova deve ser adicionada aqui uma vez, não em cinco fakes diferentes.
 */
export function criarDubleDoHandler(
  opcoes: OpcoesDoDubleDoHandler,
): RetornoDoDubleDoHandler {
  const capturas: CapturasDoDubleDoHandler = {
    patches: { conversations: [], messages: [], contacts: [] },
    filtros: {
      conversations: [],
      messages: [],
      contacts: [],
      meta_templates: [],
      channel_sessions: [],
      organizations: [],
      calendar_appointments: [],
    },
    inserts: { messages: [] },
    selects: {
      conversations: [],
      messages: [],
      meta_templates: [],
      channel_sessions: [],
      organizations: [],
      ai_agents: [],
    },
    rpcs: [],
  };

  const mensagens: LinhaDoDuble[] = (opcoes.mensagensIniciais ?? []).map((r) => ({ ...r }));
  let contadorDeMensagens = 0;
  const filtrarMensagens = (
    filtros: Array<(r: LinhaDoDuble) => boolean>,
  ): LinhaDoDuble[] => mensagens.filter((r) => filtros.every((f) => f(r)));

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
              maybeSingle: async () => {
                if (opcoes.semColunaArquivada === true && colunas.includes("archived_at")) {
                  return {
                    data: null,
                    error: {
                      code: "42703",
                      message: "column channel_sessions_1.archived_at does not exist",
                    },
                  };
                }
                return {
                  data:
                    opcoes.projetarConversa === true
                      ? projetar(opcoes.conversation, colunas)
                      : { ...opcoes.conversation },
                  error: null,
                };
              },
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
        // A MESMA tabela responde a duas consultas: `metadata` para o gate
        // pré-go-live da IA e `provider`/`meta_waba_id` para o espelho do canal.
        // Devolve as duas — quem lê uma ignora a outra, como o PostgREST
        // devolveria a linha com as colunas pedidas.
        const sessao = (opcoes.conversation.channel_sessions ?? {}) as LinhaDoDuble;
        const cadeia = {
          select: (colunas = "") => {
            capturas.selects.channel_sessions!.push(colunas);
            return cadeia;
          },
          eq: (coluna: string, valor: unknown) => {
            capturas.filtros.channel_sessions!.push({ coluna, valor });
            return cadeia;
          },
          maybeSingle: async () => ({
            data: {
              metadata: opcoes.channelMetadata ?? {},
              provider: sessao.provider ?? null,
              meta_waba_id: sessao.meta_waba_id ?? null,
              meta_phone_number_id: sessao.meta_phone_number_id ?? null,
              zernio_account_id: sessao.zernio_account_id ?? null,
              status: sessao.status ?? null,
              archived_at: sessao.archived_at ?? null,
            },
            error: null,
          }),
        };
        return cadeia;
      }

      if (tabela === "meta_templates") {
        // O espelho local do template. `templateRow` é injetado por caso; null
        // simula template que não existe (ou WABA errada).
        //
        // A cadeia é ENCADEÁVEL SEM LIMITE de propósito: um dublê que fixa a
        // quantidade de filtros faz o teste quebrar quando a consulta ganha um
        // `eq` (ou um `is`) novo — com um erro que não fala do comportamento
        // sob teste e manda quem lê procurar defeito onde não há.
        const cadeia = {
          eq: (coluna: string, valor: unknown) => {
            capturas.filtros.meta_templates!.push({ coluna, valor });
            return cadeia;
          },
          is: (coluna: string, valor: unknown) => {
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

      if (tabela === "organizations") {
        // Lido pelo aviso ao lead (idioma da organização), pela guarda de agenda
        // e pelo `assertOrgOperante` do topo do handler. Padrão operante: sem o
        // `status`, todo caso legado viraria 403 `org_suspended`.
        const padrao = { settings: {}, status: "active" };
        const cadeia = {
          select: (colunas = "") => {
            capturas.selects.organizations!.push(colunas);
            return cadeia;
          },
          eq: (coluna: string, valor: unknown) => {
            capturas.filtros.organizations!.push({ coluna, valor });
            return cadeia;
          },
          maybeSingle: async () => ({ data: opcoes.organizacao ?? padrao, error: null }),
          single: async () => ({ data: opcoes.organizacao ?? padrao, error: null }),
        };
        return cadeia;
      }

      if (tabela === "calendar_appointments") {
        const cadeia: {
          select: (colunas?: string) => typeof cadeia;
          eq: (coluna: string, valor: unknown) => typeof cadeia;
          in: (coluna: string, valores: unknown[]) => typeof cadeia;
          order: (...args: unknown[]) => typeof cadeia;
          limit: (...args: unknown[]) => typeof cadeia;
          then: (
            resolve: (v: { data: LinhaDoDuble[]; error: null }) => unknown,
            reject?: (e: unknown) => unknown,
          ) => PromiseLike<unknown>;
        } = {
          select: () => cadeia,
          eq: () => cadeia,
          in: () => cadeia,
          order: () => cadeia,
          limit: () => cadeia,
          then: (resolve, reject) =>
            Promise.resolve({ data: [...(opcoes.agenda ?? [])], error: null }).then(
              resolve,
              reject,
            ),
        };
        return cadeia;
      }

      if (tabela === "ai_agents") {
        const cadeia = {
          select: (colunas = "") => {
            capturas.selects.ai_agents!.push(colunas);
            return cadeia;
          },
          eq: () => {
            return cadeia;
          },
          maybeSingle: async () => ({
            data: typeof opcoes.agente === "function" ? opcoes.agente() : (opcoes.agente ?? null),
            error: null,
          }),
        };
        return cadeia;
      }

      if (tabela === "contacts") {
        // O envio carimba `contacts.last_activity_at` (migration 0162), com
        // filtro por id E por organização (este handler também roda com o client
        // de service role, que bypassa RLS). Encadeável SEM LIMITE de propósito:
        // um dublê que fixa a quantidade de `eq` quebra quando a consulta ganha
        // um filtro novo — com um erro que não fala do comportamento sob teste.
        return {
          update: (patch: LinhaDoDuble) => {
            capturas.patches.contacts!.push(patch);
            return cadeiaAguardavel("contacts", capturas);
          },
        };
      }

      if (tabela === "messages") {
        // Tabela de VERDADE, não uma linha só: o desfecho de vários casos é
        // "quantas linhas sobraram", e o eco do webhook já está aqui antes do
        // envio começar. `update` casa pelas MESMAS colunas que o PostgREST casa
        // — filtrar errado não encontra a linha —, e a violação do índice único
        // (organization_id, external_id) volta como `23505`, que é a regra de
        // banco da qual o desfecho de eco depende.
        const resolverUpdate = (
          patch: LinhaDoDuble,
          filtros: Array<(r: LinhaDoDuble) => boolean>,
        ): { data: LinhaDoDuble | null; error: { code: string; message: string } | null } => {
          const alvos = filtrarMensagens(filtros);
          const externo = typeof patch.external_id === "string" ? patch.external_id : null;
          if (externo !== null && opcoes.indiceUnicoMensagem === true) {
            const org = alvos[0]?.organization_id;
            const colide = mensagens.some(
              (r) =>
                !alvos.includes(r) &&
                r.external_id === externo &&
                (org === undefined || r.organization_id === org),
            );
            if (colide) {
              return {
                data: null,
                error: {
                  code: "23505",
                  message:
                    'duplicate key value violates "messages_org_external_id_unique"',
                },
              };
            }
          }
          alvos.forEach((r) => Object.assign(r, patch));
          return { data: alvos[0] ? { ...alvos[0] } : null, error: null };
        };

        return {
          insert: (row: LinhaDoDuble) => {
            contadorDeMensagens += 1;
            const nova: LinhaDoDuble = {
              id: `msg-${contadorDeMensagens}`,
              external_id: null,
              ack: null,
              error_code: null,
              error_message: null,
              created_at: new Date().toISOString(),
              ...row,
            };
            mensagens.push(nova);
            capturas.inserts.messages!.push(row);
            return {
              select: (colunas = "") => {
                capturas.selects.messages!.push(colunas);
                return { single: async () => ({ data: { ...nova }, error: null }) };
              },
            };
          },
          update: (patch: LinhaDoDuble) => {
            capturas.patches.messages!.push(patch);
            const filtros: Array<(r: LinhaDoDuble) => boolean> = [];
            const cadeia = {
              eq: (coluna: string, valor: unknown) => {
                filtros.push((r) => r[coluna] === valor);
                capturas.filtros.messages!.push({ coluna, valor });
                return cadeia;
              },
              select: (colunas = "") => {
                capturas.selects.messages!.push(colunas);
                return cadeia;
              },
              maybeSingle: async () => resolverUpdate(patch, filtros),
              single: async () => resolverUpdate(patch, filtros),
            };
            return cadeia;
          },
          delete: () => {
            const filtros: Array<(r: LinhaDoDuble) => boolean> = [];
            const cadeia = {
              eq: (coluna: string, valor: unknown) => {
                filtros.push((r) => r[coluna] === valor);
                capturas.filtros.messages!.push({ coluna, valor });
                return cadeia;
              },
              neq: (coluna: string, valor: unknown) => {
                filtros.push((r) => r[coluna] !== valor);
                capturas.filtros.messages!.push({ coluna, valor: `neq:${String(valor)}` });
                return cadeia;
              },
              in: (coluna: string, valores: unknown[]) => {
                filtros.push((r) => valores.includes(r[coluna]));
                capturas.filtros.messages!.push({ coluna, valor: valores });
                return cadeia;
              },
              // LIKE do Postgres, APLICADO: `%` é qualquer sequência, `_` um
              // caractere, `\_` o sublinhado literal. A remoção do eco por sufixo
              // (`_<id bare>`, @lid × @c.us) é exatamente o que este elo mede.
              like: (coluna: string, padrao: string) => {
                const re = new RegExp(
                  "^" +
                    padrao.replace(/\\_|%|_|[.*+?^${}()|[\]\\]/g, (t) =>
                      t === "\\_" ? "_" : t === "%" ? ".*" : t === "_" ? "." : `\\${t}`,
                    ) +
                    "$",
                );
                filtros.push((r) => typeof r[coluna] === "string" && re.test(r[coluna] as string));
                capturas.filtros.messages!.push({ coluna, valor: `like:${padrao}` });
                return cadeia;
              },
              then: (
                resolve: (v: { error: null }) => unknown,
                reject?: (e: unknown) => unknown,
              ) => {
                for (const alvo of filtrarMensagens(filtros)) {
                  const i = mensagens.indexOf(alvo);
                  if (i >= 0) mensagens.splice(i, 1);
                }
                return Promise.resolve({ error: null }).then(resolve, reject);
              },
            };
            return cadeia;
          },
          select: (colunas = "") => {
            capturas.selects.messages!.push(colunas);
            const filtros: Array<(r: LinhaDoDuble) => boolean> = [];
            const cadeia = {
              eq: (coluna: string, valor: unknown) => {
                filtros.push((r) => r[coluna] === valor);
                capturas.filtros.messages!.push({ coluna, valor });
                return cadeia;
              },
              neq: (coluna: string, valor: unknown) => {
                filtros.push((r) => r[coluna] !== valor);
                capturas.filtros.messages!.push({ coluna, valor: `neq:${String(valor)}` });
                return cadeia;
              },
              in: (coluna: string, valores: unknown[]) => {
                filtros.push((r) => valores.includes(r[coluna]));
                capturas.filtros.messages!.push({ coluna, valor: valores });
                return cadeia;
              },
              order: () => cadeia,
              limit: () => cadeia,
              // A leitura em lote devolve as linhas como elas estão, sem casar
              // filtro: é o acumulado do dublê legado, e é ele que faz o aviso
              // ao lead enxergar as falas da IA em vez de esquecer cada insert.
              then: (
                resolve: (v: { data: LinhaDoDuble[]; error: null }) => unknown,
                reject?: (e: unknown) => unknown,
              ) =>
                Promise.resolve({
                  data: mensagens.map((r) => ({ ...r })),
                  error: null,
                }).then(resolve, reject),
              maybeSingle: async () => {
                const alvos = filtrarMensagens(filtros);
                return { data: alvos[0] ? { ...alvos[0] } : null, error: null };
              },
              single: async () => {
                const alvos = filtrarMensagens(filtros);
                return { data: alvos[0] ? { ...alvos[0] } : null, error: null };
              },
            };
            return cadeia;
          },
        };
      }

      throw new Error(`duble-do-handler: tabela inesperada '${tabela}'`);
    },
    rpc: async (nome: string, args?: Record<string, unknown>) => {
      capturas.rpcs.push({ nome, args: args ?? {} });
      return {
        data: typeof opcoes.rpcData === "function" ? opcoes.rpcData() : opcoes.rpcData,
        error: null,
      };
    },
  };

  return {
    supabase: client as unknown as SupabaseClient,
    capturas,
    mensagens,
  };
}
