import { createAdminClient } from "@/lib/supabase/admin";
import type { EventHandler } from "@/lib/event-log/dispatcher";
import { AUTOMATION_CONSUMER_KEY, runAutomationForEvent } from "@/lib/automation/engine";
import { TRIGGER_EVENTS } from "@/lib/schemas/webhooks";
// Importa os executores para que se registrem (side-effect imports — Tasks 9-11):
import "@/lib/automation/actions/register-all";

export const automationRulesHandler: EventHandler = {
  key: AUTOMATION_CONSUMER_KEY,
  // Assina EXATAMENTE o que a tela deixa escolher. Enquanto esta lista era
  // escrita à mão ao lado de `TRIGGER_EVENTS`, um gatilho novo podia existir no
  // seletor e não chegar aqui — e aí a regra é salva, o evento acontece e nada
  // roda, sem erro nem log.
  events: [...TRIGGER_EVENTS],
  async handle(row) {
    return runAutomationForEvent(createAdminClient(), row);
  },
};
