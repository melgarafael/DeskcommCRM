import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS FERRAMENTAS MCP EQUIVALENTES (#4515, #4516) — e o gate de escopo DELAS.
 *
 * A issue pede a capacidade "por token E por MCP". A parte por token está nas
 * rotas (`app/api/v1/agenda/agendamentos` e `app/api/v1/tasks`); aqui é o
 * caminho do agente/cliente MCP, onde
 * `requiresScope` só conhece `mcp:read`/`mcp:write`. O escopo PRÓPRIO é
 * conferido por `exigeEscopoDoTokenDeIntegracao`, e a diferença que ele usa é a
 * que existe de verdade no runtime: `/api/mcp` sempre preenche `tokenScopes`
 * (`lib/mcp/server.ts`), o agente da casa NUNCA preenche
 * (`lib/ai/runtime/agent.ts`).
 *
 * ⚠️ Sem essa distinção, uma das duas pontas quebra:
 *   • exigir o escopo por `requiresScope` bloquearia o agente nativo, cujo
 *     `auth.scopes` é só `mcp:read`/`mcp:write`;
 *   • não exigir nada deixaria o token sem `tasks:write` apagar tarefa.
 */
vi.mock("@/app/api/v1/tasks/_handler", () => ({
  LIMITE_MAXIMO_DA_LISTA: 500,
  listarTarefasHandler: vi.fn(async () => ({ tasks: [{ id: "t-1", title: "Ligar" }] })),
  criarTarefaHandler: vi.fn(async () => ({ task: { id: "t-1" } })),
  editarTarefaHandler: vi.fn(async () => ({ task: { id: "t-1", status: "done" } })),
  excluirTarefaHandler: vi.fn(async () => ({ deleted: true })),
}));
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", async () => {
  const real = await vi.importActual<
    typeof import("@/app/api/v1/agenda/agendamentos/_handler")
  >("@/app/api/v1/agenda/agendamentos/_handler");
  return { ...real, alterarAgendamentoHandler: vi.fn(async () => ({ id: "ag-1", status: "completed" })) };
});

const { crmListTasks, crmCreateTask, crmDeleteTask } = await import("@/lib/mcp/tools/tarefas");
const { crmSetAppointmentStatus } = await import("@/lib/mcp/tools/agendamento");
const { alterarAgendamentoHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");
const { listarTarefasHandler, excluirTarefaHandler } = await import("@/app/api/v1/tasks/_handler");
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
  it("token de integração SEM `tasks:write` → 403 nomeado, e o handler nem roda", async () => {
    const erro = await crmDeleteTask
      .handler({ task_id: "cccccccc-4516-4000-8000-00000000000c" }, ctxDoToken(["mcp:write"]))
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(McpAuthError);
    expect((erro as InstanceType<typeof McpAuthError>).httpStatus).toBe(403);
    expect(excluirTarefaHandler).not.toHaveBeenCalled();
  });

  it("token COM `tasks:write` → executa", async () => {
    const saida = await crmDeleteTask.handler(
      { task_id: "cccccccc-4516-4000-8000-00000000000c" },
      ctxDoToken(["mcp:write", "tasks:write"]),
    );

    expect(saida).toMatchObject({ deleted: true });
    expect(excluirTarefaHandler).toHaveBeenCalled();
  });

  it("leitura exige `tasks:read`, não `tasks:write`", async () => {
    const semLeitura = await crmListTasks
      .handler({}, ctxDoToken(["mcp:read", "tasks:write"]))
      .catch((e: unknown) => e);
    expect((semLeitura as InstanceType<typeof McpAuthError>).httpStatus).toBe(403);

    const comLeitura = await crmListTasks.handler({}, ctxDoToken(["mcp:read", "tasks:read"]));
    expect(comLeitura).toMatchObject({ listed: true });
    expect(listarTarefasHandler).toHaveBeenCalled();
  });

  it("o AGENTE DA CASA (`tokenScopes` ausente) não é barrado — o escopo é do token de fora", async () => {
    // Sem este caso, a cura viraria um muro: o runtime nativo monta o ctx sem
    // `tokenScopes`, e o agente publicado não teria como criar tarefa.
    const saida = await crmCreateTask.handler(
      { title: "Ligar de volta para a Ana" },
      ctxDoToken(undefined),
    );

    expect(saida).toMatchObject({ created: true });
  });

  it("a chave de idempotência da tool chega ao handler (mesma chave = sem duplicata)", async () => {
    const chave = "dddddddd-4516-4000-8000-00000000000d";
    const { criarTarefaHandler } = await import("@/app/api/v1/tasks/_handler");

    await crmCreateTask.handler(
      { title: "Ligar de volta para a Ana", idempotency_key: chave },
      ctxDoToken(["tasks:write"]),
    );

    expect(vi.mocked(criarTarefaHandler).mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: chave,
      organization_id: ORG,
    });
  });
});

describe("#4515 — a tool de desfecho por token", () => {
  it("token SEM `agenda:attendance` → 403, e o handler de agenda nem roda", async () => {
    const erro = await crmSetAppointmentStatus
      .handler(
        { appointment_id: "eeeeeeee-4515-4000-8000-00000000000e", status: "completed" },
        ctxDoToken(["mcp:write"]),
      )
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(McpAuthError);
    expect((erro as InstanceType<typeof McpAuthError>).httpStatus).toBe(403);
    expect(alterarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("token COM `agenda:attendance` grava, e o ctx leva a exceção NOMEADA", async () => {
    // O sinal `desfechoPorToken` não vem do input (onde qualquer chamador se
    // declararia autorizado), e sim do ctx — montado AQUI, depois do escopo.
    await crmSetAppointmentStatus.handler(
      { appointment_id: "eeeeeeee-4515-4000-8000-00000000000e", status: "no_show" },
      ctxDoToken(["mcp:write", "agenda:attendance"]),
    );

    expect(vi.mocked(alterarAgendamentoHandler).mock.calls[0]?.[1]).toMatchObject({
      desfechoPorToken: true,
      apiTokenId: TOKEN,
      organization_id: ORG,
    });
  });
});

describe("catálogo × handlers — as tools novas são alcançáveis pelos dois caminhos", () => {
  it.each([
    "crm_set_appointment_status",
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
