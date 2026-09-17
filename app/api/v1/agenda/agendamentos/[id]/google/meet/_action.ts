import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { googleRpc } from "@/lib/agenda/google/sync-store";
import { ok, fail } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";

export async function meetingAction(
  req: Request,
  context: { params: Promise<{ id: string }> },
  action: "retry" | "deliver",
) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "agenda" });
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const parsed = z
    .object({
      revision: z.string().regex(/^\d+$/),
      request_id: z.uuid().nullable(),
      conversation_id: z.uuid().optional(),
    })
    .strict()
    .safeParse(await req.json().catch(() => null));
  if (
    !z.uuid().safeParse(id).success ||
    !parsed.success ||
    (action === "deliver" && !parsed.data.conversation_id)
  )
    return fail(
      "validation_failed",
      "Atualize o compromisso e escolha a conversa de destino.",
      422,
      { requestId },
    );
  try {
    const changed = await googleRpc(await createClient(), "fn_meet_action", {
      p_org: auth.org.orgId,
      p_id: id,
      p_revision: parsed.data.revision,
      p_request: parsed.data.request_id,
      p_action: action,
      p_conversation: parsed.data.conversation_id ?? null,
    });
    if (changed)
      await audit({
        action: "agenda.meet_action_requested",
        organizationId: auth.org.orgId,
        actorUserId: auth.user.id,
        resourceType: "calendar_appointment",
        resourceId: id,
        requestId,
        metadata: { action },
      });
    return ok({ pending: true, changed: Boolean(changed) }, { requestId });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    // ⛔ 55P03 = `lock_not_available`: a migration 0241 pôs `lock_timeout='4s'`
    // em `fn_meet_action`, e este é o caminho que ela abriu.
    //
    // ANTES DELA a espera era infinita, e o desfecho era pior do que um erro:
    // o cliente HTTP desiste aos 10s (`DEFAULT_TIMEOUT_MS`), a pessoa lia "Erro
    // inesperado. Tente novamente." — sem identificador, porque o erro vinha do
    // NAVEGADOR e não daqui —, **a consulta continuava viva** segurando a fila,
    // e o clique seguinte empilhava atrás. Medido em produção em 2026-09-12:
    // dez chamadas simultâneas, Postgres a 357% de CPU.
    //
    // A frase diz o que fazer e quanto esperar. "Tente novamente" sozinho
    // convida ao clique imediato, que é exatamente o gesto que empilhava.
    if (code === "55P03")
      return fail(
        "conflict",
        "Este atendimento está ocupado neste instante. Aguarde alguns segundos e tente de novo.",
        409,
        { requestId },
      );
    if (code === "40001") return fail("conflict", "O compromisso ou atendimento mudou. Atualize e tente novamente.", 409, { requestId });
    if (code === "42501") return fail("forbidden", "Esta ação exige o responsável pelo compromisso e uma conversa disponível.", 403, { requestId });
    logger.error("agenda.meet_action_failed", { requestId, action, code: "internal_error" });
    return fail("internal_error", "Não foi possível registrar a ação. Atualize e tente novamente em instantes.", 500, { requestId });
  }
}
