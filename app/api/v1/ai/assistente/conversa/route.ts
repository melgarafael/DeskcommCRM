/**
 * POST /api/v1/ai/assistente/conversa — um turno de conversa com o modelo da organização, para o módulo
 * conectado do assistente (Spec 33).
 *
 * O módulo manda o histórico da conversa e recebe o texto do modelo. Quem escolhe provedor, chave,
 * modelo e teto de gasto é a organização, nos painéis do CRM (Provedores e Uso de IA): o módulo não
 * recebe segredo nenhum. A chamada passa pelo MESMO seam de toda chamada de modelo
 * (`runModelCall`): orçamento mensal conferido antes de sair byte, uso gravado em `llm_calls`.
 *
 * Sem ferramentas: o modelo só responde texto. Agir no CRM é o módulo chamando as rotas dele, cada uma
 * com a sua área, o seu papel e o seu consentimento.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import {
  LlmBudgetExceededError,
  LlmModelNotEnabledError,
  LlmProviderUnknownError,
  runModelCall,
} from "@/lib/agent-engine/edge/llm/run-model-call";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

// O nome NÃO termina em "Schema" de propósito: o contrato congelado (F6) hasheia só schemas com esse
// sufixo, e o formato desta rota é novo e vai evoluir com o assistente (declarado na Spec 33).
const corpoDaConversa = z.object({
  sistema: z.string().max(8000).optional(),
  mensagens: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(8000) }))
    .min(1)
    .max(40),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // Gasta a IA da organização: só quem administra (papel `admin`, o menor entre o da pessoa e o teto).
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_assistente",
    role: "admin",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "ai_assistente_conversa", requestId);
  if (teto) return teto;

  let corpo: z.infer<typeof corpoDaConversa>;
  try {
    const parsed = corpoDaConversa.safeParse(await req.json());
    if (!parsed.success) return fail("validation_failed", "Corpo inválido.", 422, { requestId });
    corpo = parsed.data;
  } catch {
    return fail("validation_failed", "Corpo inválido.", 422, { requestId });
  }

  try {
    const { result } = await runModelCall(getSkillsPool(), llmEdgeConfigFromEnv(env), {
      // A organização vem da linha do token, nunca do corpo.
      tenantId: authz.organizationId,
      purpose: "assistente_modulo",
      ...(corpo.sistema ? { system: corpo.sistema } : {}),
      messages: corpo.mensagens,
      maxOutputTokens: 2000,
    });
    // Gastou a IA da organização: auditoria (fire-and-forget), só com efeito e sem o texto da conversa.
    void audit({
      organizationId: authz.organizationId,
      actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
      actorApiTokenId: authz.apiTokenId ?? null,
      action: "ai.assistente_conversa",
      resourceType: "ai_assistente",
      requestId,
      metadata: {
        mensagens: corpo.mensagens.length,
        ...(authz.pessoaDoModulo ? { pessoa_id: authz.pessoaDoModulo } : {}),
      },
    });
    return ok({ disponivel: true, motivo: null, texto: result.text }, { requestId });
  } catch (err) {
    if (
      err instanceof LlmBudgetExceededError ||
      err instanceof LlmProviderUnknownError ||
      err instanceof LlmModelNotEnabledError
    ) {
      return ok({ disponivel: false, motivo: err.message, texto: null }, { requestId });
    }
    throw err;
  }
}
