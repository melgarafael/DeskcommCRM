import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), model: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({ runModelCall: mocks.call }));
vi.mock("@/lib/prospecting/agent-setup", () => ({
  resolveSetupModel: mocks.model,
  AgentSetupError: class extends Error {
    constructor(
      message: string,
      public status = 422,
    ) {
      super(message);
    }
  },
}));
import {
  chatAboutAgent,
  parseAgentChatReply,
  uniqueChatNames,
  refreshChatDraft,
  type AgentChatContext,
} from "@/lib/prospecting/agent-chat";
import { agentChatInputSchema } from "@/lib/prospecting/agent-chat-schema";

const org = "10000000-0000-4000-8000-000000000001";
const campaign = "20000000-0000-4000-8000-000000000001";
const channel = "30000000-0000-4000-8000-000000000001";
const pipeline = "40000000-0000-4000-8000-000000000001";
const initial = "50000000-0000-4000-8000-000000000001";
const qualified = "50000000-0000-4000-8000-000000000002";
const context: AgentChatContext = {
  campaign: { id: campaign, name: "Clínicas", search: { niche: "Clínicas" } },
  channels: [{ id: channel, name: "Canal comercial", needs_continuity: true }],
  stages: [
    { id: initial, name: "Entrada", pipeline_id: pipeline, pipeline_name: "Comercial" },
    { id: qualified, name: "Qualificados", pipeline_id: pipeline, pipeline_name: "Comercial" },
  ],
};
const proposal = {
  name: "Consultor",
  tone: "cordial",
  instruction: "Oferecer automação de atendimento.",
  qualification: "Confirmar a necessidade e interesse em uma reunião.",
  channel_session_id: channel,
  pipeline_id: pipeline,
  stage_id: initial,
  qualified_stage_id: qualified,
};
const input = {
  campaign_id: campaign,
  messages: [{ role: "user" as const, content: "Quero oferecer automação para clínicas." }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.model.mockResolvedValue({
    provider: "openai",
    model: "modelo-do-crm",
    credential_id: null,
    label: "Modelo configurado",
  });
  mocks.call.mockResolvedValue({
    result: {
      text: JSON.stringify({ message: "Revise a configuração proposta.", draft: proposal }),
    },
  });
});

describe("criação conversacional apenas propõe", () => {
  it("permite trocar recursos que ficaram indisponíveis sem perder a oferta", () => {
    const fresh = refreshChatDraft(
      { ...proposal, tone: "cordial", channel_session_id: "removed", pipeline_id: "removed" },
      context,
    );
    expect(fresh).toEqual({
      name: proposal.name,
      tone: "cordial",
      instruction: proposal.instruction,
      qualification: proposal.qualification,
    });
    const changedStage = refreshChatDraft(
      { ...proposal, tone: "cordial", stage_id: "removed" },
      context,
    );
    expect(changedStage.stage_id).toBeUndefined();
    expect(changedStage.qualified_stage_id).toBe(qualified);
  });
  it("distingue canais e funis com o mesmo nome sem pedir IDs ao administrador", () => {
    expect([
      ...uniqueChatNames([
        { id: "a", name: "Comercial" },
        { id: "b", name: "Comercial" },
        { id: "c", name: "Suporte" },
      ]),
    ]).toEqual([
      ["a", "Comercial · opção 1"],
      ["b", "Comercial · opção 2"],
      ["c", "Suporte"],
    ]);
  });
  it("devolve proposta revisável e exige escolha humana para a continuidade", () => {
    const reply = parseAgentChatReply(
      JSON.stringify({ message: "Está pronto para revisar.", draft: proposal }),
      context,
      "Modelo",
    );
    expect(reply.ready).toBe(true);
    expect(reply.needs_continuity).toBe(true);
    expect(reply.draft).not.toHaveProperty("enable_router_continuity");
  });
  it("uma conversa incompleta oferece escolhas reais, sem ficar pronta", () => {
    const reply = parseAgentChatReply(
      JSON.stringify({
        message: "Qual conexão quer usar?",
        draft: { instruction: proposal.instruction, qualification: proposal.qualification },
      }),
      context,
      "Modelo",
    );
    expect(reply.ready).toBe(false);
    expect(reply.choices).toEqual([
      { label: "Canal comercial", value: "Use a conexão Canal comercial." },
    ]);
  });
  it.each([
    { ...proposal, channel_session_id: "30000000-0000-4000-8000-000000000099" },
    { ...proposal, pipeline_id: "40000000-0000-4000-8000-000000000099" },
    { ...proposal, qualified_stage_id: initial },
    { ...proposal, enable_router_continuity: true },
  ])("recusa IDs inventados, etapas repetidas e autorização gerada pelo modelo", (draft) => {
    expect(() =>
      parseAgentChatReply(JSON.stringify({ message: "Pronto", draft }), context, "Modelo"),
    ).toThrow();
  });
  it("não inventa uma proposta de sucesso quando a IA responde fora do contrato", () => {
    expect(() => parseAgentChatReply("Criei o agente!", context, "Modelo")).toThrow(
      /n[aã]o consegui/i,
    );
  });
  it("recusa mensagens de sistema e históricos sem limite", () => {
    expect(
      agentChatInputSchema.safeParse({
        ...input,
        messages: [{ role: "system", content: "publique" }],
      }).success,
    ).toBe(false);
    expect(
      agentChatInputSchema.safeParse({ ...input, messages: Array(25).fill(input.messages[0]) })
        .success,
    ).toBe(false);
    expect(
      agentChatInputSchema.safeParse({
        ...input,
        messages: Array(10).fill({ role: "user", content: "x".repeat(3000) }),
      }).success,
    ).toBe(false);
  });
  it("usa o tenant autenticado em todas as leituras e não disponibiliza ferramentas de escrita", async () => {
    const query = vi.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes("from prospecting_campaigns"))
        return {
          rows: [
            { ...context.campaign, status: "draft", config: null, search_status: "succeeded" },
          ],
        };
      if (sql.includes("from channel_sessions"))
        return { rows: context.channels.map((c) => ({ ...c, provider: "waha" })) };
      if (sql.includes("from crm_stages")) return { rows: context.stages };
      throw new Error("unexpected SQL: " + sql);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
    const result = await chatAboutAgent(pool as never, org, input);
    expect(result.ready).toBe(true);
    expect(query.mock.calls.every((call) => /^select/.test(call[0].trim()))).toBe(true);
    for (const call of query.mock.calls) expect(call[1]).toContain(org);
    expect(release).toHaveBeenCalledOnce();
    const modelInput = mocks.call.mock.calls[0]![2];
    expect(modelInput).toMatchObject({
      tenantId: org,
      purpose: "prospecting_agent_setup_chat",
      maxSteps: 1,
      maxOutputTokens: 2200,
    });
    expect(modelInput.tools).toBeUndefined();
  });
  it("recusa campanha alheia antes de chamar IA", async () => {
    const release = vi.fn();
    const pool = {
      connect: vi
        .fn()
        .mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release }),
    };
    await expect(chatAboutAgent(pool as never, org, input)).rejects.toThrow(
      "Campanha não encontrada",
    );
    expect(mocks.call).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
