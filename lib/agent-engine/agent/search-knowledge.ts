/**
 * RAG no turno do engine.
 *
 * Desde a 0181 a busca é sobre os MATERIAIS que o agente pode ler
 * (`ai_agent_versions.knowledge_source_ids`), e não sobre uma versão de índice
 * escalar. Cada material aponta para o índice dele, então acrescentar um
 * documento não derruba a FAQ e reindexar a FAQ não derruba o catálogo — o que
 * acontecia enquanto havia um ponteiro só por agente.
 *
 * O caminho LEGADO (uma `kbVersionId`) continua aqui e é o que responde no clone
 * que ainda não aplicou a migration: a direção segura é seguir respondendo com o
 * acervo antigo, nunca emudecer a busca por causa de schema desatualizado.
 *
 * Erros viram ensino ao modelo, convenção do harness: `{ ok:false, error }` —
 * nunca exceção. Uma exceção mataria o turno e, do lado do cliente, o assistente
 * teria emudecido no meio da conversa.
 */
import type pg from 'pg';

import { embedText } from '@/lib/ai/embed';
import type { Citation } from '@/lib/ai/citations/types';
import type { Logger } from '../obs/logger';

export interface KnowledgeHit {
  chunk_id: string;
  knowledge_source_id: string | null;
  content: string;
  similarity: number;
  metadata: Record<string, unknown> | null;
  /** Nome do material de onde o trecho saiu. Ausente no caminho legado. */
  source_name?: string | null;
}

export type SearchKnowledgeResult =
  | { ok: true; results: KnowledgeHit[] }
  | { ok: false; error: { code: string; message: string } };

/** Piso real da similaridade de cosseno — `1 - distância`, com distância em [0,2]. */
const PISO_SIMILARIDADE = -1;

export async function searchKnowledge(
  pool: pg.Pool,
  args: {
    organizationId: string;
    /** Materiais que o agente pode ler. Vazio ⇒ cai no `kbVersionId` legado. */
    knowledgeSourceIds?: string[];
    /** LEGADO: uma versão de índice. Vale quando não há lista de materiais. */
    kbVersionId?: string | null;
    query: string;
    topK: number;
    threshold: number;
    /** Só para telemetria — opcional, os chamadores de hoje seguem válidos. */
    jobId?: string | null;
    /** Só para telemetria: QUAL assistente perguntou. */
    agentId?: string | null;
  },
  deps?: { embed?: typeof embedText; log?: Logger },
): Promise<SearchKnowledgeResult> {
  const embed = deps?.embed ?? embedText;
  const fontes = args.knowledgeSourceIds ?? [];
  const usaFontes = fontes.length > 0;

  if (!usaFontes && !args.kbVersionId) {
    return {
      ok: false,
      error: {
        code: 'no_knowledge_base',
        message:
          'este agente não tem material de consulta habilitado — responda com o que você já sabe e não invente fatos.',
      },
    };
  }

  try {
    const { embedding, model } = await embed(args.query, {
      organizationId: args.organizationId,
      ponto: 'embedding_consultar',
    });
    const vec = `[${embedding.join(',')}]`;

    // Pedimos ao banco SEM limiar (piso da similaridade) e cortamos aqui. O
    // conjunto entregue ao modelo é o mesmo — `order by` é por distância e o
    // `limit` vem depois do `where`, então os K melhores globais já são os K
    // melhores acima do limiar sempre que existirem K deles.
    //
    // O que ganhamos é o `top_score`: a similaridade do melhor candidato mesmo
    // quando ela não passa. Sem isso, "a base não tem essa informação" e "a base
    // tem e o corte está apertado demais" são indistinguíveis — e são problemas
    // com consertos opostos.
    const { rows } = usaFontes
      ? await pool.query<KnowledgeHit>(
          `select chunk_id, knowledge_source_id, source_name, content, similarity, metadata
           from fn_buscar_trechos_das_fontes($1, $2::uuid[], $3::vector, $4, $5, $6)`,
          [args.organizationId, fontes, vec, args.topK, PISO_SIMILARIDADE, model],
        )
      : await pool.query<KnowledgeHit>(
          `select chunk_id, knowledge_source_id, content, similarity, metadata
           from retrieve_top_k_chunks($1, $2, $3::vector, $4, $5)`,
          [args.organizationId, args.kbVersionId, vec, args.topK, PISO_SIMILARIDADE],
        );

    const results = rows.filter((r) => r.similarity >= args.threshold);
    // Sem depender da ordem das linhas. O `filter` descarta o NaN que o pgvector
    // devolve para chunk de embedding zerado — ele contaminaria o `Math.max` e
    // anularia o top_score de linhas BOAS na mesma busca. Sobra o array vazio,
    // cujo `Math.max()` é -Infinity: é o `Number.isFinite` abaixo que o
    // transforma em `null` — `numeric` aceitaria 'NaN' e envenenaria a coluna.
    const maiorScore = Math.max(...rows.map((r) => r.similarity).filter(Number.isFinite));
    const topScore = Number.isFinite(maiorScore) ? maiorScore : null;

    // Fire-and-forget: perder telemetria é infinitamente melhor que perder a
    // resposta ao cliente. O `threshold` gravado é o do CHAMADOR, nunca o piso
    // acima — gravar -1 faria toda busca parecer acima do limiar.
    //
    // Os parâmetros NOVOS entram no FIM, e não no meio: as posições 0..5 são o
    // contrato que `search-knowledge.test.ts` mede posicionalmente para pegar a
    // troca `threshold` ↔ piso. Enfiar um parâmetro no meio invalidaria a guarda
    // sem que ela ficasse vermelha por um motivo real.
    try {
      await pool.query(
        `insert into knowledge_searches
           (organization_id, job_id, kb_version_id, hits, top_score, threshold,
            knowledge_source_ids, agent_id)
         values ($1, $2, $3, $4, $5, $6, $7::uuid[], $8)`,
        [
          args.organizationId,
          args.jobId ?? null,
          args.kbVersionId ?? null,
          results.length,
          topScore,
          args.threshold,
          fontes,
          args.agentId ?? null,
        ],
      );
    } catch (err) {
      // Engolido de propósito — o `catch` externo transformaria isto em
      // `knowledge_unavailable` e o modelo diria ao cliente que a base caiu, por
      // causa de uma linha de telemetria.
      deps?.log?.warn('busca de conhecimento não registrada', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }

    return { ok: true, results };
  } catch (err) {
    // Falta de chave é ESTADO do tenant e merece uma frase própria: "a base caiu"
    // manda o operador procurar um incidente que não existe.
    const detalhe = err instanceof Error ? err.message : String(err);
    if (detalhe.includes('embedding_sem_chave') || /SemChaveDeEmbedding/.test(detalhe)) {
      return {
        ok: false,
        error: {
          code: 'knowledge_sem_chave',
          message:
            'a consulta ao material da empresa está desligada por falta de chave de IA — responda com o que você já sabe e não invente fatos.',
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'knowledge_unavailable',
        message:
          'a base de conhecimento está indisponível agora — responda com o que você já sabe e não invente fatos.',
      },
    };
  }
}

/** Shape que a UI do inbox já renderiza (CitationsPanel — lib/ai/citations/types). */
export function citationsFromHits(hits: KnowledgeHit[]): Citation[] {
  return hits.map((h) => ({
    chunk_id: h.chunk_id,
    knowledge_source_id: h.knowledge_source_id,
    score: h.similarity,
    snippet: h.content.slice(0, 240),
    ...(h.metadata !== null ? { metadata: h.metadata } : {}),
  }));
}
