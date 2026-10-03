import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `followup.callback_enabled: false` tem de tirar `crm_schedule_followup` do
 * que o turno ENTREGA ao modelo — não só da regra pura em
 * `lib/followup/callback-policy.ts`. Os testes da regra ficam verdes mesmo que
 * `buildMcpTurnTools` pare de chamá-la, e aí o controle da tela não faz nada.
 *
 * Este arquivo amarra a ponta MCP (Conversador e Operador passam por ela). A
 * ponta nativa (`schedule_followup`, em `runAgentTurn`) não tem harness sem
 * banco: fica como lacuna declarada, não coberta por grep de fonte.
 */

const pickToolsFromMcp = vi.fn((input: { toolIds: string[] }) =>
  Object.fromEntries(input.toolIds.map((id) => [id, {}])),
);

vi.mock("@/lib/ai/runtime/tools", () => ({ pickToolsFromMcp }));
vi.mock("@/lib/ai/runtime/mcp_token", () => ({
  mintEphemeralToken: vi.fn(async () => ({ id: "tok-1" })),
  revokeEphemeralToken: vi.fn(async () => {}),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ modulosLigados: vi.fn(async () => []) }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  currentExecutionJob: () => undefined,
  currentExecutionBoundary: () => undefined,
}));

const { buildMcpTurnTools } = await import("@/lib/agent-engine/edge/crm/mcp-tools");

const TOOLS = ["crm_schedule_followup", "crm_list_followups", "crm_cancel_followup"];

/**
 * Falso do Supabase só com o que `buildMcpTurnTools` passou a tocar: desde
 * #2147 ele lê `organizations.settings` procurando servidor MCP externo.
 * Este arquivo mede o followup, não esse servidor — então o falso devolve um
 * registro sem settings e o turno segue como antes (é o mesmo esquema do
 * mock de `@/lib/supabase/server` lá em cima).
 */
const supabaseSemServidorExterno = {
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
    }),
  }),
};

async function idsEntreguesAoModelo(followup: unknown): Promise<string[]> {
  const agentConfig = { agentId: "agente-1", toolIds: TOOLS, pipelineIds: [], followup };
  const out = await buildMcpTurnTools(
    { supabase: supabaseSemServidorExterno as never },
    { organizationId: "org-1", jobId: "job-1" },
    agentConfig as never,
    { warn: vi.fn() } as never,
  );
  expect(pickToolsFromMcp).toHaveBeenCalledTimes(1);
  expect(out?.toolIds).toEqual(pickToolsFromMcp.mock.calls[0]![0].toolIds);
  return pickToolsFromMcp.mock.calls[0]![0].toolIds;
}

beforeEach(() => {
  pickToolsFromMcp.mockClear();
});

describe("buildMcpTurnTools respeita followup.callback_enabled", () => {
  it("desligado: o criador de retorno não chega ao modelo; consultar e cancelar ficam", async () => {
    const ids = await idsEntreguesAoModelo({ enabled: true, callback_enabled: false });
    expect(ids).not.toContain("crm_schedule_followup");
    expect(ids).toEqual(["crm_list_followups", "crm_cancel_followup"]);
  });

  it("controle: versão legada sem o campo entrega as três", async () => {
    const ids = await idsEntreguesAoModelo({ enabled: false, flow_pointer_ids: [] });
    expect(ids).toEqual(TOOLS);
  });

  it("controle: ligado explícito entrega as três", async () => {
    const ids = await idsEntreguesAoModelo({ enabled: false, callback_enabled: true });
    expect(ids).toEqual(TOOLS);
  });
});
