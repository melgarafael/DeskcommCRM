/**
 * Embedding de query para o RAG por tenant (F3-08; edge-contract §3 "RAG por tenant").
 *
 * PIN DE CONTRATO (inegociável): o vetor é computado com o MESMO modelo do indexador
 * do CRM — `text-embedding-3-small`, 1536 dimensões. Divergir de modelo/dimensão
 * quebra o recall SILENCIOSAMENTE (os vetores deixam de ser comparáveis), por isso a
 * dimensão é asserida a cada chamada. O modelo é knob (RAG_EMBEDDING_MODEL) só para
 * acompanhar uma futura troca do indexador do CRM — o default É o contrato.
 *
 * Por que aqui e não em run-model-call: embedding não é generateText (sem output
 * tokens, sem BYOK por org, sem enabled_models — é um modelo FIXO do contrato, com
 * chave server-side única na v1). Vive em edge/llm/ (CLAUDE.md regra dura 5 — SDK/
 * chamada de modelo só nesta camada) como um chamador HTTP mínimo, MESMO padrão do
 * count-tokens.ts: fetch nativo (egress em edge/, regra 5), sem SDK novo. A chave só
 * entra no header — nunca em log, erro ou contexto do modelo (regra dura 7).
 */

import { allowlistedFetch, buildAllowlist } from '../egress';
import type { Logger } from '../../obs/logger';

/** Dimensão do text-embedding-3-small — pin de contrato do CRM (edge-contract §3). */
export const RAG_EMBEDDING_DIMENSIONS = 1536;

export interface EmbedConfig {
  apiKey: string;
  /** id do modelo de embedding — default text-embedding-3-small (pin de contrato). */
  model: string;
  /** default: API pública da OpenAI; override para gateway compatível. */
  baseUrl?: string;
  timeoutMs: number;
  /** logger do evento de segurança de egress bloqueado (F4-03; opcional). */
  log?: Logger;
}

/**
 * Monta a config a partir do env validado (padrão crmEdgeConfigFromEnv). A chave é
 * opcional no boot — o daemon sobe sem RAG configurado; quem for embedar exige aqui,
 * com instrução.
 */
export function embedConfigFromEnv(env: {
  RAG_EMBEDDING_API_KEY?: string;
  RAG_EMBEDDING_MODEL: string;
  RAG_EMBEDDING_TIMEOUT_MS: number;
}): EmbedConfig {
  if (!env.RAG_EMBEDDING_API_KEY) {
    throw new Error(
      'RAG não configurado — defina RAG_EMBEDDING_API_KEY no .env (chave OpenAI do embedding, edge-contract §3/§4)',
    );
  }
  return {
    apiKey: env.RAG_EMBEDDING_API_KEY,
    model: env.RAG_EMBEDDING_MODEL,
    timeoutMs: env.RAG_EMBEDDING_TIMEOUT_MS,
  };
}

/** Falha de transporte/shape do embedding — transiente; nunca carrega a query nem a chave. */
export class EmbedError extends Error {
  readonly httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'EmbedError';
    this.httpStatus = httpStatus;
  }
}

/**
 * Embeda UMA query. Devolve o vetor de 1536 dims; qualquer divergência de dimensão
 * (modelo trocado sem casar o indexador do CRM) é ERRO — recall quebrado é pior que
 * chamada recusada. O corpo de erro da OpenAI é truncado e nunca embute a chave.
 */
export async function embedQuery(cfg: EmbedConfig, query: string): Promise<number[]> {
  const base = cfg.baseUrl ?? 'https://api.openai.com';
  let res: Response;
  try {
    // Egress só pelo cliente único com allowlist (F4-03): único destino legítimo é o
    // endpoint de embedding configurado (base); qualquer outro host falha closed.
    res = await allowlistedFetch(
      `${base}/v1/embeddings`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: cfg.model, input: query }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      },
      { allowlist: buildAllowlist([base]), ...(cfg.log ? { log: cfg.log } : {}) },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'fetch_failed';
    throw new EmbedError(`embedding falhou no transporte: ${reason}`);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new EmbedError(`embedding falhou (HTTP ${res.status}): ${detail}`, res.status);
  }
  const parsed = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const embedding = parsed.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new EmbedError('resposta de embedding sem vetor — shape da API mudou, re-validar');
  }
  if (embedding.length !== RAG_EMBEDDING_DIMENSIONS) {
    throw new EmbedError(
      `embedding com ${embedding.length} dims, esperado ${RAG_EMBEDDING_DIMENSIONS} (pin de contrato ${cfg.model}) — recall quebraria em silêncio`,
    );
  }
  return embedding;
}
