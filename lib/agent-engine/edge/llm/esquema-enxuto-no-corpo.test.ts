import { createAnthropic } from "@ai-sdk/anthropic";
import { asSchema, generateText, tool, type FlexibleSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { llmEdgeConfigFromEnv } from "./credentials";
import { buildStablePrefix, ESQUEMA_SEM_PADRAO_PADRAO, esquemaParaOProvedor } from "./stable-prefix";

/**
 * O peso das ferramentas não estava no texto: estava no que o zod v4 gera
 * sozinho. Cada `.uuid()`/`.datetime()`/`.email()` sai com `format` E um
 * `pattern` (regex de 95 a 190 tokens) que só repete o `format`, e cada
 * ferramenta leva um `$schema` de ~15 tokens. Medido no catálogo: 9.499 de
 * 30.518 tokens.
 *
 * O conserto mora no seam (`buildStablePrefix`): `$schema` sai sempre;
 * `pattern` sai, quando há `format`, só com o knob LLM_TOOL_SCHEMA_SEM_PADRAO.
 * Este arquivo mede o CORPO que sai para a Anthropic, sem rede — o que o
 * projeto devolve não basta, porque o provedor converte o esquema de novo.
 */

const RESPOSTA = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const ESQUEMA = z.object({
  id: z.string().uuid(),
  quando: z.string().datetime({ offset: true }),
  email: z.string().email(),
  dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Campos CHAMADOS pattern e format: nome de campo nunca é filtrado.
  pattern: z.string(),
  format: z.string(),
});

function prefixo(esquemaSemPadrao?: boolean) {
  return buildStablePrefix({
    system: "Você é o atendente da loja.",
    tools: {
      b_marcar: tool({ description: "marca", inputSchema: ESQUEMA }),
      a_preco: tool({ description: "preço", inputSchema: z.object({}) }),
    },
    cacheTtl: "1h",
    ...(esquemaSemPadrao === undefined ? {} : { esquemaSemPadrao }),
  });
}

type EsquemaNoFio = {
  $schema?: unknown;
  properties: Record<string, Record<string, unknown>>;
};

async function esquemasNoCorpo(esquemaSemPadrao?: boolean): Promise<Record<string, EsquemaNoFio>> {
  let corpo: { tools?: Array<{ name: string; input_schema: EsquemaNoFio }> } = {};
  const model = createAnthropic({
    apiKey: "chave-falsa-do-teste",
    fetch: async (_url, init) => {
      corpo = JSON.parse(String(init?.body)) as typeof corpo;
      return new Response(JSON.stringify({ ...RESPOSTA, model: "claude-sonnet-5" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  })("claude-sonnet-5");
  const p = prefixo(esquemaSemPadrao);
  await generateText({
    model,
    system: p.system,
    messages: [{ role: "user", content: "oi" }],
    tools: p.tools,
    maxOutputTokens: 64,
  });
  return Object.fromEntries((corpo.tools ?? []).map((t) => [t.name, t.input_schema]));
}

describe("o esquema que sai no corpo do pedido", () => {
  it.each([false, true])("⭐ sem `$schema` em nenhuma ferramenta (knob=%s)", async (semPadrao) => {
    const esquemas = await esquemasNoCorpo(semPadrao);
    expect(Object.keys(esquemas).sort()).toEqual(["a_preco", "b_marcar"]);
    for (const e of Object.values(esquemas)) expect(e).not.toHaveProperty("$schema");
  });

  it("⭐ knob ligado: id, data e e-mail ficam com `format` e sem `pattern`", async () => {
    const { b_marcar } = await esquemasNoCorpo(true);
    for (const campo of ["id", "quando", "email"]) {
      expect(b_marcar!.properties[campo], campo).toHaveProperty("format");
      expect(b_marcar!.properties[campo], campo).not.toHaveProperty("pattern");
    }
  });

  it("knob ligado: `pattern` sem `format` (um regex de verdade) fica", async () => {
    const { b_marcar } = await esquemasNoCorpo(true);
    expect(b_marcar!.properties.dia).toHaveProperty("pattern");
    expect(b_marcar!.properties.dia).not.toHaveProperty("format");
  });

  it("os campos chamados `pattern` e `format` continuam nas properties", async () => {
    for (const semPadrao of [false, true]) {
      const { b_marcar } = await esquemasNoCorpo(semPadrao);
      expect(Object.keys(b_marcar!.properties).sort()).toEqual(
        ["dia", "email", "format", "id", "pattern", "quando"],
      );
    }
  });

  it("knob desligado: o `pattern` do id continua — o comportamento de antes", async () => {
    const { b_marcar } = await esquemasNoCorpo(false);
    expect(b_marcar!.properties.id).toHaveProperty("pattern");
    expect(b_marcar!.properties.id).toHaveProperty("format", "uuid");
  });

  it("opção ausente vale o default único (ESQUEMA_SEM_PADRAO_PADRAO)", async () => {
    const { b_marcar } = await esquemasNoCorpo(undefined);
    expect("pattern" in b_marcar!.properties.id!).toBe(!ESQUEMA_SEM_PADRAO_PADRAO);
  });
});

describe("a validação continua sendo a do zod", () => {
  it.each([false, true])("id que não é uuid é recusado (knob=%s)", async (semPadrao) => {
    const tools = prefixo(semPadrao).tools!;
    const validar = asSchema(tools.b_marcar!.inputSchema).validate!;
    const valido = {
      id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
      quando: "2026-10-31T10:00:00-03:00",
      email: "cliente@exemplo.com",
      dia: "2026-10-31",
      pattern: "x",
      format: "y",
    };
    expect((await validar(valido)).success).toBe(true);
    expect((await validar({ ...valido, id: "nao-e-uuid" })).success).toBe(false);
  });
});

describe("o breakpoint de cache não mudou de lugar", () => {
  it("cacheControl só na última ferramenta da ordem", () => {
    const tools = prefixo(true).tools!;
    expect(Object.keys(tools)).toEqual(["a_preco", "b_marcar"]);
    expect(tools.a_preco!.providerOptions).toBeUndefined();
    expect(tools.b_marcar!.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
  });
});

/**
 * Knob desligado = o esquema de hoje. A única diferença permitida é o `$schema`
 * da raiz (meta-anotação, sai sempre). Medido em TODA ferramenta que o motor
 * monta (catálogo, nativas e a variante do retorno), e não num esquema de
 * exemplo: um passo do enxugamento que comesse `default`, `enum` ou um nó
 * aninhado passaria nos casos acima e mudaria o que o modelo lê.
 */
describe("knob desligado: fora o `$schema`, o esquema no fio é o que o zod gera", () => {
  it("⭐ em todas as ferramentas do catálogo e nativas", async () => {
    const { allTools } = await import("@/lib/mcp/tools");
    const { shapeToZodObject } = await import("@/lib/ai/runtime/tools");
    const { AGENT_TOOL_DEFS, SCHEDULE_FOLLOWUP_COM_NEGOCIO } = await import(
      "@/lib/agent-engine/agent/inbound-turn"
    );
    const esquemas: Array<[string, FlexibleSchema<unknown>]> = [
      ...allTools.map(
        (t) =>
          [t.name, shapeToZodObject(t.inputSchema as Record<string, z.ZodTypeAny>)] as [
            string,
            FlexibleSchema<unknown>,
          ],
      ),
      ...Object.entries(AGENT_TOOL_DEFS).map(
        ([nome, d]) => [nome, d.inputSchema] as [string, FlexibleSchema<unknown>],
      ),
      ["schedule_followup (com negócio)", SCHEDULE_FOLLOWUP_COM_NEGOCIO.inputSchema],
    ];
    let comPattern = 0;
    for (const [nome, schema] of esquemas) {
      const { $schema: _meta, ...cru } = (await asSchema(schema).jsonSchema) as Record<string, unknown>;
      const fio = await esquemaParaOProvedor(schema, { semPadrao: false });
      expect(fio, nome).toEqual(cru);
      if (JSON.stringify(fio).includes('"pattern"')) comPattern += 1;
    }
    // Guarda de vacuidade: a régua alcança o catálogo, e há `pattern` para perder.
    expect(esquemas.length).toBeGreaterThan(50);
    expect(comPattern).toBeGreaterThan(10);
  });
});

describe("LLM_TOOL_SCHEMA_SEM_PADRAO chega à config do seam", () => {
  it("ausente = o default único; 'on' liga; 'off' desliga", () => {
    expect(llmEdgeConfigFromEnv({}).esquemaSemPadrao).toBe(ESQUEMA_SEM_PADRAO_PADRAO);
    expect(llmEdgeConfigFromEnv({ LLM_TOOL_SCHEMA_SEM_PADRAO: "on" }).esquemaSemPadrao).toBe(true);
    expect(llmEdgeConfigFromEnv({ LLM_TOOL_SCHEMA_SEM_PADRAO: "off" }).esquemaSemPadrao).toBe(false);
  });

  it("valor que não é on/off lança com o nome da variável", () => {
    expect(() => llmEdgeConfigFromEnv({ LLM_TOOL_SCHEMA_SEM_PADRAO: "talvez" })).toThrow(
      /LLM_TOOL_SCHEMA_SEM_PADRAO/,
    );
  });
});
