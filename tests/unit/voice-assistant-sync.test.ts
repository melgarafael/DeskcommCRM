import { describe, expect, it, vi } from "vitest";
import { syncVoiceAssistant } from "@/lib/ai/voice/sync";
import {
  assertOwnedPrivateAgent,
  assertVoiceTestConfiguration,
  voicePayload,
  VoiceProviderError,
  type RemoteVoiceAgent,
} from "@/lib/ai/voice/client";
import { voiceActionSchema, type VoiceSettings, type VoiceState } from "@/lib/ai/voice/schema";

const settings: VoiceSettings = {
  voice_id: "voice_12345678",
  language: "pt",
  first_message: "Olá, sou uma assistente de IA.",
  system_prompt: "Entenda primeiro o problema da empresa.",
  max_duration_seconds: 300,
};
const marker = "crm-voice-11111111-1111-4111-8111-111111111111";
function remote(tag = marker): RemoteVoiceAgent {
  return { ...voicePayload("Clara", tag, settings), agent_id: "agent_12345678" };
}
function fixture(previous?: VoiceState) {
  let state: VoiceState | null = previous ?? null;
  const write = vi.fn(async (next: VoiceState) => {
    state = structuredClone(next);
  });
  const provider = {
    find: vi.fn(async () => null as string | null),
    get: vi.fn(async () => remote(state!.marker)),
    create: vi.fn(async () => "agent_12345678"),
    update: vi.fn(async () => undefined),
  };
  return { store: { write }, provider, state: () => state };
}
describe("voice agent creation recovery", () => {
  it("persists create intent before HTTP and publishes only after ownership/private verification", async () => {
    const f = fixture();
    f.provider.create.mockImplementation(async () => {
      expect(f.state()).toMatchObject({ status: "creating", remote_agent_id: null, settings });
      return "agent_12345678";
    });
    await syncVoiceAssistant(f.store, f.provider, "Clara", null, settings);
    expect(f.state()).toMatchObject({ status: "ready", remote_agent_id: "agent_12345678" });
    expect(f.provider.create).toHaveBeenCalledOnce();
    await syncVoiceAssistant(f.store, f.provider, "Clara", f.state(), settings);
    expect(f.provider.create).toHaveBeenCalledOnce();
    expect(f.provider.update).toHaveBeenCalledOnce();
  });
  it("never creates twice after an ambiguous timeout, even when reconciliation finds nothing", async () => {
    const f = fixture();
    f.provider.create.mockRejectedValue(new VoiceProviderError(null));
    await expect(
      syncVoiceAssistant(f.store, f.provider, "Clara", null, settings),
    ).rejects.toThrow();
    expect(f.state()?.status).toBe("creating");
    await expect(
      syncVoiceAssistant(f.store, f.provider, "Clara", f.state(), settings),
    ).rejects.toThrow("Não criaremos uma cópia");
    expect(f.provider.create).toHaveBeenCalledOnce();
  });
  it("recovers the provider agent created before a lost response", async () => {
    const f = fixture({
      marker,
      settings,
      status: "creating",
      remote_agent_id: null,
      updated_at: "now",
    });
    f.provider.find.mockResolvedValue("agent_12345678");
    await syncVoiceAssistant(f.store, f.provider, "Clara", f.state(), settings);
    expect(f.state()?.status).toBe("ready");
    expect(f.provider.create).not.toHaveBeenCalled();
    expect(f.provider.update).toHaveBeenCalledOnce();
  });
  it("allows a fresh attempt only after an explicit provider rejection", async () => {
    const f = fixture();
    f.provider.create.mockRejectedValueOnce(new VoiceProviderError(422));
    await expect(
      syncVoiceAssistant(f.store, f.provider, "Clara", null, settings),
    ).rejects.toThrow();
    expect(f.state()?.status).toBe("rejected");
    await syncVoiceAssistant(f.store, f.provider, "Clara", f.state(), settings);
    expect(f.provider.create).toHaveBeenCalledTimes(2);
    expect(f.state()?.status).toBe("ready");
  });
  it("refuses to patch a remote agent with another ownership marker", async () => {
    const f = fixture({
      marker,
      settings,
      status: "ready",
      remote_agent_id: "agent_12345678",
      updated_at: "now",
    });
    f.provider.get.mockResolvedValue(remote("another-tenant"));
    await expect(
      syncVoiceAssistant(f.store, f.provider, "Clara", f.state(), settings),
    ).rejects.toThrow("vínculo");
    expect(f.provider.update).not.toHaveBeenCalled();
    expect(f.store.write).not.toHaveBeenCalled();
  });
});
describe("private tool-free browser voice", () => {
  it.each(["tool_ids", "tools", "mcp_server_ids", "native_mcp_server_ids"])(
    "refuses remote %s added outside the CRM",
    (key) => {
      const agent = remote();
      agent.conversation_config.agent = { prompt: { [key]: ["external"] } };
      expect(() => assertOwnedPrivateAgent(agent, marker)).toThrow("nenhuma ferramenta");
    },
  );
  it.each([
    { nodes: [{ id: "external" }] },
    { nodes: { external: {} } },
    { edges: [{ id: "external" }] },
  ])("refuses external workflow %j", (workflow) => {
    expect(() => assertOwnedPrivateAgent({ ...remote(), workflow }, marker)).toThrow();
  });
  it("refuses public agents", () => {
    expect(() =>
      assertOwnedPrivateAgent(
        { ...remote(), platform_settings: { auth: { enable_auth: false } } },
        marker,
      ),
    ).toThrow();
  });
  it("allows the provider's inert default start node and null built-in tools", () => {
    const agent = remote();
    agent.workflow = {
      nodes: { start_node: { type: "start", edge_order: [] } },
      edges: {},
      subgraphs: {},
    };
    expect(() => assertOwnedPrivateAgent(agent, marker)).not.toThrow();
  });
  it.each([
    { record_voice: true, delete_audio: true, retention_days: 7 },
    { record_voice: false, delete_audio: false, retention_days: 7 },
    { record_voice: false, delete_audio: true, retention_days: -1 },
    { record_voice: false, delete_audio: true, retention_days: 30 },
  ])("refuses privacy drift before issuing a test session: %j", (privacy) => {
    const agent = remote();
    agent.platform_settings.privacy = privacy;
    expect(() => assertVoiceTestConfiguration(agent, settings)).toThrow("privacidade");
  });
  it("refuses remote duration and prompt drift", () => {
    const agent = remote();
    agent.conversation_config.conversation = { max_duration_seconds: 3600 };
    expect(() => assertVoiceTestConfiguration(agent, settings)).toThrow();
    const changedPrompt = remote();
    changedPrompt.conversation_config.agent = { prompt: { prompt: "pretend you have tools" } };
    expect(() => assertVoiceTestConfiguration(changedPrompt, settings)).toThrow();
  });
  it("rejects caller-supplied remote IDs and excessive duration", () => {
    expect(voiceActionSchema.safeParse({ action: "test", agent_id: "someone-else" }).success).toBe(
      false,
    );
    expect(
      voiceActionSchema.safeParse({
        action: "configure",
        settings: { ...settings, max_duration_seconds: 3600 },
      }).success,
    ).toBe(false);
  });
  it("creates private agents with no tools and a truthful voice-only prompt", () => {
    const payload = voicePayload("Clara", marker, settings);
    expect(payload.platform_settings.auth).toEqual({ enable_auth: true });
    expect(payload.platform_settings.privacy).toMatchObject({
      record_voice: false,
      retention_days: 7,
    });
    expect(payload.conversation_config.agent.prompt.tool_ids).toEqual([]);
    expect(payload.conversation_config.agent.prompt.prompt).toContain("confirmação humana");
    expect(payload.conversation_config.agent.prompt.prompt).toContain(settings.system_prompt);
  });
});
