/**
 * O ROTEIRO DA PROVA PAGA, SEM REDE: um `fetch` falso faz o papel da OpenRouter.
 *
 * A prova paga só vale se mandar a cada provedor de origem o corpo EXATO do
 * embrulho da fábrica, fixado naquela tag — e se a conclusão dela (aprovada ou
 * não) sair dos números certos. É isso que estes casos prendem, antes de alguém
 * gastar a chave real.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { linhaLegivel, rodarProva } from "./prova-cache-openrouter";

/** Os módulos que a prova alcança, e o que cada um importa. */
function importsDe(caminho: string): string[] {
  return [...readFileSync(caminho, "utf8").matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
}

type Corpo = Record<string, unknown> & {
  model: string;
  session_id?: string;
  cache_control?: unknown;
  provider?: { only: string[]; allow_fallbacks: boolean };
  messages: Array<{ role: string; content: unknown }>;
};

const ENDPOINTS = [
  { tag: "anthropic", provider_name: "Anthropic", pricing: { prompt: "0.000001" } },
  { tag: "amazon-bedrock/us", provider_name: "Amazon Bedrock", pricing: { prompt: "0.000001" } },
];
const NOME: Record<string, string> = { anthropic: "Anthropic", "amazon-bedrock": "Amazon Bedrock", "amazon-bedrock/us": "Amazon Bedrock" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A OpenRouter de mentira. `recusa` = tags que o `only` não aceita (404) ou que
 * recusam o campo de cache (400). Por sessão, a 1ª chamada grava e a 2ª lê.
 */
function openRouterFalsa(recusa: { only404?: string[]; cache400?: string[]; semSaldo?: string[] } = {}) {
  const corpos: Corpo[] = [];
  const urls: string[] = [];
  const vistas = new Map<string, number>();
  const f = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/endpoints")) return json(200, { data: { endpoints: ENDPOINTS } });
    const corpo = JSON.parse(String(init?.body)) as Corpo;
    corpos.push(corpo);
    const tag = corpo.provider?.only[0] ?? "";
    if (recusa.only404?.includes(tag)) return json(404, { error: { message: "No allowed providers", code: 404 } });
    if (recusa.cache400?.includes(tag)) return json(400, { error: { message: "cache_control: extra inputs", code: 400 } });
    if (recusa.semSaldo?.includes(tag)) return json(402, { error: { message: "This request requires more credits", code: 402 } });
    const n = (vistas.get(corpo.session_id ?? "") ?? 0) + 1;
    vistas.set(corpo.session_id ?? "", n);
    const prompt = 5_600;
    return json(200, {
      id: `gen-${corpos.length}`,
      object: "chat.completion",
      created: 1,
      model: corpo.model,
      provider: NOME[tag],
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: 1,
        total_tokens: prompt + 1,
        prompt_tokens_details: n === 1 ? { cached_tokens: 0, cache_write_tokens: 5_500 } : { cached_tokens: 5_500, cache_write_tokens: 0 },
        // 1ª: 5.500 gravados a 2× (1 h) + 100 a 1× ≈ razão 1,98.
        cost: n === 1 ? (5_500 * 2 + 100) * 0.000001 : (5_500 * 0.1 + 100) * 0.000001,
        is_byok: false,
        cost_details: { upstream_inference_cost: null },
      },
    });
  }) as typeof fetch;
  return { f, corpos, urls };
}

async function rodar(f: typeof fetch) {
  const saida: string[] = [];
  const r = await rodarProva({
    fetch: f,
    chave: "sk-or-teste",
    modelos: ["anthropic/claude-haiku-4.5"],
    salt: "salt-fixo",
    escrever: (l) => saida.push(l),
  });
  return { ...r, saida };
}

describe("o roteiro da prova paga do cache na OpenRouter", () => {
  it("roda só com a chave da OpenRouter: não alcança o env do app (Supabase) nem providers.ts", () => {
    // providers.ts importa lib/env, que exige as variáveis do Supabase — quem
    // roda a prova numa máquina limpa não as tem. Por isso o embrulho mora em
    // cache-da-openrouter.ts, e a prova só chega a ele e ao prefixo estável.
    expect(importsDe("scripts/prova-cache-openrouter.ts").sort()).toEqual([
      "@/lib/agent-engine/edge/llm/cache-da-openrouter",
      "@/lib/agent-engine/edge/llm/stable-prefix",
      "@ai-sdk/openai",
      "ai",
      "node:crypto",
    ]);
    expect(importsDe("lib/agent-engine/edge/llm/cache-da-openrouter.ts")).toEqual(["./stable-prefix"]);
    expect(importsDe("lib/agent-engine/edge/llm/stable-prefix.ts").sort()).toEqual(["ai", "node:crypto"]);
  });

  it("⭐ cada tag listada recebe o corpo do embrulho, fixado nela, em 2 chamadas com a mesma sessão", async () => {
    const { f, corpos, urls } = openRouterFalsa();
    const { aprovada, linhas } = await rodar(f);

    expect(urls[0]).toBe("https://openrouter.ai/api/v1/models/anthropic/claude-haiku-4.5/endpoints");
    expect(urls.slice(1).every((u) => u === "https://openrouter.ai/api/v1/chat/completions")).toBe(true);
    expect(corpos).toHaveLength(4);
    for (const corpo of corpos) {
      expect(corpo.model).toBe("anthropic/claude-haiku-4.5");
      expect(corpo.messages[0]?.content).toEqual([
        expect.objectContaining({ type: "text", cache_control: { type: "ephemeral", ttl: "1h" } }),
      ]);
      expect(corpo.cache_control).toEqual({ type: "ephemeral" });
      expect(corpo.session_id).toMatch(/^[0-9a-f]{32}$/);
      expect(corpo.provider?.allow_fallbacks).toBe(false);
    }
    expect(corpos.map((c) => c.provider?.only)).toEqual([["anthropic"], ["anthropic"], ["amazon-bedrock/us"], ["amazon-bedrock/us"]]);
    // A mesma sessão dentro da tag (para a 2ª ler o que a 1ª gravou), outra entre tags.
    expect(corpos[0]!.session_id).toBe(corpos[1]!.session_id);
    expect(corpos[2]!.session_id).not.toBe(corpos[0]!.session_id);
    // As duas chamadas de uma tag mandam o MESMO prefixo — senão a 2ª não teria o que ler.
    expect(corpos[0]!.messages[0]).toEqual(corpos[1]!.messages[0]);

    expect(aprovada).toBe(true);
    expect(linhas.map((l) => l.passou)).toEqual([true, true]);
    expect(linhas[0]!.razaoDeCusto).toBeCloseTo((5_500 * 2 + 100) / 5_600, 6);
    expect(linhas[0]!.chamadas[0]).toMatchObject({ provider: "Anthropic", cacheWriteTokens: 5_500, isByok: false });
    expect(linhas[0]!.chamadas[1]).toMatchObject({ cachedTokens: 5_500 });
  });

  it("tag que o only recusa (404) é repetida pela família, e a saída registra a troca", async () => {
    const { f, corpos } = openRouterFalsa({ only404: ["amazon-bedrock/us"] });
    const { aprovada, linhas, saida } = await rodar(f);
    const bedrock = linhas.find((l) => l.tag === "amazon-bedrock/us")!;
    expect(bedrock.tagUsada).toBe("amazon-bedrock");
    expect(bedrock.passou).toBe(true);
    expect(bedrock.motivos.join()).toContain("recusada pelo only");
    expect(corpos.map((c) => c.provider?.only[0])).toContain("amazon-bedrock");
    expect(saida.join("\n")).toContain("pedida como amazon-bedrock");
    expect(aprovada).toBe(true);
  });

  it("um provedor que recusa o cache_control com 400 reprova a prova, com o status na linha", async () => {
    const { f } = openRouterFalsa({ cache400: ["anthropic"] });
    const { aprovada, linhas, saida } = await rodar(f);
    const anthropic = linhas.find((l) => l.tag === "anthropic")!;
    expect(anthropic.passou).toBe(false);
    expect(anthropic.chamadas).toHaveLength(1);
    expect(anthropic.chamadas[0]!.status).toBe(400);
    expect(aprovada).toBe(false);
    expect(saida.at(-1)).toContain("PROVA REPROVADA");
    expect(linhaLegivel(anthropic)).toContain("HTTP 400");
  });

  it("conta sem saldo (402) para a prova SEM veredito, em vez de reprovar a tag", async () => {
    const { f } = openRouterFalsa({ semSaldo: ["amazon-bedrock/us"] });
    await expect(rodar(f)).rejects.toThrow(/402.*sem saldo.*SEM veredito/);
  });
});
