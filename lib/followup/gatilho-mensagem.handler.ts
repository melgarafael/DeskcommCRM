/**
 * Adapters finos que plugam `aplicaGatilhoDeMensagem` no dispatcher do
 * `event_log` — um por fase, e a ORDEM de registro é a prioridade:
 *
 *   reatividade → específicos (palavra, link, anúncio) → retorno → padrão → LLM
 *
 * O match_reply dos fluxos já vivos lê a mensagem primeiro; depois o gatilho
 * mais específico pega o slot; a resposta padrão só fala quando ninguém falou.
 * O agente só responde se `ceder-turno-ao-gatilho-de-mensagem` deixar.
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { canalDoEventoDesativado } from "@/lib/channels/desativado";
import { createSupabaseFollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { avancarFollowupsAtivosDoContato } from "@/lib/followup/aplicar-inbound";
import {
  EVENTO_DE_MENSAGEM,
  aplicaGatilhoDeMensagem,
  createSupabaseGatilhoMensagemDb,
  type FaseDoGatilhoDeMensagem,
} from "@/lib/followup/gatilho-mensagem";

export const FOLLOWUP_GATILHO_MENSAGEM_HANDLER_KEY = "followup-gatilho-mensagem.v1";
export const FOLLOWUP_RESPOSTA_PADRAO_HANDLER_KEY = "followup-resposta-padrao.v1";

async function rodar(key: string, fase: FaseDoGatilhoDeMensagem, row: EventRow): Promise<HandlerResult> {
  try {
    const admin = createAdminClient();
    // Canal desativado pelo operador não arma fluxo: o envio não sairia.
    if (await canalDoEventoDesativado(admin, row.organization_id, row.payload)) {
      return { consumer_key: key, status: "skipped", detail: "canal_desativado" };
    }
    const summary = await aplicaGatilhoDeMensagem(
      {
        db: createSupabaseGatilhoMensagemDb(admin),
        gateDb: createSupabaseFollowupGateDb(admin),
        clock: () => new Date(),
      },
      row,
      fase,
    );
    // A primeira mensagem do fluxo sai neste request, não no próximo cron.
    if (summary.enrolled > 0 && summary.contact_id) {
      await avancarFollowupsAtivosDoContato(admin, row.organization_id, summary.contact_id);
    }
    return {
      consumer_key: key,
      status: summary.matched && summary.enrolled > 0 ? "ok" : "skipped",
      detail:
        `armados=${summary.pointers_armados} casados=${summary.pointers_casados} enrolled=${summary.enrolled} ` +
        `ja_vivo=${summary.skipped_existing} origem_obsoleta=${summary.skipped_stale_origin} ` +
        `gate=${summary.pointers_barrados_pelo_gate} humano=${summary.skipped_humano} ` +
        `grupo=${summary.skipped_grupo} bloqueado=${summary.skipped_bloqueado} ` +
        `agente=${summary.skipped_agente} pausa=${summary.skipped_pausa}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { consumer_key: key, status: "error", detail };
  }
}

export const followupGatilhoMensagemHandler: EventHandler = {
  key: FOLLOWUP_GATILHO_MENSAGEM_HANDLER_KEY,
  naOrgParada: "pula",
  events: [EVENTO_DE_MENSAGEM],
  handle: (row) => rodar(FOLLOWUP_GATILHO_MENSAGEM_HANDLER_KEY, "especificos", row),
};

export const followupRespostaPadraoHandler: EventHandler = {
  key: FOLLOWUP_RESPOSTA_PADRAO_HANDLER_KEY,
  naOrgParada: "pula",
  events: [EVENTO_DE_MENSAGEM],
  handle: (row) => rodar(FOLLOWUP_RESPOSTA_PADRAO_HANDLER_KEY, "padrao", row),
};
