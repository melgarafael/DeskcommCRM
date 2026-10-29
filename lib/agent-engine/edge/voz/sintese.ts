/**
 * Síntese de voz da resposta da IA — Google Cloud Text-to-Speech.
 *
 * Só existe para um caso: o cliente pediu áudio, ou disse que não consegue ler
 * (`agent/resposta-em-audio.ts` decide). Por isso o desenho é o mais barato que
 * resolve o problema, e não o mais bonito:
 *
 *   - **Só voz `pt-BR-Standard-*` (`./vozes.ts`).** A família Standard é a de
 *     menor preço da API; WaveNet, Neural2, Chirp e Gemini-TTS custam várias
 *     vezes mais e NÃO passam por aqui — outro nome é recusado como
 *     configuração inválida (a resposta sai em texto), nunca promovido em
 *     silêncio a uma voz mais cara.
 *   - **`OGG_OPUS` direto da API.** É o formato que a nota de voz do WhatsApp
 *     aceita (`lib/messaging/media/voice-transcode.ts`, `VOICE_MIME`): nada de
 *     ffmpeg, nada de conversão no caminho do turno.
 *   - **Chave em cabeçalho (`X-Goog-Api-Key`), nunca na URL.** API key em query
 *     string vaza em log de proxy (anti-pattern 12 do `CLAUDE.md`). A chave vem
 *     da credencial cifrada da organização (`./credencial.ts`) ou, como reserva
 *     da instalação, de `GOOGLE_TTS_API_KEY` — e não entra em log, erro nem
 *     contexto do modelo: o erro carrega só um código e o status HTTP.
 *   - **Egress pela allowlist do runtime** (`../egress.ts`), com o host fixo da
 *     API — o mesmo caminho de todo HTTP do agent-engine.
 *
 * Nunca devolve áudio vazio: resposta sem `audioContent`, ou com zero bytes, é
 * erro. Quem chama trata todo erro como "manda em texto".
 */
import { z } from 'zod';

import { allowlistedFetch, buildAllowlist } from '../egress';
import type { Logger } from '../../obs/logger';
import { ehVozAceita, VOZ_PADRAO, vozesAceitasDaLista, type VozDisponivel } from './vozes';

export { VOZ_PADRAO } from './vozes';

export const ENDPOINT_DA_SINTESE = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/** A lista de vozes, já filtrada por idioma. O idioma é fixo: nada do navegador entra na URL. */
export const ENDPOINT_DAS_VOZES = 'https://texttospeech.googleapis.com/v1/voices?languageCode=pt-BR';

/**
 * Teto do texto enviado à API, em BYTES (UTF-8). O limite da API é 5000 bytes
 * por requisição; a folga cobre o que a normalização não prevê. Acima disto a
 * resposta é longa demais para um áudio que alguém queira ouvir — sai em texto.
 */
export const MAX_BYTES_DO_TEXTO = 4500;

const TIMEOUT_MS = 15_000;

export type CodigoDeFalhaDaVoz =
  | 'nao_configurada'
  | 'voz_nao_permitida'
  | 'texto_vazio'
  | 'texto_longo'
  | 'rede'
  | 'http'
  | 'resposta_invalida'
  | 'audio_vazio';

/** Falha da síntese. A mensagem nunca carrega chave, texto do cliente nem URL. */
export class FalhaDaVoz extends Error {
  override readonly name = 'falha_da_voz';
  readonly code: CodigoDeFalhaDaVoz;
  readonly status: number | null;
  constructor(code: CodigoDeFalhaDaVoz, status: number | null = null) {
    super(status === null ? `voz: ${code}` : `voz: ${code} (${status})`);
    this.code = code;
    this.status = status;
  }
}

export interface ConfigDaVoz {
  apiKey: string;
  voz: string;
}

/**
 * Lê a configuração do ambiente — a RESERVA da instalação, abaixo da credencial
 * da organização (`./credencial.ts`). Sem chave = recurso desligado na
 * instalação (`nao_configurada`); voz fora de `./vozes.ts` = configuração
 * inválida (`voz_nao_permitida`). Vazio na voz vale o padrão.
 */
export function configDaVoz(
  ambiente: { GOOGLE_TTS_API_KEY?: string; GOOGLE_TTS_VOICE?: string },
):
  | { ok: true; config: ConfigDaVoz }
  | { ok: false; code: 'nao_configurada' | 'voz_nao_permitida' } {
  const apiKey = (ambiente.GOOGLE_TTS_API_KEY ?? '').trim();
  if (apiKey === '') return { ok: false, code: 'nao_configurada' };
  const voz = (ambiente.GOOGLE_TTS_VOICE ?? '').trim() || VOZ_PADRAO;
  if (!ehVozAceita(voz)) return { ok: false, code: 'voz_nao_permitida' };
  return { ok: true, config: { apiKey, voz } };
}

/** Texto → bytes OGG/Opus. Lança `FalhaDaVoz` em qualquer desfecho sem áudio. */
export type Sintetizar = (texto: string) => Promise<Buffer>;

const respostaSchema = z.object({ audioContent: z.string().min(1) });

export function criarSintetizador(
  config: ConfigDaVoz,
  deps: { fetchImpl?: typeof fetch; log?: Logger; timeoutMs?: number } = {},
): Sintetizar {
  const allowlist = buildAllowlist([ENDPOINT_DA_SINTESE]);
  return async (texto) => {
    const limpo = texto.trim();
    if (limpo === '') throw new FalhaDaVoz('texto_vazio');
    if (Buffer.byteLength(limpo, 'utf8') > MAX_BYTES_DO_TEXTO) throw new FalhaDaVoz('texto_longo');

    let res: Response;
    try {
      res = await allowlistedFetch(
        ENDPOINT_DA_SINTESE,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
          body: JSON.stringify({
            input: { text: limpo },
            voice: { languageCode: 'pt-BR', name: config.voz },
            audioConfig: { audioEncoding: 'OGG_OPUS' },
          }),
          signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
        },
        { allowlist, ...(deps.log ? { log: deps.log } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
      );
    } catch {
      // A causa (DNS, timeout, egress) fica fora da mensagem de propósito: o
      // erro de rede do Node pode ecoar a requisição.
      throw new FalhaDaVoz('rede');
    }
    if (!res.ok) throw new FalhaDaVoz('http', res.status);

    const corpo = respostaSchema.safeParse(await res.json().catch(() => null));
    if (!corpo.success) throw new FalhaDaVoz('resposta_invalida');
    const audio = Buffer.from(corpo.data.audioContent, 'base64');
    if (audio.length === 0) throw new FalhaDaVoz('audio_vazio');
    return audio;
  };
}

/**
 * As vozes pt-BR Standard (`./vozes.ts`) que esta chave enxerga. Serve também de
 * TESTE da chave: é a chamada mais barata da API (não sintetiza nada). Lança
 * `FalhaDaVoz` com código e status — nunca com a chave, a URL ou o corpo.
 */
export async function listarVozesPtBr(
  apiKey: string,
  deps: { fetchImpl?: typeof fetch; log?: Logger; timeoutMs?: number } = {},
): Promise<VozDisponivel[]> {
  const chave = apiKey.trim();
  if (chave === '') throw new FalhaDaVoz('nao_configurada');
  let res: Response;
  try {
    res = await allowlistedFetch(
      ENDPOINT_DAS_VOZES,
      {
        method: 'GET',
        headers: { 'x-goog-api-key': chave },
        signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
      },
      {
        allowlist: buildAllowlist([ENDPOINT_DAS_VOZES]),
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      },
    );
  } catch {
    throw new FalhaDaVoz('rede');
  }
  if (!res.ok) throw new FalhaDaVoz('http', res.status);
  const corpo: unknown = await res.json().catch(() => null);
  if (corpo === null || typeof corpo !== 'object') throw new FalhaDaVoz('resposta_invalida');
  return vozesAceitasDaLista(corpo);
}
