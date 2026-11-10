/**
 * A TRANSCRIÇÃO PELA OPENAI GRAVA CUSTO — pela duração que a própria OpenAI cobra.
 *
 * Medido em produção em out/2026: as transcrições `whisper-1` saíam todas com
 * `cost_cents` nulo, enquanto o MESMO áudio transcrito pela OpenRouter já
 * contava no gasto (`usage.cost`). O `whisper-1` é cobrado por minuto, e a
 * resposta da OpenAI traz `usage: { type: 'duration', seconds }` — o número que
 * ela cobra. Custo = segundos/60 × US$ 0,006, sem ler o binário do áudio.
 *
 * O que NÃO pode virar custo: servidor compatível que aceite o nome `whisper-1`
 * (Groq, local), modelo cobrado por token, número fora do formato. Em todos, o
 * custo continua null — e o texto volta sempre.
 */
import { describe, expect, it, vi } from "vitest";

import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";

function fetchQueResponde(corpo: unknown) {
  return vi.fn(async () => new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

async function medir(
  creds: Parameters<typeof apiTranscriptionProvider>[0],
  corpo: unknown,
): Promise<{ texto: string; custoCents?: number | null }> {
  const p = apiTranscriptionProvider(creds, fetchQueResponde(corpo));
  expect(p.transcribeMedindo, "sem transcribeMedindo o worker nunca vê o custo").toBeTypeOf("function");
  return p.transcribeMedindo!(Buffer.from([1, 2, 3]), "audio/ogg");
}

const WHISPER = { apiKey: "sk-teste", model: "whisper-1" } as const;

describe("whisper-1 na OpenAI: custo pela duração cobrada", () => {
  it("30 segundos custam 0,3 centavo (US$ 0,006/min), e o texto volta", async () => {
    const r = await medir(WHISPER, { text: "olá", usage: { type: "duration", seconds: 30 } });
    expect(r.texto).toBe("olá");
    expect(r.custoCents).toBeCloseTo(0.3, 10);
  });

  it("o endereço da OpenAI escrito com /v1 é a mesma OpenAI", async () => {
    const r = await medir(
      { ...WHISPER, baseUrl: "https://api.openai.com/v1" },
      { text: "olá", usage: { type: "duration", seconds: 60 } },
    );
    expect(r.custoCents).toBeCloseTo(0.6, 10);
  });

  it("sem `usage` o custo continua null — nunca 0", async () => {
    const r = await medir(WHISPER, { text: "olá" });
    expect(r.custoCents).toBeNull();
  });

  it("outro servidor que aceita o nome whisper-1 não leva o preço da OpenAI", async () => {
    const r = await medir(
      { ...WHISPER, baseUrl: "https://api.groq.com/openai/v1" },
      { text: "olá", usage: { type: "duration", seconds: 30 } },
    );
    expect(r.custoCents).toBeNull();
  });

  it.each([
    ["texto", '{"text":"olá","usage":{"type":"duration","seconds":"30"}}'],
    ["negativo", '{"text":"olá","usage":{"type":"duration","seconds":-1}}'],
    ["infinito", '{"text":"olá","usage":{"type":"duration","seconds":1e400}}'],
  ])("`seconds` fora do formato (%s) dá null, com o texto devolvido e sem exceção", async (_caso, corpo) => {
    const r = await medir(WHISPER, corpo);
    expect(r.texto).toBe("olá");
    expect(r.custoCents).toBeNull();
  });

  it("modelo cobrado por token (gpt-4o-transcribe) não ganha preço por minuto", async () => {
    const r = await medir(
      { apiKey: "sk-teste", model: "gpt-4o-transcribe" },
      { text: "olá", usage: { type: "tokens", input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
    );
    expect(r.custoCents).toBeNull();
  });

  it("o custo informado em USD (contrato OpenRouter) vence a duração", async () => {
    const r = await medir(
      { ...WHISPER, medirCustoEmUsd: true },
      { text: "olá", usage: { cost: 0.000508, seconds: 30 } },
    );
    expect(r.custoCents).toBeCloseTo(0.0508, 10);
  });

  it("`usage.cost` sem o contrato que o declara em USD não é lido", async () => {
    const r = await medir(
      { ...WHISPER, baseUrl: "https://transcricao.exemplo.com/v1" },
      { text: "olá", usage: { cost: 5 } },
    );
    expect(r.custoCents).toBeNull();
  });

  it("transcribe() continua devolvendo só o texto", async () => {
    const p = apiTranscriptionProvider(WHISPER, fetchQueResponde({ text: "olá", usage: { type: "duration", seconds: 30 } }));
    await expect(p.transcribe(Buffer.from([1]), "audio/ogg")).resolves.toBe("olá");
  });
});
