/**
 * Adapter fino que pluga `aplicaAvisoDeAgendamento` (`./aviso-de-agendamento.ts`)
 * no dispatcher do `event_log` — o mesmo desenho do aviso de caso
 * (`lib/escalacao/aviso-ao-suporte.handler.ts`): a regra fica pura e testável,
 * aqui só há a ligação com o registry e os clients de produção.
 *
 * ⚠️ UM HANDLER PARA OS TRÊS EVENTOS, e não três. Marcar e cancelar são o mesmo
 * laço: o cancelamento precisa achar o aviso represado do mesmo agendamento, e
 * um consumidor separado abriria a porta para o dia em que só um é registrado.
 *
 * ⚠️ O `status` NUNCA é `error` por estado de mundo. O `catch` abaixo é a única
 * fonte de `error`, e existe para defeito de PROGRAMA.
 */
import { audit } from "@/lib/audit";
import { criarPacingDoCanal } from "@/lib/agent-engine/pacing/ledger-supabase";
import { createSupabaseAvisoDb } from "@/lib/escalacao/aviso-ao-suporte";
import { criarTransporteDoAviso } from "@/lib/escalacao/aviso-ao-suporte.handler";
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { origemDoDreno } from "@/lib/event-log/origem-do-dreno";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  type AvisoDeAgendamentoDeps,
  aplicaAvisoDeAgendamento,
  createSupabaseAvisoDeAgendamentoDb,
} from "./aviso-de-agendamento";
import { ENTIDADE_DO_AGENDAMENTO } from "./tipos";
import { EVENTOS_DO_AVISO_DE_AGENDAMENTO } from "./vocabulario-do-aviso-de-agendamento";

export const AVISO_DE_AGENDAMENTO_HANDLER_KEY = "agenda-aviso-no-whatsapp.v1";

/**
 * As dependências de produção — exportadas porque o cron do resumo das 7h usa
 * o MESMO caminho de envio. Duas montagens divergiriam no primeiro campo novo.
 */
export async function criarDepsDoAvisoDeAgendamento(): Promise<Omit<AvisoDeAgendamentoDeps, "origemDoDreno">> {
  const admin = createAdminClient();
  return {
    db: createSupabaseAvisoDeAgendamentoDb(admin, createSupabaseAvisoDb(admin)),
    transporte: await criarTransporteDoAviso(admin),
    pacing: await criarPacingDoCanal(admin),
    clock: () => new Date(),
    audita: (entrada) => {
      // Fire-and-forget, como todo audit do produto.
      void audit({
        action: entrada.action,
        organizationId: entrada.organizationId,
        resourceType: ENTIDADE_DO_AGENDAMENTO,
        resourceId: entrada.resourceId,
        bypassedRls: true,
        metadata: entrada.metadata,
      });
    },
  };
}

export const avisoDeAgendamentoNoWhatsAppHandler: EventHandler = {
  key: AVISO_DE_AGENDAMENTO_HANDLER_KEY,
  naOrgParada: "pula",
  events: [...EVENTOS_DO_AVISO_DE_AGENDAMENTO],
  async handle(row): Promise<HandlerResult> {
    try {
      const desfecho = await aplicaAvisoDeAgendamento(
        { ...(await criarDepsDoAvisoDeAgendamento()), origemDoDreno },
        row,
      );
      return {
        consumer_key: AVISO_DE_AGENDAMENTO_HANDLER_KEY,
        status: desfecho.status,
        ...(desfecho.retry_at ? { retry_at: desfecho.retry_at } : {}),
        detail: desfecho.detail,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: AVISO_DE_AGENDAMENTO_HANDLER_KEY, status: "error", detail };
    }
  },
};
