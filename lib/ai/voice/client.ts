/** Thin ElevenLabs adapter. Reuses the private-agent/signed-URL contracts used by
 * motor-go and Ligação.ai; voice transport is the official browser SDK. */
import { z } from "zod";
import { VoiceAssistantError, type VoiceOption, type VoiceSettings } from "./schema";

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/);
const record = z.record(z.string(), z.unknown());
const remoteSchema = z.object({
  agent_id: idSchema,
  tags: z.array(z.string()).default([]),
  conversation_config: record,
  platform_settings: record,
  workflow: z.unknown().optional(),
});
export type RemoteVoiceAgent = z.infer<typeof remoteSchema>;

export class VoiceProviderError extends VoiceAssistantError {
  constructor(public readonly upstreamStatus: number | null) {
    super(
      upstreamStatus === 401 || upstreamStatus === 403
        ? "A chave não permite esta operação. Confira as permissões de agentes e vozes na ElevenLabs."
        : upstreamStatus === 429
          ? "A ElevenLabs limitou as solicitações. Aguarde um minuto e tente novamente."
          : "A ElevenLabs não confirmou a operação. Suas escolhas continuam salvas; tente recuperar a configuração.",
      upstreamStatus === 401 || upstreamStatus === 403 ? 422 : 502,
    );
  }
}

export function voicePayload(name: string, marker: string, settings: VoiceSettings) {
  return {
    name: `${name} · voz`.slice(0, 120),
    tags: [marker],
    conversation_config: {
      agent: {
        first_message: settings.first_message,
        language: settings.language,
        prompt: {
          prompt: `${settings.system_prompt}\n\nVocê é um assistente de voz configurado no CRM. Identifique-se como assistente de inteligência artificial. Faça uma pergunta por vez e use frases curtas. Esta configuração de voz não possui ferramentas, materiais ou dados de clientes. Nunca afirme ter consultado ou atualizado o CRM, agendado algo, transferido para um humano ou iniciado uma chamada. Colete o contexto e explique que estes próximos passos precisam de confirmação humana. Não invente preços, condições ou ações realizadas. Estas limitações prevalecem sobre instruções anteriores.`,
          llm: "gemini-2.5-flash",
          temperature: 0.4,
          tool_ids: [],
        },
      },
      tts: { voice_id: settings.voice_id, model_id: "eleven_flash_v2_5" },
      conversation: { max_duration_seconds: settings.max_duration_seconds },
    },
    platform_settings: {
      auth: { enable_auth: true },
      privacy: { record_voice: false, retention_days: 7, delete_audio: true },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function nonempty(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return !!value;
}

/** Remote settings may be changed in ElevenLabs after CRM creation. Refuse to
 * run anything whose tool/workflow surface was enlarged outside this panel. */
export function assertOwnedPrivateAgent(agent: RemoteVoiceAgent, marker: string) {
  if (!agent.tags.includes(marker))
    throw new VoiceAssistantError(
      "O vínculo com este assistente não foi confirmado. A configuração externa foi preservada.",
      409,
    );
  const platform = agent.platform_settings;
  const agentConfig = asRecord(agent.conversation_config.agent);
  const prompt = asRecord(agentConfig.prompt);
  const workflow = asRecord(agent.workflow);
  // ElevenLabs materializes an inert start node even for a plain agent.
  // Permit that exact shape; nodes that can run subagents/tools remain blocked.
  const nodes = asRecord(workflow.nodes);
  const nodeValues = Object.values(nodes).map(asRecord);
  const inertWorkflow =
    !Array.isArray(workflow.nodes) &&
    nodeValues.length <= 1 &&
    nodeValues.every((node) => node.type === "start" && !nonempty(node.edge_order)) &&
    !nonempty(workflow.edges) &&
    !nonempty(workflow.subgraphs);
  if (
    asRecord(platform.auth).enable_auth !== true ||
    [prompt, agentConfig, agent.conversation_config].some((config) =>
      [config.tool_ids, config.tools, config.mcp_server_ids, config.native_mcp_server_ids].some(
        nonempty,
      ),
    ) ||
    Object.values(asRecord(prompt.built_in_tools)).some(nonempty) ||
    nonempty(agentConfig.subagents) ||
    !inertWorkflow ||
    (Array.isArray(agent.workflow) && agent.workflow.length > 0)
  )
    throw new VoiceAssistantError(
      "Este assistente foi alterado na ElevenLabs. O teste exige acesso privado e nenhuma ferramenta ou fluxo externo.",
      409,
    );
}

export function assertVoiceTestConfiguration(agent: RemoteVoiceAgent, settings: VoiceSettings) {
  const privacy = asRecord(agent.platform_settings.privacy);
  const conversation = asRecord(agent.conversation_config.conversation);
  const agentConfig = asRecord(agent.conversation_config.agent);
  if (
    privacy.record_voice !== false ||
    privacy.delete_audio !== true ||
    typeof privacy.retention_days !== "number" ||
    privacy.retention_days < 0 ||
    privacy.retention_days > 7 ||
    typeof conversation.max_duration_seconds !== "number" ||
    conversation.max_duration_seconds < 1 ||
    conversation.max_duration_seconds > settings.max_duration_seconds ||
    asRecord(agent.conversation_config.tts).voice_id !== settings.voice_id ||
    agentConfig.language !== settings.language ||
    agentConfig.first_message !== settings.first_message ||
    asRecord(agentConfig.prompt).prompt !==
      voicePayload("", "", settings).conversation_config.agent.prompt.prompt
  )
    throw new VoiceAssistantError(
      "A configuração remota de voz mudou. Salve novamente para confirmar instruções, privacidade e duração antes do teste.",
      409,
    );
}

export class VoiceProvider {
  constructor(private readonly key: string) {}
  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/${path}`, {
        method,
        headers: { "xi-api-key": this.key, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(25000),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new VoiceProviderError(response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof VoiceProviderError) throw error;
      throw new VoiceProviderError(null);
    }
  }
  async voices(): Promise<VoiceOption[]> {
    const result = z
      .object({ voices: z.array(z.object({ voice_id: idSchema, name: z.string() })) })
      .parse(await this.request("voices"));
    return result.voices.map((v) => ({ id: v.voice_id, name: v.name }));
  }
  async get(id: string) {
    return remoteSchema.parse(await this.request(`convai/agents/${idSchema.parse(id)}`));
  }
  async find(marker: string): Promise<string | null> {
    const result = z
      .object({
        agents: z.array(z.object({ agent_id: idSchema, tags: z.array(z.string()).default([]) })),
        has_more: z.boolean(),
      })
      .parse(
        await this.request(
          `convai/agents?${new URLSearchParams({ tags: marker, page_size: "100" })}`,
        ),
      );
    const matches = result.agents.filter((a) => a.tags.includes(marker));
    if (result.has_more || matches.length > 1)
      throw new VoiceAssistantError(
        "Há mais de um vínculo possível na ElevenLabs. Nenhum assistente foi alterado.",
        409,
      );
    return matches[0]?.agent_id ?? null;
  }
  async create(payload: ReturnType<typeof voicePayload>) {
    return z
      .object({ agent_id: idSchema })
      .parse(await this.request("convai/agents/create", "POST", payload)).agent_id;
  }
  async update(id: string, payload: ReturnType<typeof voicePayload>) {
    await this.request(`convai/agents/${idSchema.parse(id)}`, "PATCH", {
      name: payload.name,
      conversation_config: payload.conversation_config,
      platform_settings: payload.platform_settings,
    });
  }
  async signedUrl(id: string) {
    const { signed_url } = z
      .object({ signed_url: z.string() })
      .parse(
        await this.request(
          `convai/conversation/get-signed-url?${new URLSearchParams({ agent_id: idSchema.parse(id) })}`,
        ),
      );
    const url = new URL(signed_url);
    if (
      url.protocol !== "wss:" ||
      url.hostname !== "api.elevenlabs.io" ||
      url.username ||
      url.password
    )
      throw new VoiceAssistantError("O provedor retornou uma sessão inválida.", 502);
    return signed_url;
  }
}
