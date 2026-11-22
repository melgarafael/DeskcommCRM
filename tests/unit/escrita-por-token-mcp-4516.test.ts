import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS FERRAMENTAS MCP DE TAREFA (#4516) — e o gate de escopo das que são NOSSAS.
 *
 * A issue pede a capacidade "por token E por MCP". A parte por token está nas
 * rotas (`app/api/v1/tasks`); aqui é o caminho do agente/cliente MCP, onde
 * `requiresScope` só conhece `mcp:read`/`mcp:write`. O escopo PRÓPRIO é
 * conferido por `exigeEscopoDoTokenDeIntegracao`, e a diferença que ele usa é a
 * que existe de verdade no runtime: `/api/mcp` sempre preenche `tokenScopes`
 * (`lib/mcp/server.ts`), o agente da casa NUNCA preenche
 * (`lib/ai/runtime/agent.ts`).
 *
 * ─── NOTA DE ESCOPO (22/11): a main criou a família dela (#4838) ────────────
 *
 * A main mergeou `lib/mcp/tools/tarefas.ts` com `crm_list_tasks`,
 * `crm_create_task` e `crm_update_task`, com SQL direto e SEM este gate. Neste
 * PR esse arquivo é o DA MAIN, byte a byte: não há duas definições do mesmo
 * `name`. As ferramentas que a main não tem — concluir e apagar — moram em
 * `lib/mcp/tools/tarefas-escrita.ts` e continuam passando pelo `_handler`,
 * então é nelas que o escopo próprio vale, e é nelas que este arquivo mede.
 *
 * O que saiu daqui por consequência, e por quê:
 *   • "leitura exige `tasks:read`" — `crm_list_tasks` é a da main, cuja régua é
 *     `mcp:read`; a asserção descreveria uma garantia que o PR não entrega mais;
 *   • "a chave de idempotência da tool chega ao handler" — `crm_create_task` é
 *     a da main, que não tem `idempotency_key` no schema. A idempotência por
 *     chave continua coberta no caminho da ROTA, em
 *     `tests/unit/tarefas-por-token-4516.test.ts`.
 *
 * ⚠️ A unificação das duas famílias é PERGUNTA AO MANTENEDOR: ou a tool da main
 * passa a chamar o `_handler`, ou estas duas migram para o SQL dela. Enquanto
 * isso, o diff deste PR não toca no arquivo da main.
 */
vi.mock("@/app/api/v1/tasks/_handler", () => ({
  LIMITE_MAXIMO_DA_LISTA: 500,
  listarTarefasHandler: vi.fn(async () => ({ tasks: [{ id: "t-1", title: "Ligar" }] })),
  criarTarefaHandler: vi.fn(async () => ({ task: { id: "t-1" } })),
  editarTarefaHandler: vi.fn(async () => ({ task: { id: "t-1", status: "done" } })),
  excluirTarefaHandler: vi.fn(async () => ({ deleted: true })),
}));

const { crmCompleteTask, crmDeleteTask } = await import("@/lib/mcp/tools/tarefas-escrita");
const { editarTarefaHandler, excluirTarefaHandler } = await import(
  "@/app/api/v1/tasks/_handler"
);
const { McpAuthError } = await import("@/lib/mcp/auth");
const { TOOL_CATALOG } = await import("@/lib/mcp/tools/catalog");
const { getToolByName } = await import("@/lib/mcp/tools");

const ORG = "aaaaaaaa-4516-4000-8000-00000000000a";
const TOKEN = "bbbbbbbb-4516-4000-8000-00000000000b";

const ctxDoToken = (tokenScopes: string[] | undefined) =>
  ({
    supabase: { from: vi.fn() },
    organizationId: ORG,
    actor: { type: "api_token", id: TOKEN, role: "ai_operator" },
    requestId: "req-mcp-4516",
    apiTokenId: TOKEN,
    ...(tokenScopes === undefined ? {} : { tokenScopes }),
  }) as never;

beforeEach(() => {
  // Sem isto, `mock.calls[0]` é a chamada do teste anterior — o teste passaria a
  // medir ordem de execução, não o que ele diz medir.
  vi.clearAllMocks();
});

describe("#4516 — as tools de tarefa pedem o escopo PRÓPRIO ao token de fora", () => {
  it("apagar SEM `tasks:write` → 403 nomeado, e o handler nem roda", async () => {
    const erro = await crmDeleteTask
      .handler({ task_id: "cccccccc-4516-4000-8000-00000000000c" }, ctxDoToken(["mcp:write"]))
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(McpAuthError);
    expect((erro as InstanceType<typeof McpAuthError>).httpStatus).toBe(403);
    expect(excluirTarefaHandler).not.toHaveBeenCalled();
  });

  it("apagar COM `tasks:write` → executa", async () => {
    const saida = await crmDeleteTask.handler(
      { task_id: "cccccccc-4516-4000-8000-00000000000c" },
      ctxDoToken(["mcp:write", "tasks:write"]),
    );

    expect(saida).toMatchObject({ deleted: true });
    expect(excluirTarefaHandler).toHaveBeenCalled();
  });

  it("concluir SEM `tasks:write` → 403 nomeado, e o handler nem roda", async () => {
    const erro = await crmCompleteTask
      .handler({ task_id: "cccccccc-4516-4000-8000-00000000000c" }, ctxDoToken(["mcp:write"]))
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(McpAuthError);
    expect((erro as InstanceType<typeof McpAuthError>).httpStatus).toBe(403);
    expect(editarTarefaHandler).not.toHaveBeenCalled();
  });

  it("concluir COM `tasks:write` → executa e devolve a situação gravada", async () => {
    const saida = await crmCompleteTask.handler(
      { task_id: "cccccccc-4516-4000-8000-00000000000c" },
      ctxDoToken(["mcp:write", "tasks:write"]),
    );

    expect(saida).toMatchObject({ completed: true });
    expect(editarTarefaHandler).toHaveBeenCalled();
  });

  it("o AGENTE DA CASA (`tokenScopes` ausente) não é barrado — o escopo é do token de fora", async () => {
    // Sem este caso, a cura viraria um muro: o runtime nativo monta o ctx sem
    // `tokenScopes`, e o agente publicado não teria como concluir tarefa.
    const saida = await crmCompleteTask.handler(
      { task_id: "cccccccc-4516-4000-8000-00000000000c" },
      ctxDoToken(undefined),
    );

    expect(saida).toMatchObject({ completed: true });
  });
});

describe("catálogo × handlers — as tools de tarefa são alcançáveis pelos dois caminhos", () => {
  it.each([
    "crm_list_tasks",
    "crm_create_task",
    "crm_update_task",
    "crm_complete_task",
    "crm_delete_task",
  ])("%s tem handler e entrada de catálogo", (nome) => {
    expect(getToolByName(nome)).toBeDefined();
    expect(TOOL_CATALOG.some((t) => t.name === nome)).toBe(true);
  });
});
