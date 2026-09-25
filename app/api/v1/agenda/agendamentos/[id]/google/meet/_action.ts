import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { googleRpc } from "@/lib/agenda/google/sync-store";
import { ok, fail } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { motivoDoMeet, semSegredos } from "@/lib/agenda/motivo-do-meet";
import { traduzir } from "@/lib/i18n/dicionario";
import { audit } from "@/lib/audit";

export async function meetingAction(
  req: Request,
  context: { params: Promise<{ id: string }> },
  action: "retry" | "deliver" | "resend",
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
    // `resend` exige a conversa igual ao `deliver`: a entrega tem destino, e
    // quem reenvia escolhe para onde. Só o `retry` (refazer o link no Google)
    // não tem conversa nenhuma envolvida.
    (action !== "retry" && !parsed.data.conversation_id)
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
    // O MOTIVO REAL, derivado do que a função escolheu DIZER.
    //
    // A versão anterior reconhecia três SQLSTATE e mandava o resto para 500 —
    // e 500 é status de "tente de novo", então o cliente HTTP repetia. Medido
    // numa instalação real em 2026-09-12: "Enviar link ao cliente" ficava 20
    // segundos parado e terminava em "Erro inesperado. Tente novamente.". Os
    // 20 segundos eram as três tentativas de um pedido que o banco já tinha
    // recusado, com nome próprio (`meet_conversation_stale`), no primeiro
    // milissegundo.
    const motivo = motivoDoMeet(error);
    // ⛔ A MENSAGEM CRUA NUNCA ENTRA NO REGISTRO — ela pode carregar o LINK da
    // reunião. Mas apagá-la inteira também custou caro: um erro real chegou
    // aqui sem nome e sem SQLSTATE, e o registro guardou apenas
    // `code: "internal_error"`. `semSegredos` tira os endereços, que é onde o
    // segredo mora, e deixa a frase, que é onde mora o diagnóstico.
    logger.error("agenda.meet_action_failed", {
      requestId,
      action,
      code: motivo.codigo,
      sqlstate:
        error && typeof error === "object" && "code" in error && error.code !== undefined
          ? String(error.code)
          : null,
      mensagem: semSegredos(error instanceof Error ? error.message : null),
    });
    return fail(motivo.codigo, traduzir(motivo.texto, auth.user.idioma), motivo.status, {
      requestId,
    });
  }
}
