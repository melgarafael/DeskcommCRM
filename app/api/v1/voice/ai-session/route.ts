import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createOpenAiRealtimeRuntimeSession } from "@/lib/ai/voice/store";
import { VoiceAssistantError } from "@/lib/ai/voice/schema";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ conversationId: z.string().uuid() });

/**
 * Prepara a sessão privada do agente que já está aderido à conversa.
 * Não inicia a chamada. Assim o navegador confirma o motor antes de fazer o
 * telefone do cliente tocar.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "voice_calls" });
  if (!auth.ok) return auth.response;

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return fail("invalid_body", "Conversa inválida.", 400, { requestId });
  }

  const supabase = await createClient();
  const { data: conversation, error } = await supabase
    .from("conversations")
    .select("id, contact_id, active_ai_agent_id")
    .eq("organization_id", auth.org.orgId)
    .eq("id", body.data.conversationId)
    .maybeSingle();

  if (error) {
    return fail("voice_ai_unavailable", "Não foi possível preparar a ligação com IA.", 500, {
      requestId,
    });
  }
  if (!conversation) return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  const pool = getRequestPool();
  const { rows: readyAgents } = await pool.query<{ id: string }>(
    `select id from ai_agents
     where organization_id=$1 and archived_at is null
       and config->'voice_assistant'->>'status'='ready'
     order by updated_at desc limit 2`,
    [auth.org.orgId],
  );
  const selectedAgent =
    readyAgents.find((agent) => agent.id === conversation.active_ai_agent_id)?.id ??
    (readyAgents.length === 1 ? readyAgents[0]?.id : null);
  if (!selectedAgent) {
    return fail(
      "voice_agent_not_selected",
      readyAgents.length > 1
        ? "Escolha qual funcionário de voz atende esta conversa antes de ligar."
        : "Nenhum funcionário tem a voz pronta para ligações.",
      409,
      { requestId },
    );
  }

  try {
    const safetyIdentifier = createHash("sha256")
      .update(`${auth.org.orgId}:${auth.user.id}`)
      .digest("hex");
    const session = await createOpenAiRealtimeRuntimeSession(
      pool,
      auth.org.orgId,
      selectedAgent,
      safetyIdentifier,
    );
    return ok(
      {
        ...session,
        contact_id: conversation.contact_id,
        agent_id: selectedAgent,
      },
      { requestId },
    );
  } catch (cause) {
    return fail(
      "voice_ai_unavailable",
      cause instanceof VoiceAssistantError
        ? cause.message
        : "Não foi possível preparar o funcionário de voz.",
      cause instanceof VoiceAssistantError ? cause.status : 502,
      { requestId },
    );
  }
}
