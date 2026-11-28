import { createAdminClient } from "@/lib/supabase/admin";
import type { EventHandler } from "@/lib/event-log/dispatcher";
import { canalDoEventoDesativado } from "@/lib/channels/desativado";
import { AUTOMATION_CONSUMER_KEY, runAutomationForEvent } from "@/lib/automation/engine";
import { EVENTOS_DOS_GATILHOS } from "@/lib/schemas/webhooks";
// Importa os executores para que se registrem (side-effect imports — Tasks 9-11):
import "@/lib/automation/actions/register-all";

export const automationRulesHandler: EventHandler = {
  key: AUTOMATION_CONSUMER_KEY,
  naOrgParada: "pula",
  // Assina EXATAMENTE o que a tela deixa escolher (`EVENTOS_DOS_GATILHOS`, hoje
  // a mesma lista de `TRIGGER_EVENTS`). Enquanto esta lista era escrita à mão ao
  // lado de `TRIGGER_EVENTS`, um gatilho novo podia existir no seletor e não
  // chegar aqui — e aí a regra é salva, o evento acontece e nada roda, sem erro
  // nem log. Os gatilhos de caso (#4900) assinam `ai.case_*`, o mesmo nome que a
  // regra grava.
  events: [...EVENTOS_DOS_GATILHOS],
  async handle(row) {
    const admin = createAdminClient();
    // Canal DESATIVADO (#2329) — o vazamento DE VERDADE desta issue: uma regra
    // com gatilho `message.received` disparava um webhook HTTP de SAÍDA para
    // fora com mensagem de um canal que o operador desligou. A guarda vai ANTES
    // do motor, porque é lá que a regra casa e o `fetch` sai.
    if (await canalDoEventoDesativado(admin, row.organization_id, row.payload)) {
      return {
        consumer_key: AUTOMATION_CONSUMER_KEY,
        status: "skipped",
        detail: "canal_desativado",
      };
    }
    return runAutomationForEvent(admin, row);
  },
};
