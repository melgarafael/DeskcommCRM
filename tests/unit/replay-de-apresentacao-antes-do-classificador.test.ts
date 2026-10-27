import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handoff: vi.fn(async () => false),
  elegibilidade: vi.fn(async (): Promise<unknown> => null),
  loadConversationAgent: vi.fn(),
  resolveConversation: vi.fn(),
  resume: vi.fn(),
  runModel: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/agent-engine/agent/human-handoff", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLeadInHandoff: mocks.handoff,
}));
vi.mock("@/lib/ai/elegibilidade/consulta-pg", () => ({
  decidirElegibilidadeDaConversa: mocks.elegibilidade,
}));
vi.mock("@/lib/agent-engine/agent/agent-config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadConversationAgentConfig: mocks.loadConversationAgent,
}));
vi.mock("@/lib/agent-engine/agent/resolve-turn-agent", () => ({
  resolveConversationTurn: mocks.resolveConversation,
}));
vi.mock("@/lib/catalogo/retomada-de-apresentacao", () => ({
  resumePersistedCatalogPresentation: mocks.resume,
}));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runModelCall: mocks.runModel,
}));

import {
  createInboundTurnHandler,
  JobSettledError,
  type InboundTurnDeps,
} from "@/lib/agent-engine/agent/inbound-turn";
import { CAMADA_RESTRICAO_COMERCIAL } from "@/lib/agent-engine/guardrails/camadas-da-org";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { CHAVE_DO_SNAPSHOT_DA_APRESENTACAO } from "@/lib/catalogo/snapshot-de-apresentacao";

const IDS = {
  organization: "11000000-0000-4000-8000-000000000001",
  contact: "11000000-0000-4000-8000-000000000002",
  conversation: "11000000-0000-4000-8000-000000000003",
  channel: "11000000-0000-4000-8000-000000000004",
  job: "11000000-0000-4000-8000-000000000005",
  message: "11000000-0000-4000-8000-000000000006",
  event: "11000000-0000-4000-8000-000000000007",
};

const job = {
  id: IDS.job,
  organization_id: IDS.organization,
  contact_id: IDS.contact,
  kind: "inbound_turn",
  catalog_presentation_snapshot: {schema_version:1},
  payload: {
    conversation_id: IDS.conversation,
    contact_id: IDS.contact,
    channel_session_id: IDS.channel,
    inbound_message_id: IDS.message,
    crm_event_id: IDS.event,
  },
};

const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {},
  crmCfg: {},
  knobs: {},
  channel: vi.fn(() => ({ send: vi.fn() })),
} as unknown as InboundTurnDeps;

function agent(
  overrides: { pausedAt?: string | null; operationMode?: "automatic" | "assisted" } = {},
) {
  return {
    pausedAt: null,
    operationMode: "automatic",
    ...overrides,
  };
}

async function run(candidate: unknown = job): Promise<void> {
  await createInboundTurnHandler(deps)(candidate as never, { query: mocks.query } as never, {
    workerId: "worker-a",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation(async (sql: string, values: unknown[]) => {
    expect(sql).toBe("select enabled from org_guardrail_layers where organization_id = $1 and layer = $2");
    expect(values).toEqual([IDS.organization, CAMADA_RESTRICAO_COMERCIAL]);
    return { rows: [{ enabled: false }] };
  });
  mocks.handoff.mockResolvedValue(false);
  mocks.elegibilidade.mockResolvedValue(null);
  mocks.loadConversationAgent.mockResolvedValue(agent());
  mocks.resume.mockResolvedValue({ handled: true, disposition: "completed" });
  mocks.resolveConversation.mockRejectedValue(new Error("classifier_must_not_run"));
  mocks.runModel.mockRejectedValue(new Error("llm_must_not_run"));
});

describe("replay de apresentacao persistida antes da classificacao", () => {
  it("erro na consulta da restrição comercial falha fechado antes de retomar", async () => {
    const erro = new Error("consulta da política indisponível");
    mocks.query.mockRejectedValueOnce(erro);
    await expect(run()).rejects.toBe(erro);
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.resolveConversation).not.toHaveBeenCalled();
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("retoma pelo agente aderido a conversa sem chamar classificador nem LLM", async () => {
    await run();

    expect(mocks.loadConversationAgent).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.resolveConversation).not.toHaveBeenCalled();
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("pausa encaminha o snapshot para reagendamento sem classificar nem chamar o modelo", async () => {
    mocks.loadConversationAgent.mockResolvedValue(agent({ pausedAt: "2026-10-18T12:00:00.000Z" }));
    mocks.resume.mockResolvedValue({ handled: true, disposition: "settled" });

    await expect(run()).rejects.toBeInstanceOf(JobSettledError);

    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.resolveConversation).not.toHaveBeenCalled();
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("modo assistido bloqueia o replay antes de qualquer classificacao", async () => {
    mocks.loadConversationAgent.mockResolvedValue(agent({ operationMode: "assisted" }));

    mocks.resume.mockRejectedValue(new StaleServiceBoundaryError());
    await expect(run()).rejects.toBeInstanceOf(StaleServiceBoundaryError);

    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.loadConversationAgent).not.toHaveBeenCalled();
    expect(mocks.resolveConversation).not.toHaveBeenCalled();
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("handoff bloqueia antes de consultar agente, replay, classificador ou LLM", async () => {
    mocks.handoff.mockResolvedValue(true);

    await run();

    expect(mocks.loadConversationAgent).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.resolveConversation).not.toHaveBeenCalled();
    expect(mocks.runModel).not.toHaveBeenCalled();
  });
});


it("colunaNULL e payloadlegado não impedem o caminho normal de uma mensagem válida",async()=>{
  const legacy={...job,catalog_presentation_snapshot:null,payload:{...job.payload,[CHAVE_DO_SNAPSHOT_DA_APRESENTACAO]:{forged:true}}};
  await expect(run(legacy)).rejects.toThrow("classifier_must_not_run");
  expect(mocks.resolveConversation).toHaveBeenCalledOnce();
  expect(mocks.resume).not.toHaveBeenCalled();
});
