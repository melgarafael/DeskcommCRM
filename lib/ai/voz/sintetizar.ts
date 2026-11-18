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
import {
  ehContainerOgg,
  MIME_DA_NOTA_DE_VOZ_OPUS,
  SAIDA_OPUS_DA_ELEVENLABS,
  type FormatoDaVoz,
} from "./formato";

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
  /**
   * `mp3` (o default de sempre) ou `ogg_opus`, o que o canal oficial exige para
   * nota de voz — quem escolhe é `formatoDaVozParaCanal` (`./formato.ts`).
   */
  formato?: FormatoDaVoz;
}

export interface SintetizarVozResultado {
  audio: Buffer;
  /**
   * `audio/mpeg` no formato padrão (`mp3_44100_128`); `audio/ogg;codecs=opus`
   * quando `formato` é `ogg_opus` — a etiqueta que o canal oficial aceita, não o
   * `audio/opus` que a ElevenLabs devolve (ver `./formato.ts`).
   */
  mimeType: string;
  /** Caracteres de `texto` — a unidade de cobrança (`custoDeVozCents` em pricing.ts). */
  caracteres: number;
}

const DEFAULT_MODEL = "eleven_multilingual_v2";

/**
 * A recusa do provedor, com o motivo que ELE deu.
 *
 * `message` continua `synthesis_<status>` porque é o que chamadores e testes já
 * leem; o texto do provedor vai em `mensagemDoProvedor` para a rota de prévia
 * levar até a tela (#4260: um `voice_id` fora do catálogo é válido até o
 * provedor dizer o contrário — e quando disser, a pessoa precisa saber por quê,
 * não só "não foi possível").
 */
// A classe mora em arquivo próprio: quem a consome na ROTA não pode depender
// do módulo que fala com o provedor — teste que troca `sintetizar` por dublê
// deixaria a classe indefinida e o `instanceof` explodiria.
import { ErroDoProvedorDeVoz } from "./erro-do-provedor";

export { ErroDoProvedorDeVoz };

/** O `detail` do ElevenLabs é `{status, message}` — mas texto puro também aparece. */
function motivoDaRecusa(corpo: string): string | null {
  const texto = corpo.trim();
  if (texto === "") return null;
  try {
    const json = JSON.parse(texto) as { detail?: unknown };
    const detalhe = json.detail;
    if (typeof detalhe === "string" && detalhe.trim() !== "") return detalhe.trim().slice(0, 300);
    if (detalhe && typeof detalhe === "object") {
      const mensagem = (detalhe as { message?: unknown }).message;
      if (typeof mensagem === "string" && mensagem.trim() !== "") return mensagem.trim().slice(0, 300);
    }
  } catch {
    // Corpo não-JSON: o texto cru já é a melhor mensagem disponível.
  }
  return texto.slice(0, 300);
}

export async function sintetizarVoz(
  input: SintetizarVozInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SintetizarVozResultado> {
  const opus = input.formato === "ogg_opus";
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voiceId)}${
    opus ? `?output_format=${SAIDA_OPUS_DA_ELEVENLABS}` : ""
  }`;
  const res = await fetchImpl(
    url,
    {
      method: "POST",
      headers: {
        "xi-api-key": input.apiKey,
        "content-type": "application/json",
        // mp3_44100_128 é o default da própria API — explícito aqui para o
        // contrato não depender de um default que a ElevenLabs pode mudar. Em
        // opus quem manda é o `output_format` da URL, e a resposta vem como
        // `audio/opus` (medido) — por isso o `accept` não a restringe.
        accept: opus ? "*/*" : "audio/mpeg",
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
  if (!res.ok) {
    // Só LÊ o corpo depois de saber que a chamada falhou: no caminho feliz o
    // corpo é o áudio, e consumi-lo como texto o destruiria.
    const corpo = await res.text().catch(() => "");
    throw new ErroDoProvedorDeVoz(res.status, motivoDaRecusa(corpo));
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (opus) {
    // Conferido no BYTE, não no cabeçalho: um opus cru (sem contêiner) ou um mp3
    // de volta chegariam ao canal oficial como anexo — ou nem chegariam (131053).
    // Lançar aqui faz o envio cair para TEXTO (`send-message.ts`), que é o
    // combinado da voz: ela é um extra, nunca o que deixa o cliente sem resposta.
    if (!ehContainerOgg(audio)) throw new Error("synthesis_formato_inesperado");
    return { audio, mimeType: MIME_DA_NOTA_DE_VOZ_OPUS, caracteres: input.texto.length };
  }
  return {
    audio,
    mimeType: res.headers.get("content-type") ?? "audio/mpeg",
    caracteres: input.texto.length,
  };
}
