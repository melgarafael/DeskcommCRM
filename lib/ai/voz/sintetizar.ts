/**
 * Síntese de voz (ElevenLabs Text-to-Speech) — a chamada em si, sem decisão de
 * negócio nenhuma embutida.
 *
 * Deliberadamente SEM registro em `lib/ai/pontos/registro.ts` e sem gravar em
 * `llm_calls` ainda: este módulo é a peça que a Frente B do plano
 * (docs/superpowers/plans/2026-10-29-voz-elevenlabs.md) usa, mas QUEM decide
 * se o agente fala (`voz_quando`), e QUANDO o custo é registrado, pertence ao
 * ponto de chamada real — que ainda não existe no runtime. Registrar o ponto
 * ou logar custo aqui, sem um chamador de verdade, seria o próprio defeito que
 * `tests/unit/pontos-de-ia-completude.test.ts` existe para pegar: ponto no
 * registro (ou gasto no log) que nenhum caminho de produção aciona.
 */
export interface SintetizarVozInput {
  apiKey: string;
  voiceId: string;
  /** Default da própria ElevenLabs: `eleven_multilingual_v2`. */
  modelId?: string;
  texto: string;
  /** 0–1. Default 0.5 — o mesmo default documentado pela ElevenLabs. */
  stability?: number;
  /** 0–1. Default 0.75 — idem. */
  similarityBoost?: number;
}

export interface SintetizarVozResultado {
  audio: Buffer;
  /** `audio/mpeg` no formato padrão (`mp3_44100_128`). Só canal `server-convert` o entrega como nota de voz — ver `voz-do-turno.ts`. */
  mimeType: string;
  /** Caracteres de `texto` — a unidade de cobrança (`custoDeVozCents` em pricing.ts). */
  caracteres: number;
}

const DEFAULT_MODEL = "eleven_multilingual_v2";

export async function sintetizarVoz(
  input: SintetizarVozInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SintetizarVozResultado> {
  const res = await fetchImpl(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": input.apiKey,
        "content-type": "application/json",
        // mp3_44100_128 é o default da própria API — explícito aqui para o
        // contrato não depender de um default que a ElevenLabs pode mudar.
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: input.texto,
        model_id: input.modelId ?? DEFAULT_MODEL,
        voice_settings: {
          stability: input.stability ?? 0.5,
          similarity_boost: input.similarityBoost ?? 0.75,
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`synthesis_${res.status}`);
  const audio = Buffer.from(await res.arrayBuffer());
  return {
    audio,
    mimeType: res.headers.get("content-type") ?? "audio/mpeg",
    caracteres: input.texto.length,
  };
}
