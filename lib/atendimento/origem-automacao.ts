import type { ActionCtx } from "@/lib/automation/types";
import { serviceForEvent, assertServiceBoundarySupabase, type ServiceOrigin } from "./origem";
import { StaleServiceBoundaryError, type ServiceBoundary } from "./fronteira";

/** O evento conserva a origem; consumir/repetir não concede uma autorização nova. */
export async function originFromAutomationEvent(
  ctx: ActionCtx,
  contactId: string,
): Promise<ServiceOrigin | null> {
  if (typeof ctx.event.id !== "string") return null;
  // Referenciar conserva os recibos por destino já resolvidos no evento raiz.
  // Copiar command observado criaria uma segunda tentativa de begin/CAS.
  return {
    kind: "event",
    event_id: ctx.event.id,
    organization_id: ctx.organizationId,
    contact_id: contactId,
  };
}

/** Recibo do evento fixa o destino; memo privado evita leituras repetidas na mesma execução. */
export async function serviceForAutomation(
  ctx: ActionCtx,
  contactId: string,
  sessionId?: string,
): Promise<ServiceBoundary> {
  const key = `${ctx.organizationId}:${contactId}:${sessionId ?? "default"}`;
  let pending = ctx.serviceBoundaries?.get(key);
  if (!pending) {
    pending = (async () => {
      const boundary = await serviceForEvent(
        ctx.admin,
        ctx.organizationId,
        ctx.event.id,
        contactId,
        sessionId,
      );
      if (!boundary) throw new StaleServiceBoundaryError();
      return boundary;
    })();
    ctx.serviceBoundaries?.set(key, pending);
  }
  const boundary = await pending;
  if (sessionId) {
    const { data, error } = await ctx.admin
      .from("conversations")
      .select("channel_session_id")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contactId)
      .eq("id", boundary.conversation_id)
      .maybeSingle();
    if (error) throw error;
    if (data?.channel_session_id !== sessionId) throw new Error("service_channel_mismatch");
  }
  await assertServiceBoundarySupabase(ctx.admin, boundary);
  return boundary;
}
