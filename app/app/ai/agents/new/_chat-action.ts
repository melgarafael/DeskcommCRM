"use server";

import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { runModelCall, llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/run-model-call";
import { env } from "@/lib/env";
import { AgentSetupError, resolveSetupModel } from "@/lib/prospecting/agent-setup";
import {
  creationChatInputSchema,
  creationCapabilities,
  CREATION_CHAT_SYSTEM,
  parseCreationReply,
} from "@/lib/ai/agents/creation-chat";

/** Ação privada de preparação: auth do tenant + orçamento/usage do seam existente. */
export async function prepareAgentConversation(input: unknown) {
  const support = await requireSupportWrite();
  if (support)
    return {
      ok: false as const,
      message:
        "Seu acesso permite apenas visualizar. Peça a um administrador para configurar o agente.",
    };
  const auth = await requireRole("admin", { requestId: randomUUID(), resource: "ai_agent" });
  if (!auth.ok)
    return {
      ok: false as const,
      message: "Entre com uma sessão de administrador válida para configurar o agente.",
    };
  const parsed = creationChatInputSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false as const,
      message: "Use uma mensagem de até 3.000 caracteres e uma conversa de até 24.000 caracteres.",
    };
  const rate = await checkRateLimit(`agent-creation:${auth.org.orgId}:${auth.user.id}`, 15, 60);
  if (!rate.allowed)
    return { ok: false as const, message: "Aguarde um minuto antes de continuar a conversa." };
  try {
    const pool = getRequestPool();
    const db = await pool.connect();
    let model;
    try {
      model = await resolveSetupModel(db, auth.org.orgId);
    } finally {
      db.release();
    }
    const { result } = await runModelCall(pool, llmEdgeConfigFromEnv(env), {
      tenantId: auth.org.orgId,
      purpose: "agent_creation_chat",
      model: model.model,
      llmOverride: { provider: model.provider, credentialId: model.credential_id },
      abortSignal: AbortSignal.timeout(90_000),
      maxSteps: 1,
      maxOutputTokens: 4000,
      system: CREATION_CHAT_SYSTEM,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            rascunho: parsed.data.draft,
            catalogo: creationCapabilities.map((tool) => ({
              id: tool.name,
              nome: tool.rotulo,
              descricao: tool.explicacao,
            })),
          }),
        },
        ...parsed.data.messages,
      ],
    });
    return { ok: true as const, ...parseCreationReply(result.text ?? "", parsed.data.draft) };
  } catch (cause) {
    return {
      ok: false as const,
      message:
        cause instanceof AgentSetupError
          ? cause.message
          : "Não consegui preparar a resposta agora. Sua mensagem e a proposta foram mantidas. Tente novamente ou continue no editor; confira também a credencial e o orçamento de IA.",
    };
  }
}
