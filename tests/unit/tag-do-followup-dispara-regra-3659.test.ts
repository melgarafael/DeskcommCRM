/**
 * #3659 — a etiqueta que o nó `edit_lead_tag` de um follow-up aplica tem de
 * chegar às regras `lead.tag_added` / `contact.tag_added`.
 *
 * O nó reusa a ação `add_tag` do motor de automação. Antes, ele passava
 * `ruleId: "followup:<enrollment>"`, a ação gravava esse id em
 * `metadata.caused_by_rule`, e o anti-laço de `runAutomationForEvent`
 * descartava o evento como se fosse regra disparando regra.
 *
 * Os dois lados são medidos aqui, com o MESMO motor:
 *  - o evento do follow-up passa pelo anti-laço (chega a buscar regras);
 *  - o evento de uma REGRA continua barrado (o anti-laço regra → regra segue).
 *
 * Laço regra → follow-up → tag → regra: não é infinito. A `add_tag` não emite
 * evento quando nada entrou (etiqueta já presente), e a inscrição viva no mesmo
 * fluxo recusa outra (23505 em `start_message_flow`). É a mesma classe do nó
 * `move_lead`, cujo `lead.stage_changed` já dispara regras.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/atendimento/origem-automacao", () => ({
  originFromAutomationEvent: vi.fn(async () => null),
}));

import { createSupabaseAdminClient } from "@/lib/followup/engine";
import { getAction } from "@/lib/automation/actions";
import { runAutomationForEvent } from "@/lib/automation/engine";
import type { ActionCtx } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import type { SupabaseClient } from "@supabase/supabase-js";

const ORG = "org-1";
const LEAD = { id: "lead-1", organization_id: ORG, contact_id: "c-1", tags: [] as string[] };

/** Consulta encadeável que devolve `resultado` no fim (maybeSingle ou await). */
function consulta(resultado: { data: unknown; error: null }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "in", "neq"]) q[m] = () => q;
  q.maybeSingle = async () => resultado;
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve(resultado).then(ok);
  return q;
}

/** Banco de mentira: serve o lead ao follow-up, a junção de etiquetas da 0682,
 *  e guarda o `emit_event`. Ao motor, devolve "nenhuma regra ativa". */
function banco() {
  const eventos: Array<Record<string, unknown>> = [];
  const regrasConsultadas: string[] = [];
  const admin = {
    from(tabela: string) {
      if (tabela === "crm_leads") return consulta({ data: LEAD, error: null });
      if (tabela === "automation_rules") {
        regrasConsultadas.push(tabela);
        return consulta({ data: [], error: null });
      }
      return consulta({ data: null, error: null });
    },
    async rpc(nome: string, args: Record<string, unknown>) {
      if (nome === "emit_event") {
        eventos.push(args);
        return { data: null, error: null };
      }
      if (nome === "fn_lead_adicionar_etiquetas") {
        return { data: { tags: args.p_etiquetas, adicionadas: args.p_etiquetas }, error: null };
      }
      throw new Error(`banco de mentira: rpc desconhecida ${nome}`);
    },
  };
  return { admin: admin as unknown as SupabaseClient, eventos, regrasConsultadas };
}

/** A linha que o `emit_event` gravaria no `event_log`. */
function linha(args: Record<string, unknown>): EventRow {
  return {
    id: "ev-1",
    organization_id: ORG,
    event_type: String(args.p_event_type),
    entity_kind: String(args.p_entity_kind),
    entity_id: String(args.p_entity_id),
    payload: args.p_payload as Record<string, unknown>,
    metadata: args.p_metadata as Record<string, unknown>,
  } as unknown as EventRow;
}

describe("#3659 — tag aplicada pelo follow-up alimenta as regras de tag", () => {
  it("⭐ o evento do nó edit_lead_tag não carrega caused_by_rule e passa pelo anti-laço", async () => {
    const { admin, eventos, regrasConsultadas } = banco();
    await createSupabaseAdminClient(admin).editarTagDoLead!({
      organization_id: ORG,
      contact_id: "c-1",
      enrollment_id: "enr-1",
      config: { tags: ["nps-detrator"] } as never,
    });

    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.p_event_type).toBe("lead.tag_added");
    expect(eventos[0]!.p_metadata).not.toHaveProperty("caused_by_rule");

    const r = await runAutomationForEvent(admin, linha(eventos[0]!));
    expect(r.detail).not.toBe("caused_by_rule");
    expect(r.detail).toBe("no_rules");
    expect(regrasConsultadas).toHaveLength(1);
  });

  it("controle: a mesma add_tag chamada por uma REGRA segue barrada pelo anti-laço", async () => {
    const { admin, eventos, regrasConsultadas } = banco();
    await getAction("add_tag")!.execute(
      {
        admin,
        organizationId: ORG,
        ruleId: "regra-1",
        ruleName: "regra-1",
        event: { id: "ev-0" } as EventRow,
        requestId: "ev-0",
        context: { lead: { ...LEAD } },
      } as ActionCtx,
      { tags: ["nps-detrator"] },
    );

    expect(eventos[0]!.p_metadata).toEqual({ caused_by_rule: "regra-1" });
    const r = await runAutomationForEvent(admin, linha(eventos[0]!));
    expect(r).toMatchObject({ status: "skipped", detail: "caused_by_rule" });
    expect(regrasConsultadas).toHaveLength(0);
  });
});
