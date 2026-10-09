/**
 * DE ONDE VEM QUEM OUVE O ÁUDIO DO CLIENTE (#2171).
 *
 * O worker de derivação resolvia a transcrição por uma árvore de `if` que só
 * conhecia a OpenAI: sem chave OpenAI em lugar nenhum, o áudio não era
 * transcrito — mesmo para uma organização cujo MODELO DE CONVERSA já entende
 * áudio (Gemini com a chave do Google validada no painel). E o desfecho era
 * mudo: `media_derived_status` ficava nulo, o drain esperava o teto de 8
 * minutos e o turno rodava com a mensagem vazia.
 *
 * Este módulo é a ESCADA, no formato de `lib/ai/embeddings/chave.ts`: degraus
 * do mais específico ao mais genérico, cada um com a razão escrita, e um
 * `null` legítimo no fim que o chamador grava como `failed` + motivo — nunca
 * silêncio, nunca nulo.
 *
 *  1. **Serviço de transcrição da instalação** (`TRANSCRIPTION_API_KEY`) — a
 *     escolha EXPLÍCITA de transcrição do `.env`. Ignorá-la em silêncio para
 *     falar com o modelo de conversa seria trocar o fornecedor de quem já
 *     transcreve por outro, sem avisar (a mesma cautela do degrau 5 da escada
 *     de embedding, que protege quem já pagava por um provedor).
 *  2. **Padrão OpenAI-compatível** — a chave OpenAI resolvida como sempre
 *     (credencial da organização, senão a da instalação), com `whisper-1` ou
 *     `TRANSCRIPTION_MODEL`. Vem ANTES do modelo da organização pelo motivo
 *     escrito em `lib/ai/embeddings/chave.ts` (degraus 5 e 7): quem já
 *     transcrevia pela OpenAI não troca de fornecedor — nem de conta que paga —
 *     numa atualização. Vale para nota de voz e para a trilha de áudio do
 *     vídeo, que usa o mesmo transcriber.
 *  3. **Modelo de conversa da organização, quando declarar `audio`** — paga
 *     com a mesma credencial BYOK da conversa, que a organização já validou.
 *     É o degrau da #2171: a organização SEM chave OpenAI passa a ouvir o
 *     áudio. `transcreveAudio` é o registro de capacidades (`capabilities.ts`).
 *  4. **Nada** — resposta legítima, com o motivo. É o que o item 2 da issue
 *     pede: hoje "ninguém tentou" e "tentou e não deu" são o mesmo nulo.
 *
 * ── Quem ANUNCIA esta escada (#2190) ────────────────────────────────────────
 *
 * A tela de Provedores precisa dizer o MESMO que aqui se decide — e não
 * dizia: o registro fixava `provider: "openai"` / `modelId: "whisper-1"` no
 * ponto, então a organização da #2190 (Gemini, sem conta OpenAI, transcrevendo
 * pelo próprio modelo de conversa) via `whisper-1` na tela, ao lado de um texto
 * dizendo que "exige uma chave desse serviço". Dois caminhos anunciados para um
 * mesmo áudio.
 *
 * Por isso cada degrau devolve, junto do transcriber, o `anuncio` — provider e
 * modelo daquele degrau. A rota do painel roda esta escada e entrega a decisão
 * ao resolvedor (`lib/ai/pontos/resolver.ts`), que é quem fala com o operador:
 * UM lugar decide, os dois lados leem o mesmo lugar, e a régua em
 * `tests/unit/a-tela-e-o-motor-concordam-sobre-imagem.test.ts` compara os dois.
 *
 * Os knobs TRANSCRIPTION_* são lidos pela régua `env` de `lib/env.ts`, nunca
 * pelo `process.env` cru (#855/#964): a guarda de destino do worker
 * (`workers/media-derive-worker.ts`) lê `env.TRANSCRIPTION_BASE_URL`, e duas
 * réguas para o mesmo knob divergem caladas. Teste que precisa variar esses
 * knobs mocka `@/lib/env` (ver `tests/unit/midia-base-url-do-binding.test.ts`).
 */
import { generateText } from "ai";

import { transcreveAudio } from "@/lib/agent-engine/edge/llm/capabilities";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { env } from "@/lib/env";

import type { TranscriptionProvider } from "@/lib/messaging/media/transcription";
import {
  apiTranscriptionProvider,
  idiomasDaTranscricao,
  modeloDeTranscricaoEmVigor,
  type ORIGENS_DA_TRANSCRICAO_POR_SERVICO,
} from "@/lib/messaging/media/transcription";

export type OrigemDaTranscricao =
  | (typeof ORIGENS_DA_TRANSCRICAO_POR_SERVICO)[number]
  | "modelo_da_organizacao"
  | "nada";

/** O que o degrau escolhido RODA — e o que a tela pode anunciar. */
export interface AnuncioDaTranscricao {
  /**
   * Provedor/protocolo do degrau. `"openai"` nos degraus 1 e 2 é PROTOCOLO
   * (`/v1/audio/transcriptions`), não a empresa: o degrau 1 aceita outro
   * serviço compatível via `TRANSCRIPTION_BASE_URL`.
   */
  provider: string;
  /**
   * `null` SÓ no degrau `nada`: não há o que anunciar, e a tela diz "—" em vez
   * de prometer um caminho que ninguém vai usar.
   */
  modelId: string | null;
}

/**
 * O porquê de cada desfecho da escada, em frase FIXA. A tela de Provedores
 * mostra este motivo traduzido por `t()`, que casa a frase inteira e não
 * interpola — por isso o modelo não entra no texto (#2205): na tela ele já
 * aparece ao lado, e no worker o log carrega a organização. Toda frase daqui
 * precisa de tradução: `tests/unit/i18n-provedores-e-pontos.test.ts` cobra.
 */
export const MOTIVOS_DA_TRANSCRICAO = {
  servicoDaInstalacao:
    "o serviço de transcrição configurado nesta instalação (TRANSCRIPTION_API_KEY) é o que ouve os áudios",
  chaveOpenai: "a chave OpenAI desta organização ou instalação usa o padrão de transcrição de sempre",
  modeloDaOrganizacao:
    "o modelo de conversa da organização declara a capacidade audio e transcreve com a própria chave",
  semModeloDeConversa:
    "não consegui resolver o modelo de conversa desta organização e não há chave OpenAI para transcrever",
  modeloSemAudio:
    "o modelo de conversa da organização não declara a capacidade audio, e não há chave OpenAI para o serviço de transcrição",
  ninguem: "não há chave OpenAI nem modelo de conversa com capacidade audio nesta organização",
} as const;

/** O modelo de CONVERSA da organização, já resolvido pelo worker. */
export interface ConversaDaOrganizacao {
  provider: string;
  apiKey: string | null;
  modelId: string | null;
  baseUrl?: string | null;
}

export interface DecisaoDeTranscricao {
  origem: OrigemDaTranscricao;
  /** `null` SÓ no degrau "nada" — e aí `motivo` diz por quê. */
  transcriber: TranscriptionProvider | null;
  /**
   * Razoamento em PT-BR, pronto para `metadata.media_derived_motivo`. Sem ele
   * o operador vê `failed` e não sabe o que fazer a seguir.
   */
  motivo: string;
  /** O anúncio fiel do degrau escolhido — a tela repassa ao resolvedor. */
  anuncio: AnuncioDaTranscricao;
}


/**
 * O pedido ao modelo de conversa. Um PROVEDOR DE TRANSCRIÇÃO como os outros:
 * mesma interface `TranscriptionProvider`, só que o backend é o modelo da
 * organização em vez de `/v1/audio/transcriptions`.
 *
 * O texto pede SÓ a transcrição porque a derivação é camada universal: o
 * derivado vira `media_derived_text` e qualquer modelo de chat lê depois. Um
 * resumo ou uma resposta aqui contaminaria o turno.
 */
function promptDeTranscricao(languages: readonly string[]): string {
  const idioma =
    languages.length > 0
      ? ` O áudio está em ${languages.join(" ou ")} — transcreva nesse idioma.`
      : "";
  return `Transcreva o áudio anexado. Devolva somente o que foi falado, sem comentários, sem rótulos e sem aspas.${idioma}`;
}

export function transcricaoPeloModelo(modelo: {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string | null;
  languages?: readonly string[];
}): TranscriptionProvider {
  const registry = createDefaultRegistry();
  // É uma chamada de LLM cobrada por token, não um serviço de transcrição: o
  // uso volta junto do texto para o worker gravar tokens e custo.
  const transcribeMedindo: NonNullable<TranscriptionProvider["transcribeMedindo"]> = async (audio, mime) => {
    const factory = registry[modelo.provider];
    if (!factory) {
      // Mesma recusa do resto da cadeia: provedor sem fábrica não transcreve,
      // e a exceção vira `failed` + motivo no worker em vez de texto vazio.
      throw new Error(`transcription_provider_unavailable: ${modelo.provider}`);
    }
    const res = await generateText({
      model: factory(modelo.apiKey, modelo.modelId, modelo.baseUrl ?? undefined),
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: audio, mediaType: mime.split(";")[0]!.trim() },
            { type: "text", text: promptDeTranscricao(modelo.languages ?? []) },
          ],
        },
      ],
    });
    return {
      texto: (res.text ?? "").trim(),
      uso: {
        inputTokens: res.usage.inputTokens ?? 0,
        outputTokens: res.usage.outputTokens ?? 0,
        cacheReadTokens: res.usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: res.usage.inputTokenDetails.cacheWriteTokens ?? 0,
      },
    };
  };
  return {
    transcribe: async (audio, mime) => (await transcribeMedindo(audio, mime)).texto,
    transcribeMedindo,
  };
}

/**
 * A escada. `chaveOpenai` é um DEGRAU com thunk: só é consultado quando o
 * serviço de transcrição da instalação não vale.
 */
export async function decidirTranscricao(entrada: {
  conversa?: ConversaDaOrganizacao | null;
  idiomas?: readonly string[];
  chaveOpenai?: () => Promise<string | null>;
}): Promise<DecisaoDeTranscricao> {
  const idiomas = entrada.idiomas ?? idiomasDaTranscricao(env.TRANSCRIPTION_LANGUAGES);

  // 1 · Serviço de transcrição da instalação — escolha explícita.
  const servico = env.TRANSCRIPTION_API_KEY;
  if (servico) {
    // Com a chave do serviço na mão, `modeloDeTranscricaoEmVigor` devolve
    // exatamente o modelo que o transcriber abaixo vai mandar: o de
    // `TRANSCRIPTION_MODEL`, ou `whisper-1` quando vazio.
    const modelo = modeloDeTranscricaoEmVigor({
      model: env.TRANSCRIPTION_MODEL,
      apiKey: servico,
      baseUrl: env.TRANSCRIPTION_BASE_URL,
    });
    return {
      origem: "servico_da_instalacao",
      transcriber: apiTranscriptionProvider({
        apiKey: servico,
        baseUrl: env.TRANSCRIPTION_BASE_URL || undefined,
        model: env.TRANSCRIPTION_MODEL || undefined,
        languages: idiomas,
      }),
      motivo: MOTIVOS_DA_TRANSCRICAO.servicoDaInstalacao,
      anuncio: { provider: "openai", modelId: modelo },
    };
  }

  // 2 · Padrão OpenAI-compatível — o degrau de sempre, antes do modelo da
  //     organização para ninguém trocar de fornecedor numa atualização.
  const chaveOpenai = entrada.chaveOpenai ? await entrada.chaveOpenai() : null;
  if (chaveOpenai) {
    const modelo = modeloDeTranscricaoEmVigor({
      model: env.TRANSCRIPTION_MODEL,
      apiKey: env.TRANSCRIPTION_API_KEY,
      baseUrl: env.TRANSCRIPTION_BASE_URL,
    });
    return {
      origem: "padrao_openai_compativel",
      transcriber: apiTranscriptionProvider({
        apiKey: chaveOpenai,
        model: modelo,
        languages: idiomas,
      }),
      motivo: MOTIVOS_DA_TRANSCRICAO.chaveOpenai,
      anuncio: { provider: "openai", modelId: modelo },
    };
  }

  // 3 · Modelo de conversa da organização que declara a capacidade `audio`.
  const conversa = entrada.conversa;
  if (
    conversa?.apiKey &&
    conversa.modelId &&
    transcreveAudio(conversa.provider, conversa.modelId)
  ) {
    return {
      origem: "modelo_da_organizacao",
      transcriber: transcricaoPeloModelo({
        provider: conversa.provider,
        modelId: conversa.modelId,
        apiKey: conversa.apiKey,
        baseUrl: conversa.baseUrl ?? null,
        languages: idiomas,
      }),
      motivo: MOTIVOS_DA_TRANSCRICAO.modeloDaOrganizacao,
      // É ESTE anúncio — e não `whisper-1` — que a tela precisa mostrar quando
      // a organização não tem chave OpenAI (#2190).
      anuncio: { provider: conversa.provider, modelId: conversa.modelId },
    };
  }

  // 4 · Nada — e o motivo é do caso, não um "deu erro" genérico.
  const motivo = !conversa
    ? MOTIVOS_DA_TRANSCRICAO.semModeloDeConversa
    : conversa.modelId && !transcreveAudio(conversa.provider, conversa.modelId)
      ? MOTIVOS_DA_TRANSCRICAO.modeloSemAudio
      : MOTIVOS_DA_TRANSCRICAO.ninguem;
  return {
    origem: "nada",
    transcriber: null,
    motivo,
    // Sem quem transcreva não há modelo a anunciar: `modelId: null` é o que a
    // tela desenha como "—", ao lado do motivo. O `provider` repete o da
    // conversa (vazio quando ela não veio) só como etiqueta: o cartão de um
    // ponto fixo não o mostra nem o deixa editar, e ninguém chama esse
    // provedor para transcrever — anunciar um MODELO aqui é que recriaria, na
    // tela, a mentira que a #2190 veio matar.
    anuncio: { provider: conversa?.provider ?? "", modelId: null },
  };
}
