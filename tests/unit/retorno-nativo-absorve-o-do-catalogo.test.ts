import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_DEFS,
  defDoRetornoNativo,
  SCHEDULE_FOLLOWUP_COM_NEGOCIO,
} from "@/lib/agent-engine/agent/inbound-turn";
import { esquemaParaOProvedor } from "@/lib/agent-engine/edge/llm/stable-prefix";

/**
 * `crm_schedule_followup` sai do turno quando o retorno nativo está nele
 * (`COBERTA_PELA_NATIVA`). Antes do corte, a nativa recebe o que só a do
 * catálogo tinha — e só para quem a tinha ligada:
 *  - a escolha do negócio (`lead_id`);
 *  - a frase que separa retorno de compromisso com hora marcada.
 * Quem nunca a teve fica com a base, sem os tokens a mais.
 */

type Propriedades = { properties: Record<string, Record<string, unknown>> };

describe("o retorno nativo de quem tinha a do catálogo", () => {
  it("⭐ com crm_schedule_followup ligada, a nativa leva a frase de compromisso e o lead_id", async () => {
    const def = defDoRetornoNativo(["crm_list_tags", "crm_schedule_followup"]);
    expect(def).toBe(SCHEDULE_FOLLOWUP_COM_NEGOCIO);
    expect(def.description).toContain("NÃO é compromisso");
    expect(def.description).toContain("ferramenta de marcar compromisso");
    expect(def.description).toContain("alguém da equipe confirma");
    expect(def.description).toContain("NÃO registre");
    const esquema = (await esquemaParaOProvedor(def.inputSchema, {
      semPadrao: false,
    })) as Propriedades;
    expect(esquema.properties).toHaveProperty("lead_id");
    // `z.string()` sem `.uuid()`: o campo novo não traz regex nenhum ao fio.
    expect(esquema.properties.lead_id).not.toHaveProperty("pattern");
  });

  it("a variante começa pela base: nada do que a nativa dizia se perde", () => {
    expect(SCHEDULE_FOLLOWUP_COM_NEGOCIO.description.startsWith(AGENT_TOOL_DEFS.schedule_followup.description)).toBe(
      true,
    );
  });

  it.each([[[]], [["crm_list_tags"]]])("sem a do catálogo (%j), a base, sem lead_id", async (ids) => {
    const def = defDoRetornoNativo(ids);
    expect(def).toBe(AGENT_TOOL_DEFS.schedule_followup);
    const esquema = (await esquemaParaOProvedor(def.inputSchema, {
      semPadrao: false,
    })) as Propriedades;
    expect(esquema.properties).not.toHaveProperty("lead_id");
  });
});
