import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";

/**
 * TAREFAS POR TOKEN (#4516) — a porta existe, o isolamento vale e a criação
 * não duplica.
 *
 * ─── O que estava quebrado ────────────────────────────────────────────────
 *
 * `app/api/v1/tasks/**` autenticava só por cookie (`requireRole`) e a regra
 * morava DENTRO da rota, sem `_handler`. Isso produzia dois defeitos de uma vez:
 *
 *  1. um cliente que integra por token não conseguia listar nem escrever
 *     tarefa — `401` do proxy antes de qualquer coisa, porque o caminho não
 *     estava em `lib/auth/public-paths.ts`;
 *  2. uma ferramenta MCP não chama rota Next, então a única saída seria
 *     reescrever a regra num segundo lugar — exatamente o que a onda proíbe.
 *
 * A cura foi mover a regra para `_handler.ts` (rota e tool chamam a MESMA
 * função) e abrir o caminho com escopo próprio.
 *
 * ─── O que este arquivo prova, e por quê ──────────────────────────────────
 *
 *  • IDEMPOTÊNCIA (real, com `lib/api/idempotency.ts`, não com dublê do
 *    helper): duas chamadas com a mesma chave devolvem a MESMA tarefa e o
 *    banco recebe UM INSERT. É o que salva a integração que retenta por
 *    timeout — o modo de falha que a issue descreve.
 *  • ISOLAMENTO POR ORGANIZAÇÃO: editar/excluir com id de outra casa dá 404 e
 *    não escreve. Pelo MCP o client é service-role, então o `organization_id`
 *    explícito é a ÚNICA barreira — a RLS não está no caminho.
 *  • PROCEDÊNCIA: `created_by` é FK para `auth.users` e recebe `null` quando
 *    quem cria é token; o audit leva `actorApiTokenId`. Sem isso o INSERT morre
 *    em 23503 (o defeito medido em `/api/v1/messages`).
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/tarefas/atividade", () => ({
  registraAtividadeDaTarefa: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tarefas/responsavel", () => ({
  conferirResponsavel: vi.fn(async () => "ok"),
}));
vi.mock("@/lib/tarefas/demanda", () => ({
  conferirDemanda: vi.fn(async () => "ok"),
}));
vi.mock("@/lib/db", () => ({ portaDaAplicacao: () => ({ fake: true }) }));

const { criarTarefaHandler, editarTarefaHandler, excluirTarefaHandler, listarTarefasHandler } =
  await import("@/app/api/v1/tasks/_handler");
const { audit } = await import("@/lib/audit");
const { ApiError } = await import("@/lib/api/types");
const { conferirDemanda } = await import("@/lib/tarefas/demanda");

const ORG = "aaaaaaaa-4516-4000-8000-00000000000a";
const OUTRA_ORG = "bbbbbbbb-4516-4000-8000-00000000000b";
const USER = "cccccccc-4516-4000-8000-00000000000c";
const TOKEN = "dddddddd-4516-4000-8000-00000000000d";
const TAREFA = "eeeeeeee-4516-4000-8000-00000000000e";
const CHAVE = "ffffffff-4516-4000-8000-00000000000f";

type Linha = Record<string, unknown>;

/**
 * Dublê de banco com DUAS tabelas de verdade em memória.
 *
 * É maior que o usual de propósito: o comportamento sob teste (não duplicar) é
 * o do `comIdempotencia` REAL, e ele lê, reserva e grava recibo em
 * `idempotency_keys`. Trocar o helper por um mock provaria só que o handler o
 * chama — não que a segunda chamada deixou de criar a segunda tarefa.
 */
function banco() {
  // O índice por string continua valendo (`tabelas[tabela]` dentro de
  // `consulta`), e `crm_tasks` é nomeado porque o teste o acessa direto: sem o
  // cruzamento, `tabelas.crm_tasks` seria `Linha[] | undefined` e o `tsc` do CI
  // reprovava em TS18048 (verify-parte (1), head a3df5dd70c).
  const tabelas: Record<string, Linha[]> & { crm_tasks: Linha[] } = {
    crm_tasks: [],
    idempotency_keys: [],
  };
  const estado = { insertsDeTarefa: 0, filtrosDaLista: [] as [string, unknown][] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function consulta(tabela: string, op: "select" | "insert" | "update" | "delete", payload?: Linha): any {
    const filtros: [string, unknown][] = [];
    const linhas = tabelas[tabela] ?? [];
    const casam = () => linhas.filter((l) => filtros.every(([c, v]) => l[c] === v));

    const cadeia: Record<string, unknown> = {};
    const devolver = () => cadeia;
    for (const m of ["eq", "gt", "gte", "lte", "order", "limit", "is", "in", "not"]) {
      cadeia[m] = (coluna: string, valor: unknown) => {
        if (m === "eq") filtros.push([coluna, valor]);
        if (tabela === "crm_tasks" && m === "eq" && op === "select") {
          estado.filtrosDaLista.push([coluna, valor]);
        }
        return devolver();
      };
    }

    const resultado = (): { data: unknown; error: unknown } => {
      if (op === "select") return { data: casam(), error: null };
      if (op === "delete") {
        const alvo = casam();
        for (const l of alvo) linhas.splice(linhas.indexOf(l), 1);
        return { data: alvo.map((l) => ({ id: l.id })), error: null };
      }
      const alvo = casam();
      for (const l of alvo) Object.assign(l, payload);
      return { data: alvo, error: null };
    };

    cadeia.select = (colunas?: string) => {
      if (op !== "select") {
        // update(...).select("id").maybeSingle() — usada na retomada de reserva.
        cadeia.maybeSingle = async () => ({ data: casam()[0] ?? null, error: null });
        cadeia.single = async () => ({ data: casam()[0] ?? null, error: null });
      }
      if (colunas === "status") {
        cadeia.maybeSingle = async () => ({ data: casam()[0] ?? null, error: null });
        return cadeia;
      }
      if (colunas === "id") {
        cadeia.maybeSingle = async () => {
          const r = resultado();
          return { data: (r.data as Linha[])[0] ?? null, error: null };
        };
        return cadeia;
      }
      cadeia.single = async () => {
        const r = resultado();
        const primeira = (r.data as Linha[])[0] ?? null;
        // O PostgREST devolve PGRST116 quando `.single()` não casa linha — é o
        // código que o handler traduz em 404. Um dublê que devolvesse
        // `{data: null, error: null}` faria o teste passar por acidente e
        // esconderia justamente o caminho do isolamento entre organizações.
        if (primeira === null) return { data: null, error: { code: "PGRST116" } };
        return { data: primeira, error: r.error };
      };
      cadeia.maybeSingle = async () => {
        const r = resultado();
        return { data: (r.data as Linha[])[0] ?? null, error: r.error };
      };
      cadeia.then = (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: resultado().data, error: null }).then(ok, falha);
      return cadeia;
    };

    cadeia.insert = (linha: Linha) => {
      if (tabela === "crm_tasks") estado.insertsDeTarefa += 1;
      linhas.push({ ...linha });
      return cadeia;
    };

    cadeia.then = (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => {
      // O `update(...)`/`delete()` são aguardados direto na cadeia: sem executar
      // `resultado()` aqui, o recibo de idempotência nunca seria gravado e o
      // teste veria `em_curso` numa chave que já terminou.
      const r = resultado();
      return Promise.resolve({ data: r.data, error: r.error }).then(ok, falha);
    };

    return cadeia;
  }

  const cliente = {
    from: (tabela: string) => ({
      select: (colunas?: string) => consulta(tabela, "select").select(colunas),
      insert: (linha: Linha) => consulta(tabela, "insert", linha).insert(linha),
      update: (payload: Linha) => consulta(tabela, "update", payload),
      delete: () => consulta(tabela, "delete"),
    }),
  };

  return { cliente: cliente as unknown as SupabaseClient, tabelas, estado };
}

const ctxDoToken = (extra: Partial<HandlerCtx> = {}) =>
  ({
    organization_id: ORG,
    actor: { type: "api_token", id: TOKEN, organization_id: ORG },
    requestId: "req-4516",
    apiTokenId: TOKEN,
    ...extra,
  }) as unknown as HandlerCtx;

const criacao = {
  title: "Ligar de volta para a Ana",
  priority: "medium" as const,
  status: "pending" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#4516 — criar tarefa por token", () => {
  it("a MESMA chave de idempotência não cria duas tarefas", async () => {
    const { cliente, tabelas, estado } = banco();
    const ctx = ctxDoToken({ idempotencyKey: CHAVE });

    const primeira = await criarTarefaHandler(cliente, ctx, criacao);
    const segunda = await criarTarefaHandler(cliente, ctx, criacao);

    expect(estado.insertsDeTarefa).toBe(1);
    expect(tabelas.crm_tasks).toHaveLength(1);
    // A segunda chamada devolve a MESMA tarefa, com o mesmo id — é o contrato
    // que o cliente usa para não perder o registro quando a rede falha.
    expect((segunda.task as { id?: string }).id).toBe((primeira.task as { id?: string }).id);
  });

  it("a mesma chave com corpo DIFERENTE é 409 `idempotency_conflict` — a chave é que está errada", async () => {
    const { cliente } = banco();
    const ctx = ctxDoToken({ idempotencyKey: CHAVE });

    await criarTarefaHandler(cliente, ctx, criacao);
    const erro = await criarTarefaHandler(cliente, ctx, {
      ...criacao,
      title: "Outra coisa completamente diferente",
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).code).toBe("idempotency_conflict");
  });

  it("`created_by` é NULO para token (FK de auth.users) e o audit leva a linha do token", async () => {
    const { cliente, tabelas } = banco();

    await criarTarefaHandler(cliente, ctxDoToken(), criacao);

    expect(tabelas.crm_tasks[0]?.created_by).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "crm_task.created",
        actorUserId: null,
        actorApiTokenId: TOKEN,
        metadata: expect.objectContaining({ via: "token" }),
      }),
    );
  });

  it("pela PESSOA, `created_by` continua sendo o usuário — a cura não apaga o rastro da tela", async () => {
    const { cliente, tabelas } = banco();
    const ctx = {
      organization_id: ORG,
      actor: { type: "user", id: USER, role: "agent" },
      requestId: "req-4516",
    } as unknown as HandlerCtx;

    await criarTarefaHandler(cliente, ctx, criacao);

    expect(tabelas.crm_tasks[0]?.created_by).toBe(USER);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER, actorApiTokenId: null }),
    );
  });
});

describe("#4516 — isolamento por organização", () => {
  it("editar tarefa de OUTRA organização → 404, e nada é gravado", async () => {
    const { cliente, tabelas } = banco();
    // A linha existe, mas é da outra casa: o filtro `organization_id` não a
    // encontra. Sem o filtro explícito, o service-role do MCP a alcançaria.
    tabelas.crm_tasks.push({ id: TAREFA, organization_id: OUTRA_ORG, status: "pending", title: "da outra" });

    const erro = await editarTarefaHandler(cliente, ctxDoToken(), {
      id: TAREFA,
      title: "sequestrada",
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).status).toBe(404);
    expect(tabelas.crm_tasks[0]?.title).toBe("da outra");
  });

  it("excluir tarefa de OUTRA organização → 404, e a linha continua lá", async () => {
    const { cliente, tabelas } = banco();
    tabelas.crm_tasks.push({ id: TAREFA, organization_id: OUTRA_ORG, status: "pending", title: "da outra" });

    const erro = await excluirTarefaHandler(cliente, ctxDoToken(), { id: TAREFA }).catch(
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).status).toBe(404);
    expect(tabelas.crm_tasks).toHaveLength(1);
  });

  it("a listagem consulta SEMPRE com a organização do ctx", async () => {
    const { cliente, estado } = banco();

    await listarTarefasHandler(cliente, ctxDoToken(), { aberto: true });

    expect(estado.filtrosDaLista).toContainEqual(["organization_id", ORG]);
    // O outro lado da régua: a organização alheia não aparece em NENHUM filtro.
    expect(estado.filtrosDaLista).not.toContainEqual(["organization_id", OUTRA_ORG]);
  });
});

/**
 * A CONFERÊNCIA DE DEMANDA VALE NOS DOIS CAMINHOS (#4523).
 *
 * `conferirDemanda` (app/api/v1/tasks/_handler.ts:182) protege uma FK que a RLS
 * NÃO cobre: pelo MCP o client é service-role. Quando a regra saiu da rota, ela
 * precisava continuar valendo para quem entra por cookie E para quem entra por
 * token — se ficasse só num dos dois, o outro passaria a gravar `demanda_id` de
 * outra organização (ou de demanda encerrada) sem erro.
 *
 * A prova é a mesma pergunta feita duas vezes: mesmo veredito, mesmo desfecho,
 * ator diferente. Um dublê de `editarTarefaHandler` não serviria — o que se
 * está medindo é que o handler REAL consulta a régua antes de escrever.
 */
describe("#4523 — conferência de demanda: 422 e 409 nos dois caminhos", () => {
  const DEMANDA = "11111111-4523-4000-8000-000000000011";
  const ctxDaPessoa = {
    organization_id: ORG,
    actor: { type: "user", id: USER, role: "agent" },
    requestId: "req-4523",
  } as unknown as HandlerCtx;

  const entrar = async (
    ctx: HandlerCtx,
    veredito: "fora_da_organizacao" | "encerrada",
  ): Promise<{
    erro: unknown;
    tabelas: Record<string, Linha[]> & { crm_tasks: Linha[] };
    cliente: SupabaseClient;
  }> => {
    const { cliente, tabelas } = banco();
    tabelas.crm_tasks.push({ id: TAREFA, organization_id: ORG, status: "pending", title: "intacta" });
    vi.mocked(conferirDemanda).mockResolvedValueOnce(veredito);

    const erro = await editarTarefaHandler(cliente, ctx, {
      id: TAREFA,
      demanda_id: DEMANDA,
    }).catch((e: unknown) => e);

    return { erro, tabelas, cliente };
  };

  it.each([
    ["token", () => ctxDoToken()],
    ["sessão", () => ctxDaPessoa],
  ])("%s: demanda de outra organização → 422 `fora_da_organizacao`, nada gravado", async (_nome, ctx) => {
    const { erro, tabelas } = await entrar(ctx(), "fora_da_organizacao");

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).status).toBe(422);
    expect((erro as InstanceType<typeof ApiError>).code).toBe("validation_failed");
    expect(tabelas.crm_tasks[0]?.title).toBe("intacta");
    expect(conferirDemanda).toHaveBeenCalledWith(expect.anything(), ORG, DEMANDA);
  });

  it.each([
    ["token", () => ctxDoToken()],
    ["sessão", () => ctxDaPessoa],
  ])("%s: demanda encerrada → 409 `encerrada`, nada gravado", async (_nome, ctx) => {
    const { erro, tabelas } = await entrar(ctx(), "encerrada");

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).status).toBe(409);
    expect((erro as InstanceType<typeof ApiError>).code).toBe("state_conflict");
    expect(tabelas.crm_tasks[0]?.title).toBe("intacta");
  });
});
