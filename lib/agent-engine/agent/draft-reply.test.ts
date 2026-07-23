import { describe, expect, it, vi, beforeEach } from "vitest";

import { generateDraftReply } from "./draft-reply";
import { loadPublishedAgentConfig, type PublishedAgentConfig } from "./agent-config";
import { getLeadContext, type LeadContextResult } from "../edge/crm/get-lead-context";
import { runModelCall } from "../edge/llm/run-model-call";

vi.mock("./agent-config", () => ({ loadPublishedAgentConfig: vi.fn() }));
vi.mock("../edge/crm/get-lead-context", () => ({ getLeadContext: vi.fn() }));
vi.mock("../edge/llm/run-model-call", () => ({ runModelCall: vi.fn() }));

const mockLoadAgent = vi.mocked(loadPublishedAgentConfig);
const mockGetLeadContext = vi.mocked(getLeadContext);
const mockRunModelCall = vi.mocked(runModelCall);

const db = {} as never;
const llmCfg = {} as never;
const crmCfg = {} as never;

const input = {
  tenantId: "org-1",
  leadId: "contact-1",
  conversationId: "conv-1",
  channelSessionId: "session-1",
};

const AGENT: PublishedAgentConfig = {
  agentId: "agent-1",
  versionId: "version-1",
  agentName: "Bot Deskcomm",
  systemPrompt: "Você é a vendedora da loja X.",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  credentialId: "cred-1",
  maxSteps: 8,
  historyMessageWindow: 20,
  historyTokenWindow: 1000,
  handoffKeywords: [],
  handoffToolEnabled: false,
  splitMessages: false,
  splitMaxChars: 400,
  multimodalInput: false,
  toolIds: [],
  versionCreatedBy: null,
  agentCreatedBy: null,
};

function contextResult(overrides: Partial<LeadContextResult & { ok: true }> = {}): LeadContextResult {
  return {
    ok: true,
    tokenCount: 42,
    lgpd: {
      isAnonymized: false,
      isProspecting: false,
      legalBasis: { basis: null, legalBasisRef: null, consentGranted: false, dataOrigin: "whatsapp" },
    },
    context: {
      lead_id: input.leadId,
      contact: { name: "Rafael", phone: "+551199", email: null, tags: [], is_blocked: false },
      conversation_id: input.conversationId,
      messages: [
        { direction: "inbound", body: "Oi, quero saber o preço do produto X.", sent_at: "2026-07-22T10:00:00Z" },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateDraftReply", () => {
  it("agente publicado + contexto com histórico → chama runModelCall SEM tools/maxSteps e retorna o rascunho", async () => {
    mockLoadAgent.mockResolvedValue(AGENT);
    mockGetLeadContext.mockResolvedValue(contextResult());
    mockRunModelCall.mockResolvedValue({
      result: { text: "  Olá! O produto X custa R$ 99,90.  " },
      callId: "call-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costCents: 1,
      latencyMs: 1,
    } as never);

    const result = await generateDraftReply(db, llmCfg, crmCfg, input);

    expect(result).toEqual({ ok: true, draft: "Olá! O produto X custa R$ 99,90." });
    expect(mockRunModelCall).toHaveBeenCalledTimes(1);
    const call = mockRunModelCall.mock.calls[0]!;
    const runInput = call[2];
    expect(runInput.purpose).toBe("draft_suggestion");
    expect(runInput.tenantId).toBe(input.tenantId);
    expect(runInput.leadId).toBe(input.leadId);
    expect(runInput).not.toHaveProperty("tools");
    expect(runInput).not.toHaveProperty("maxSteps");
  });

  it("sem agente publicado → no_agent, sem chamar runModelCall", async () => {
    mockLoadAgent.mockResolvedValue(null);

    const result = await generateDraftReply(db, llmCfg, crmCfg, input);

    expect(result).toEqual({ ok: false, reason: "no_agent" });
    expect(mockGetLeadContext).not.toHaveBeenCalled();
    expect(mockRunModelCall).not.toHaveBeenCalled();
  });

  it("contato bloqueado → blocked, sem chamar runModelCall", async () => {
    mockLoadAgent.mockResolvedValue(AGENT);
    mockGetLeadContext.mockResolvedValue(
      contextResult({
        context: {
          lead_id: input.leadId,
          contact: { name: "Rafael", phone: null, email: null, tags: [], is_blocked: true },
          conversation_id: input.conversationId,
          messages: [],
        },
      }),
    );

    const result = await generateDraftReply(db, llmCfg, crmCfg, input);

    expect(result).toEqual({ ok: false, reason: "blocked" });
    expect(mockRunModelCall).not.toHaveBeenCalled();
  });

  it("contato anonimizado (lgpd.isAnonymized) → blocked, sem chamar runModelCall", async () => {
    mockLoadAgent.mockResolvedValue(AGENT);
    mockGetLeadContext.mockResolvedValue(
      contextResult({
        lgpd: {
          isAnonymized: true,
          isProspecting: false,
          legalBasis: { basis: null, legalBasisRef: null, consentGranted: false, dataOrigin: "whatsapp" },
        },
      }),
    );

    const result = await generateDraftReply(db, llmCfg, crmCfg, input);

    expect(result).toEqual({ ok: false, reason: "blocked" });
    expect(mockRunModelCall).not.toHaveBeenCalled();
  });

  it("erro de leitura do CRM (getLeadContext ok:false) → error, não blocked, sem chamar runModelCall", async () => {
    mockLoadAgent.mockResolvedValue(AGENT);
    mockGetLeadContext.mockResolvedValue({ ok: false, reason: "crm_unavailable" } as never);

    const result = await generateDraftReply(db, llmCfg, crmCfg, input);

    expect(result).toEqual({ ok: false, reason: "error" });
    expect(mockRunModelCall).not.toHaveBeenCalled();
  });

  it("histórico vazio (sem mensagens) → empty, sem chamar runModelCall", async () => {
    mockLoadAgent.mockResolvedValue(AGENT);
    mockGetLeadContext.mockResolvedValue(
      contextResult({
        context: {
          lead_id: input.leadId,
          contact: { name: "Rafael", phone: null, email: null, tags: [], is_blocked: false },
          conversation_id: input.conversationId,
          messages: [],
        },
      }),
    );

    const result = await generateDraftReply(db, llmCfg, crmCfg, input);

    expect(result).toEqual({ ok: false, reason: "empty" });
    expect(mockRunModelCall).not.toHaveBeenCalled();
  });

  it("result.text vazio/whitespace → empty", async () => {
    mockLoadAgent.mockResolvedValue(AGENT);
    mockGetLeadContext.mockResolvedValue(contextResult());
    mockRunModelCall.mockResolvedValue({
      result: { text: "   " },
      callId: "call-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costCents: 1,
      latencyMs: 1,
    } as never);

    const result = await generateDraftReply(db, llmCfg, crmCfg, input);

    expect(result).toEqual({ ok: false, reason: "empty" });
  });
});
