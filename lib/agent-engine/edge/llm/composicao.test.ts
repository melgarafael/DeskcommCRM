import { jsonSchema, tool, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { medirComposicao } from "./composicao";
import { ESQUEMA_SEM_PADRAO_PADRAO, esquemaParaOProvedor, stablePrefixHash } from "./stable-prefix";

/** O MESMO insumo de `tests/unit/prefixo-estavel-golden.test.ts`, e o mesmo literal. */
function insumoGolden() {
  return {
    system: "Você atende a Loja Exemplo. Responda em português, com frases curtas.",
    tools: {
      salvar_nota: tool({
        description: "Salva uma nota sobre o lead.",
        inputSchema: z.object({ titulo: z.string(), corpo: z.string().max(500) }),
      }),
      buscar_produto: tool({
        description: "Busca um produto no catálogo.",
        inputSchema: jsonSchema({
          type: "object",
          properties: { termo: { type: "string" } },
          required: ["termo"],
          additionalProperties: false,
        }),
      }),
    },
  };
}
const HASH_GOLDEN = "18075b5218335a03ba6363128b064f0898f150135e910f6aa6cd283e5bc318a4";

describe("medirComposicao", () => {
  it("sem ferramentas, charsFerramentas é 0 mesmo com sistema (a subtração ingênua daria o rótulo)", async () => {
    const c = await medirComposicao({ system: "sou o sistema", messages: [] });
    expect(c.charsSistema).toBe("sou o sistema".length);
    expect(c.charsFerramentas).toBe(0);
  });

  it("o hash é o do prefixo estável — o mesmo literal do teste golden", async () => {
    const c = await medirComposicao({ ...insumoGolden(), messages: [] });
    expect(c.prefixoHash).toBe(HASH_GOLDEN);
    expect(c.prefixoHash).toBe(await stablePrefixHash(insumoGolden()));
  });

  it("uma ferramenta a mais aumenta charsFerramentas pelo menos o tamanho da descrição + schema dela", async () => {
    const base = await medirComposicao({ ...insumoGolden(), messages: [] });
    const nova = tool({ description: "Agenda uma visita.", inputSchema: z.object({ dia: z.string() }) });
    const comMais = await medirComposicao({
      system: insumoGolden().system,
      tools: { ...insumoGolden().tools, agendar: nova },
      messages: [],
    });
    // O esquema como vai no fio (a régua da cerca de peso), não o cru do zod.
    const esquema = await esquemaParaOProvedor(nova.inputSchema, { semPadrao: ESQUEMA_SEM_PADRAO_PADRAO });
    const peso = JSON.stringify({ description: nova.description, inputSchema: esquema }).length;
    expect(comMais.charsFerramentas - base.charsFerramentas).toBeGreaterThanOrEqual(peso);
    expect(comMais.charsSistema).toBe(base.charsSistema);
  });

  it("com o knob do esquema ligado, mede o esquema que foi ao fio, e não o do default", async () => {
    // `.uuid()` é o caso do knob: o zod v4 gera `format` E o `pattern` que o repete.
    const tools = { ver_lead: tool({ description: "Lê um lead.", inputSchema: z.object({ lead_id: z.string().uuid() }) }) };
    const ligado = await medirComposicao({ system: "s", tools, esquemaSemPadrao: true, messages: [] });
    const desligado = await medirComposicao({ system: "s", tools, esquemaSemPadrao: false, messages: [] });
    expect(ligado.prefixoHash).toBe(await stablePrefixHash({ system: "s", tools, esquemaSemPadrao: true }));
    expect(ligado.prefixoHash).not.toBe(desligado.prefixoHash);
    expect(ligado.charsFerramentas).toBeLessThan(desligado.charsFerramentas);
  });

  it("mensagens: texto conta, mídia só incrementa partesDeMidia, tool-call conta o JSON do input", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "0123456789" },
      { role: "user", content: [{ type: "file", data: Buffer.from("x"), mediaType: "image/jpeg" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: { a: 1 } }] },
    ];
    const c = await medirComposicao({ messages });
    expect(c.charsMensagens).toBe(10 + 7);
    expect(c.partesDeMidia).toBe(1);
  });

  it("sem sistema, charsSistema é 0", async () => {
    const c = await medirComposicao({ tools: insumoGolden().tools, messages: [] });
    expect(c.charsSistema).toBe(0);
    expect(c.charsFerramentas).toBeGreaterThan(0);
  });
});
