/**
 * Embedding do RAG — indexação e busca, o mesmo modelo dos dois lados.
 *
 * A chave vem de `lib/ai/embeddings/chave.ts`, que resolve pela organização:
 * binding do ponto → credencial OpenAI/OpenRouter da org → gateway da instalação
 * → chave da instalação. Até a 0181 este arquivo lia SÓ `process.env`, e o efeito era o
 * pior possível para quem instala: cadastrar a chave da OpenAI pela tela não
 * habilitava a base de conhecimento, enquanto duas telas do produto prometiam
 * que sim.
 *
 * Duas entradas, UMA preparação. `embedText` embeda um texto; `embedTexts`
 * embeda uma lista numa chamada. A escolha da chave, do modelo, a régua do par
 * provedor×modelo e a asserção de dimensão são as mesmas nos dois caminhos de
 * propósito: se divergissem, metade do acervo nasceria com um vetor e a
 * consulta sairia com outro, e o recall quebraria sem erro nenhum.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";

import {
  DIMENSOES_DO_EMBEDDING,
  modeloDeEmbedding,
  resolverChaveDeEmbedding,
  type ChaveDeEmbedding,
  type PontoDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import { gatewayHeaders, type ModelId } from "@/lib/ai/gateway";
import { logger } from "@/lib/logger";
// O par (provedor, modelo): a mesma régua dos demais caminhos (issue #2377).
import { ParProvedorModeloInvalidoError, validarParProvedorModelo } from "@/lib/ai/par-provedor-modelo";

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

export interface EmbedManyResult {
  embeddings: number[][];
  promptTokens: number;
  model: string;
}

/** Falta de chave é um ESTADO do tenant, não um acidente: tipo próprio para quem
 *  chama poder mostrar a tela certa em vez de repetir um erro genérico. */
export class SemChaveDeEmbeddingError extends Error {
  readonly code = "embedding_sem_chave";
  constructor(readonly organizationId: string) {
    super(
      "Esta organização não tem chave de embedding para indexar nem consultar o material. " +
        "Cadastre uma chave OpenAI ou OpenRouter em Credenciais.",
    );
    this.name = "SemChaveDeEmbeddingError";
  }
}

/**
 * Tudo que as duas entradas decidem ANTES de chamar o provedor. Extraído para
 * que `embedText` e `embedTexts` não possam divergir numa régua.
 */
async function prepararEmbedding(opts: EmbedOptions) {
  const chave =
    opts.chave ?? (await resolverChaveDeEmbedding(opts.organizationId, opts.ponto));
  if (!chave) {
    throw new SemChaveDeEmbeddingError(opts.organizationId);
  }

  const modelId = String(opts.model ?? modeloDeEmbedding(chave.provedor));

  // O PAR ANTES DE INDEXAR OU CONSULTAR (issue #2377) — caminho de LEITURA,
  // que era justamente um dos que falhavam sozinhos. `chave.provedor` é quem
  // recebe a requisição (`"gateway"` não é fabricante, então a régua é
  // conservadora lá e o roteamento continua sendo do próprio gateway). Recusar
  // aqui é melhor que embedar com o par errado: metade da base criada com um
  // vetor e a consulta feita com outro é recall quebrado em silêncio.
  const parDeEmbedding = validarParProvedorModelo(chave.provedor, modelId);
  if (!parDeEmbedding.valido) {
    logger.warn("ia: par provedor+modelo recusado antes da chamada", {
      organization_id: opts.organizationId,
      purpose: opts.ponto,
      provider: chave.provedor,
      model: modelId,
      origem_da_configuracao: opts.chave ? "chave_resolvida_antes" : "chave_da_organizacao",
      motivo: parDeEmbedding.motivo,
    });
    throw new ParProvedorModeloInvalidoError(chave.provedor, modelId, parDeEmbedding.motivo, opts.ponto);
  }

  // COM gateway: a string `openai/text-embedding-3-small` é roteada por ele, que
  // lê `AI_GATEWAY_API_KEY` do process.env. Headers vão junto p/ observabilidade
  // por tenant + ZDR.
  //
  // SEM gateway: precisa ser um provider EXPLÍCITO. Passar a string com
  // barra aqui não cai no OpenAI direto — no AI SDK, id com barra é resolvido
  // pelo gateway da Vercel mesmo sem chave, entrando no plano anônimo, cujo teto
  // devolve `GatewayRateLimitError`. OpenAI direto usa id sem prefixo; OpenRouter
  // recebe o slug completo que a API de embeddings dela exige.
  const resolvido = chave.viaGateway
    ? modelId
    : chave.provedor === "google"
      ? createGoogleGenerativeAI({ apiKey: chave.apiKey ?? "" }).embeddingModel(
          modelId.replace(/^google\//, ""),
        )
      : createOpenAI({
        apiKey: chave.apiKey ?? "",
        ...(chave.baseUrl ? { baseURL: chave.baseUrl } : {}),
      }).textEmbeddingModel(
        chave.provedor === "openrouter" ? modelId : modelId.replace(/^openai\//, ""),
      );

  const headers = chave.viaGateway
    ? gatewayHeaders({ organizationId: opts.organizationId })
    : undefined;

  // O Gemini devolve 3072 dimensões por padrão; pedir 1536 é o que deixa a
  // coluna `vector(1536)` servir aos dois provedores sem migration. A busca é
  // por cosseno (`<=>`), então o vetor não normalizado dessa dimensão não
  // distorce a nota. O `taskType` é o par documento×pergunta do próprio Google.
  const extrasDoProvedor =
    chave.provedor === "google"
      ? {
          providerOptions: {
            google: {
              outputDimensionality: DIMENSOES_DO_EMBEDDING,
              taskType:
                opts.ponto === "embedding_consultar" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            },
          },
        }
      : {};

  return { modelId, resolvido, headers, extrasDoProvedor };
}

/**
 * Dimensão asserida a cada chamada: divergir de modelo quebra o recall em
 * SILÊNCIO (os vetores deixam de ser comparáveis), e uma chamada recusada é
 * infinitamente melhor que um acervo que responde errado com nota alta.
 */
function conferirDimensao(embedding: number[], modelId: string): void {
  if (embedding.length !== DIMENSOES_DO_EMBEDDING) {
    throw new Error(
      `embedding com ${embedding.length} dimensões, esperado ${DIMENSOES_DO_EMBEDDING} ` +
        `(pin de contrato ${modelId}) — recall quebraria em silêncio`,
    );
  }
}

function tokensDoUso(usage: unknown): number {
  const u = usage as { tokens?: number; promptTokens?: number } | undefined;
  return u?.tokens ?? u?.promptTokens ?? 0;
}

export async function embedText(
  content: string,
  opts: EmbedOptions,
): Promise<EmbedResult> {
  const { modelId, resolvido, headers, extrasDoProvedor } = await prepararEmbedding(opts);

  const result = await embed({
    model: resolvido,
    value: content,
    headers,
    ...extrasDoProvedor,
  });

  conferirDimensao(result.embedding, modelId);

  return { embedding: result.embedding, promptTokens: tokensDoUso(result.usage), model: modelId };
}

/**
 * Vários textos numa chamada, para quem indexa em volume.
 *
 * Existe porque o laço de um-a-um era o teto real da indexação, e não a API da
 * loja: a 200-400 ms por pedaço, um catálogo de mil produtos passava da janela
 * de 10 minutos que o reaper do drain usa para devolver evento à fila — e o
 * efeito não era carga lenta, era DOIS workers indexando a mesma fonte, com o
 * embedding pago em dobro e corrida na ativação da versão.
 *
 * `embedMany` já divide a lista conforme o limite do provedor e paraleliza as
 * partes, então quem chama manda o lote inteiro e não precisa saber do limite
 * de cada API.
 */
export async function embedTexts(
  contents: string[],
  opts: EmbedOptions,
): Promise<EmbedManyResult> {
  // A lista vazia sai sem chamar o provedor, mas DEPOIS de preparar: num
  // arquivo cujo contrato é recusar em vez de seguir no escuro, o atalho não
  // pode ser a única porta que passa sem conferir chave e par provedor×modelo.
  const { modelId, resolvido, headers, extrasDoProvedor } = await prepararEmbedding(opts);

  if (contents.length === 0) {
    return { embeddings: [], promptTokens: 0, model: modelId };
  }

  const result = await embedMany({
    model: resolvido,
    values: contents,
    headers,
    ...extrasDoProvedor,
  });

  // Um vetor por texto, na ordem. Sem esta conta, quem chama gravaria o
  // embedding de um pedaço na linha de outro — acervo errado respondendo com
  // nota alta, que é o pior modo de falhar que este arquivo tem.
  if (result.embeddings.length !== contents.length) {
    throw new Error(
      `embedding em lote devolveu ${result.embeddings.length} vetores para ${contents.length} textos ` +
        `(modelo ${modelId}) — a ordem deixaria de casar com os trechos`,
    );
  }
  for (const embedding of result.embeddings) {
    conferirDimensao(embedding, modelId);
  }

  return {
    embeddings: result.embeddings,
    promptTokens: tokensDoUso(result.usage),
    model: modelId,
  };
}
