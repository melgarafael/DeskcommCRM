/**
 * `ops:count-prefix` mede o peso de cada bloco do sistema e de cada ferramenta
 * — e imprime só NOMES e NÚMEROS. O texto de um bloco é o prompt do cliente e a
 * memória da organização: ele não pode sair num terminal de operação.
 */
import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { serializeStablePrefix } from "@/lib/agent-engine/edge/llm/stable-prefix";
import { formatarMedida, medirPrefixo } from "@/scripts/ops-count-prefix.leitura";

const SEGREDO = "SEGREDO-DE-TESTE";

const ferramentas = {
  curta: tool({ description: `curta ${SEGREDO}`, inputSchema: z.object({}) }),
  send_template: tool({
    description: `Envia um modelo aprovado ${SEGREDO}.`,
    inputSchema: z.object({ template: z.string(), variaveis: z.array(z.string()) }),
  }),
  longa: tool({
    description: `Uma ferramenta de descrição bem mais longa que as outras duas, de propósito. ${SEGREDO}`,
    inputSchema: z.object({ a: z.string(), b: z.number(), c: z.boolean(), d: z.array(z.string()) }),
  }),
};

const blocos = [
  ["playbook", `Você é o atendente. ${SEGREDO}`],
  ["memória da organização", ""],
  ["transparência", `Diga que é uma IA quando perguntarem. ${SEGREDO}`],
] as const;

describe("medirPrefixo", () => {
  it("mede com o knob do esquema que recebe: ligado, a ferramenta com uuid pesa menos", async () => {
    const comUuid = { ver: tool({ description: "Lê um lead.", inputSchema: z.object({ lead_id: z.string().uuid() }) }) };
    const ligado = await medirPrefixo({ blocos: [], ferramentas: comUuid, esquemaSemPadrao: true });
    const desligado = await medirPrefixo({ blocos: [], ferramentas: comUuid, esquemaSemPadrao: false });
    expect(ligado.ferramentas[0]!.chars).toBeLessThan(desligado.ferramentas[0]!.chars);
  });

  it("uma linha por ferramenta, da maior para a menor", async () => {
    const m = await medirPrefixo({ blocos, ferramentas });
    expect(m.ferramentas.map((l) => l.nome)).toHaveLength(3);
    const chars = m.ferramentas.map((l) => l.chars);
    expect([...chars].sort((a, b) => b - a)).toEqual(chars);
    expect(m.ferramentas[0]!.nome).toBe("longa");
  });

  it("as linhas somam a serialização canônica do prefixo — nada some na conta", async () => {
    const m = await medirPrefixo({ blocos, ferramentas });
    expect(m.totalFerramentas.chars).toBe((await serializeStablePrefix({ tools: ferramentas })).length);
  });

  it("conta tokens o200k, e bloco vazio não vira linha", async () => {
    const m = await medirPrefixo({ blocos, ferramentas });
    expect(m.blocos.map((b) => b.nome)).toEqual(["playbook", "transparência"]);
    for (const l of [...m.blocos, ...m.ferramentas]) expect(l.tokens).toBeGreaterThan(0);
    expect(m.totalBlocos.tokens).toBe(m.blocos.reduce((n, b) => n + b.tokens, 0));
  });

  it("a saída formatada leva nomes e números, nunca o conteúdo", async () => {
    const saida = formatarMedida(await medirPrefixo({ blocos, ferramentas }));
    expect(saida).not.toContain(SEGREDO);
    expect(saida).toContain("playbook");
    expect(saida).toContain("longa");
  });

  it("ferramenta que depende de canal ou opção sai marcada `condicional`", async () => {
    const m = await medirPrefixo({ blocos, ferramentas });
    expect(m.ferramentas.find((l) => l.nome === "send_template")?.condicional).toBe(true);
    expect(m.ferramentas.find((l) => l.nome === "longa")?.condicional).toBe(false);
    expect(formatarMedida(m)).toMatch(/send_template.*condicional/);
  });
});
