/**
 * Embedding do RAG — indexação e busca, o mesmo modelo dos dois lados.
 *
 * A chave vem de `lib/ai/embeddings/chave.ts`, que resolve pela organização:
 * binding do ponto → credencial OpenAI da org → gateway da instalação → chave
 * da instalação. Até a 0181 este arquivo lia SÓ `process.env`, e o efeito era o
 * pior possível para quem instala: cadastrar a chave da OpenAI pela tela não
 * habilitava a base de conhecimento, enquanto duas telas do produto prometiam
 * que sim.
 */

import { runMeteredOperation } from "@/lib/billing/metered-operation";
import { createOpenAI } from "@ai-sdk/openai";
import { embed } from "ai";

import {
  DIMENSOES_DO_EMBEDDING,
  MODELO_DE_EMBEDDING,
  resolverChaveDeEmbedding,
  type ChaveDeEmbedding,
  type PontoDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import { gatewayHeaders, type ModelId } from "@/lib/ai/gateway";

export interface EmbedOptions {
  organizationId: string;
  /**
   * Qual ponto de IA está chamando. Muda apenas de QUAL binding a chave sai —
   * o modelo é o mesmo por contrato, e divergir quebraria o recall em silêncio.
   */
  ponto?: PontoDeEmbedding;
  /**
   * Chave já resolvida. Existe para o indexador resolver UMA vez e embedar N
   * chunks: sem isto, indexar um documento de 200 trechos decifraria a
   * credencial 200 vezes.
   */
  chave?: ChaveDeEmbedding;
  model?: ModelId;
}

export interface EmbedResult {
  embedding: number[];
  promptTokens: number;
  model: string;
}

/** Falta de chave é um ESTADO do tenant, não um acidente: tipo próprio para quem
 *  chama poder mostrar a tela certa em vez de repetir um erro genérico. */
export class SemChaveDeEmbeddingError extends Error {
  readonly code = "embedding_sem_chave";
  constructor(readonly organizationId: string) {
    super(
      "Esta organização não tem chave da OpenAI para indexar nem consultar o material. " +
        "Cadastre uma em Credenciais, ou defina OPENAI_API_KEY na instalação.",
    );
    this.name = "SemChaveDeEmbeddingError";
  }
}

export async function embedText(
  content: string,
  opts: EmbedOptions,
): Promise<EmbedResult> {
  const chave =
    opts.chave ?? (await resolverChaveDeEmbedding(opts.organizationId, opts.ponto));
  if (!chave) {
    throw new SemChaveDeEmbeddingError(opts.organizationId);
  }

  const modelId = String(opts.model ?? MODELO_DE_EMBEDDING);

  // COM gateway: a string `openai/text-embedding-3-small` é roteada por ele, que
  // lê `AI_GATEWAY_API_KEY` do process.env. Headers vão junto p/ observabilidade
  // por tenant + ZDR.
  //
  // SEM gateway: precisa ser o provider OpenAI EXPLÍCITO. Passar a string com
  // barra aqui não cai no OpenAI direto — no AI SDK, id com barra é resolvido
  // pelo gateway da Vercel mesmo sem chave, entrando no plano anônimo, cujo teto
  // devolve `GatewayRateLimitError` e derruba a busca na base de conhecimento.
  const resolvido = chave.viaGateway
    ? modelId
    : createOpenAI({
        apiKey: chave.apiKey ?? "",
        ...(chave.baseUrl ? { baseURL: chave.baseUrl } : {}),
      }).textEmbeddingModel(modelId.replace(/^openai\//, ""));

  const result = await runMeteredOperation(
    { organizationId: opts.organizationId, provider: "openai", model: modelId },
    () => embed({
      model: resolvido,
      value: content,
      headers: chave.viaGateway
        ? gatewayHeaders({ organizationId: opts.organizationId })
        : undefined,
    }),
    (response) => {
      const tokens = (response.usage as { tokens?: number; promptTokens?: number } | undefined)?.tokens
        ?? (response.usage as { promptTokens?: number } | undefined)?.promptTokens;
      return tokens === undefined ? null : { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
  );

  // Dimensão asserida a cada chamada: divergir de modelo quebra o recall em
  // SILÊNCIO (os vetores deixam de ser comparáveis), e uma chamada recusada é
  // infinitamente melhor que um acervo que responde errado com nota alta.
  if (result.embedding.length !== DIMENSOES_DO_EMBEDDING) {
    throw new Error(
      `embedding com ${result.embedding.length} dimensões, esperado ${DIMENSOES_DO_EMBEDDING} ` +
        `(pin de contrato ${modelId}) — recall quebraria em silêncio`,
    );
  }

  // EmbedResult.embedding is `number[]` for single-value embed.
  const promptTokens =
    (result.usage as { tokens?: number; promptTokens?: number } | undefined)?.tokens ??
    (result.usage as { tokens?: number; promptTokens?: number } | undefined)?.promptTokens ??
    0;

  return { embedding: result.embedding, promptTokens, model: modelId };
}
