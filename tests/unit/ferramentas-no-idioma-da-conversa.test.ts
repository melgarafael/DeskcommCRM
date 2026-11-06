import { describe, expect, it } from "vitest";

import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";

/**
 * As ferramentas do agente não fixam o português.
 *
 * Caso real (01/10/2026, operação em espanhol): num turno de follow-up — sem
 * mensagem do cliente para ancorar o idioma — o agente abriu um caso com título,
 * resumo e motivo em português, porque o campo dizia "o que o lead precisa, em
 * pt-br". O mesmo "em pt-br" estava no corpo do `send_message` (o texto que vai
 * ao cliente) e na busca de conhecimento (que procura num material escrito no
 * idioma da operação). A descrição da ferramenta é instrução para o modelo:
 * nela, o idioma tem de ser o da conversa, nunca um idioma fixo.
 */

type ComShape = { shape?: Record<string, { description?: string }> };

function descricoes(): Array<{ ferramenta: string; campo: string; texto: string }> {
  const out: Array<{ ferramenta: string; campo: string; texto: string }> = [];
  for (const [ferramenta, def] of Object.entries(AGENT_TOOL_DEFS)) {
    const shape = ((def as { inputSchema?: ComShape }).inputSchema as ComShape | undefined)?.shape ?? {};
    for (const [campo, schema] of Object.entries(shape)) {
      if (typeof schema?.description === "string") out.push({ ferramenta, campo, texto: schema.description });
    }
  }
  return out;
}

describe("ferramentas do agente — idioma", () => {
  it("nenhum campo manda escrever em português fixo", () => {
    const fixos = descricoes().filter((d) => /pt-br|em portugu[eê]s/i.test(d.texto));
    expect(fixos).toEqual([]);
  });

  it.each([
    ["send_message", "body"],
    ["search_knowledge", "query"],
    ["open_human_case", "summary"],
    ["open_human_case", "title"],
  ])("%s.%s pede o idioma da conversa", (ferramenta, campo) => {
    const d = descricoes().find((x) => x.ferramenta === ferramenta && x.campo === campo);
    expect(d, `${ferramenta}.${campo} existe`).toBeDefined();
    expect(d!.texto).toMatch(/idioma da conversa/);
  });
});
