import type { FlexibleSchema } from "ai";
import type { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_DEFS,
  SCHEDULE_FOLLOWUP_COM_NEGOCIO,
} from "@/lib/agent-engine/agent/inbound-turn";
import { esquemaParaOProvedor } from "@/lib/agent-engine/edge/llm/stable-prefix";
import { shapeToZodObject } from "@/lib/ai/runtime/tools";
import { allTools } from "@/lib/mcp/tools";
import { COBERTA_PELA_NATIVA } from "@/lib/mcp/tools/ferramentas-do-harness";

/**
 * Uma ferramenta que sai do turno (`COBERTA_PELA_NATIVA`) não pode continuar
 * sendo CITADA pelo nome na descrição de outra: o modelo lê "a ferramenta é
 * `crm_schedule_followup`", chama uma ferramenta ausente, e a chamada vira
 * tool-call inválida — recuperável, mas gasta um passo, e é o modo de falha que
 * o turno inteiro combate. A citação vira o CONCEITO ("a de agendar retorno"),
 * que também serve a quem integra pelo MCP externo.
 *
 * Varre TODA descrição e todo `.describe` aninhado (o esquema como vai ao fio),
 * e não uma lista de ferramentas: a terceira citação foi achada fora da lista
 * (`crm_list_at_risk_leads`), e a quarta não pode nascer fora da cerca.
 */

const FERRAMENTAS: ReadonlyArray<{
  nome: string;
  description: string;
  schema: FlexibleSchema<unknown>;
}> = [
  ...allTools.map((t) => ({
    nome: t.name,
    description: t.description,
    schema: shapeToZodObject(t.inputSchema as Record<string, z.ZodTypeAny>),
  })),
  ...Object.entries(AGENT_TOOL_DEFS).map(([nome, d]) => ({
    nome,
    description: d.description,
    schema: d.inputSchema,
  })),
  {
    nome: "schedule_followup",
    description: SCHEDULE_FOLLOWUP_COM_NEGOCIO.description,
    schema: SCHEDULE_FOLLOWUP_COM_NEGOCIO.inputSchema,
  },
];

describe("nenhuma ferramenta cita pelo nome uma que sai do turno", () => {
  it("guarda de vacuidade: a varredura alcança o catálogo e as nativas", () => {
    expect(allTools.length).toBeGreaterThan(50);
    expect(FERRAMENTAS.map((f) => f.nome)).toContain("crm_book_appointment");
    expect(FERRAMENTAS.map((f) => f.nome)).toContain("crm_list_at_risk_leads");
    expect(FERRAMENTAS.map((f) => f.nome)).toContain("send_message");
  });

  it("⭐ descrição e .describe não nomeiam ferramenta coberta pela nativa", async () => {
    const citacoes: string[] = [];
    for (const f of FERRAMENTAS) {
      const texto = JSON.stringify({
        description: f.description,
        schema: await esquemaParaOProvedor(f.schema, { semPadrao: false }),
      });
      for (const coberta of Object.keys(COBERTA_PELA_NATIVA)) {
        if (coberta !== f.nome && texto.includes(coberta)) citacoes.push(`${f.nome} → ${coberta}`);
      }
    }
    expect(citacoes, "troque o nome pelo conceito (ex.: 'a ferramenta de agendar retorno')").toEqual([]);
  });
});
