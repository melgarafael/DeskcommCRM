import { describe, expect, it } from "vitest";
import { costCents, custoTerraPorPassos } from "./pricing";
const usage = (inputTokens: number, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) => ({inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens});
describe("GPT-6.1 Terra: Standard por requisição", () => {
  it("cobra entrada, saída e leitura de cache pela tarifa própria", () => {
    expect(costCents("gpt-6.1-terra", usage(100_000, 100_000))).toBeCloseTo(60);
    expect(costCents("gpt-6.1-terra", usage(100_000, 0, 100_000))).toBeCloseTo(0.5);
  });
  it("30m é o padrão OpenAI, independente do TTL Anthropic", () => {
    expect(costCents("gpt-6.1-terra", usage(100_000, 0, 0, 100_000), "1h")).toBeCloseTo(12.5);
    expect(costCents("gpt-6.1-terra", usage(100_000, 0, 0, 100_000), "5m")).toBeCloseTo(12.5);
    expect(costCents("gpt-6.1-terra", {...usage(100_000,0,0,100_000),cacheWrite12hTokens:40_000})).toBeCloseTo(17.5);
  });
  it("aplica a faixa longa somente acima de 272k na requisição inteira", () => {
    expect(costCents("gpt-6.1-terra",usage(272_000,100_000))).toBeCloseTo(77.2);
    expect(costCents("gpt-6.1-terra",usage(272_001,100_000))).toBeCloseTo(129.4002);
    expect(costCents("gpt-6.1-terra",usage(1_000_000,0,1_000_000))).toBeCloseTo(10);
  });
  it("lê cache_write_tokens cru, mesmo quando o SDK não o normaliza", () => {
    const u={inputTokens:100_000,outputTokens:0,raw:{input_tokens_details:{cached_tokens:20_000,cache_write_tokens:80_000}}};
    expect(custoTerraPorPassos("gpt-6.1-terra",{usage:u})).toBeCloseTo(10.1);
  });
  it("não aplica faixa longa à soma de passos curtos", () => {
    const u={inputTokens:200_000,outputTokens:0};
    expect(custoTerraPorPassos("gpt-6.1-terra",{usage:{inputTokens:400_000,outputTokens:0},steps:[{usage:u},{usage:u}]})).toBeCloseTo(40);
  });
  it("não atribui tarifa Terra a ids desconhecidos nem muda outros modelos", () => {
    expect(costCents("gpt-6.1-terra-pro",usage(100))).toBeNull();
    expect(custoTerraPorPassos("gpt-6.1-sol",{usage:{inputTokens:1,outputTokens:1}})).toBeUndefined();
    expect(costCents("openai/gpt-6.1-terra",usage(100_000))).toBeCloseTo(10);
  });
});
