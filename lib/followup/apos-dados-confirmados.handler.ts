import type { EventHandler } from "@/lib/event-log/dispatcher";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { EVENTO_DADOS_CONFIRMADOS, iniciarAposDadosConfirmados } from "./apos-dados-confirmados";

const key = "followup-apos-dados-confirmados.v1";
export const followupAposDadosConfirmadosHandler: EventHandler = {
  key,
  naOrgParada: "pula",
  events: [EVENTO_DADOS_CONFIRMADOS],
  async handle(row) {
    try {
      const result = await iniciarAposDadosConfirmados(getRequestPool(), row);
      if (result.enrolled)
        await audit({
          action: "followup_enrollment.created",
          organizationId: row.organization_id,
          resourceType: "agent_case",
          resourceId: row.entity_id,
          metadata: { via: "case_task_delivery", event_id: row.id },
        });
      return {
        consumer_key: key,
        status: result.enrolled ? "ok" : "skipped",
        detail: result.reason,
      };
    } catch (error) {
      return {
        consumer_key: key,
        status: "error",
        detail: error instanceof Error ? error.name : "unknown",
      };
    }
  },
};
