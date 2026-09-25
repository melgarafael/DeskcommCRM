import { describe, expect, it } from "vitest";

import { SCENARIO_READS } from "@/lib/agent-engine/agent/preview";
import { allTools } from "@/lib/mcp/tools";

describe("segurança da prévia: leituras de cenário não podem virar escrita", () => {
  it("toda leitura de cenário existe e continua sendo uma ferramenta read-only", () => {
    const catalogo = new Map(allTools.map((tool) => [tool.name, tool]));

    for (const nome of SCENARIO_READS) {
      const ferramenta = catalogo.get(nome);
      expect(ferramenta, `SCENARIO_READS contém ferramenta inexistente: ${nome}`).toBeDefined();
      expect(ferramenta?.category, `${nome} não pode ganhar efeito de escrita na prévia`).toBe("read");
    }
  });

  it("a cadeia da agenda começa pela ferramenta registrada de tipos de atendimento", () => {
    expect(SCENARIO_READS.has("crm_list_event_types")).toBe(true);
    expect(SCENARIO_READS.has("crm_list_appointment_types")).toBe(false);
  });

  it("permite leitura e catálogo de dados externos no modo teste", () => {
    expect(SCENARIO_READS.has("crm_describe_external_data")).toBe(true);
    expect(SCENARIO_READS.has("crm_query_external_data")).toBe(true);
  });

  it("consulta catálogo e acervo da organização no modo teste, sem contato", () => {
    // O dado é da organização, não de um contato: sem isto o Testar responde
    // "vou confirmar e te retorno" para qualquer pergunta de preço ou agenda.
    expect(SCENARIO_READS.has("crm_search_products")).toBe(true);
    expect(SCENARIO_READS.has("crm_search_knowledge")).toBe(true);
  });

  it("dado de contato continua exigindo contato real no modo teste", () => {
    expect(SCENARIO_READS.has("crm_get_contact")).toBe(false);
    expect(SCENARIO_READS.has("crm_search_contacts")).toBe(false);
    expect(SCENARIO_READS.has("crm_get_lead")).toBe(false);
    expect(SCENARIO_READS.has("crm_list_leads")).toBe(false);
  });
});
