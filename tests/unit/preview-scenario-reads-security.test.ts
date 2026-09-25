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
});
