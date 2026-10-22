/**
 * Os gatilhos de entrada por mensagem (palavra-chave, link/QR, anúncio) rodam
 * DENTRO do webhook, ANTES de o turno do agente ser pedido.
 *
 * Por que não basta o silenciador do drain (`ceder-turno-ao-gatilho-de-mensagem.ts`):
 * o drain do agente roda no `worker`, e uma instalação pode ter o worker numa
 * versão diferente do app (o fork constrói o app; o worker vem do registry).
 * Decidir aqui, no app, garante UMA VOZ sem depender da versão do worker — e o
 * silenciador continua lá como segunda porta, para a ordem inversa.
 *
 * Devolve `true` quando ESTA mensagem inscreveu o contato num fluxo: quem chama
 * pula o despacho do agente. Falha para dentro, devolvendo `false` — na dúvida
 * o agente é chamado, e o silenciador do drain ainda decide.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { drainEventLog } from "@/lib/event-log/drain";
import { comOrigemDeRequest } from "@/lib/event-log/origem-do-dreno";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { logger } from "@/lib/logger";
import { EVENTO_DO_ENROLLMENT_POR_MENSAGEM } from "./gatilho-mensagem";
import { FOLLOWUP_GATILHO_MENSAGEM_HANDLER_KEY } from "./gatilho-mensagem.handler";

export async function dispararGatilhosDeMensagem(
  admin: SupabaseClient,
  inbound: { organizationId: string; contactId: string; messageId: string | null },
): Promise<boolean> {
  if (!inbound.messageId) return false;
  try {
    // O caso comum — nenhum fluxo com gatilho de mensagem — custa uma contagem.
    const { count, error } = await admin
      .from("followup_flow_pointers")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", inbound.organizationId)
      .eq("status", "active")
      .in("trigger_config->>kind", ["keyword", "ref_link", "ad_click"]);
    if (error || !count) return false;

    ensureHandlersRegistered();
    await comOrigemDeRequest(() =>
      drainEventLog(admin, {
        limit: 10,
        escopo: { organizationId: inbound.organizationId, handlers: [FOLLOWUP_GATILHO_MENSAGEM_HANDLER_KEY] },
      }),
    );

    const { data } = await admin
      .from("followup_enrollment_events")
      .select("id")
      .eq("organization_id", inbound.organizationId)
      .eq("event_type", EVENTO_DO_ENROLLMENT_POR_MENSAGEM)
      .eq("payload->>message_id", inbound.messageId)
      .limit(1);
    return (data?.length ?? 0) > 0;
  } catch (err) {
    logger.warn("[gatilho-mensagem] disparo no request falhou — o agente decide", {
      organization_id: inbound.organizationId,
      error: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
    });
    return false;
  }
}
