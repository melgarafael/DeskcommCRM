import { describe, expect, it } from "vitest";

import { parseFaqMarkdown } from "@/lib/ai/rag/ingest/faq";

const MD = (q: string, a: string) => `## ${q}: Qual o prazo?\n## ${a}: Cinco dias úteis.\n`;

describe("parseFaqMarkdown — marcadores trilíngues", () => {
  it.each([
    ["Pergunta", "Resposta"],
    ["Pregunta", "Respuesta"],
    ["Question", "Answer"],
    ["P", "R"],
    ["Q", "A"],
  ])("aceita ## %s: / ## %s:", (q, a) => {
    const items = parseFaqMarkdown(MD(q, a));
    expect(items).toHaveLength(1);
    expect(items[0]?.question).toBe("Qual o prazo?");
    expect(items[0]?.answer).toBe("Cinco dias úteis.");
  });

  it("ignora marcador de idioma não suportado", () => {
    const items = parseFaqMarkdown("## Frage: Wie lange?\n## Antwort: Fünf Tage.\n");
    expect(items).toHaveLength(0);
  });
});
