/**
 * Recall híbrido das notas do lead (F3-06; blueprint 1.6 / órgão 2). Combina, POR
 * NOTA do lead:
 *   - BM25: FTS nativo do Postgres (to_tsvector/ts_rank, config 'simple' — preserva
 *     tokens exatos como códigos de pedido/valores, que a stemming em inglês mutilaria).
 *     Zero chamada externa, determinístico. É o que recupera "PED-12345" por token
 *     exato mesmo sem similaridade semântica.
 *   - vetorial: cosseno entre o embedding da query e o da nota (paráfrase). O embedding
 *     é uma DEPENDÊNCIA INJETADA (EmbedFn): os testes usam vetores-fixture
 *     determinísticos; produção roteia por edge/llm (provider-agnóstico, BYOK). O vetor
 *     por nota é persistido em lead_notes.embedding (migration 0016), populado
 *     preguiçosamente aqui — embed roda 1× por nota, não a cada recall.
 *   - decay temporal: meia-vida configurável (default 30d) — peso = 0.5^(idade/meia-vida).
 *     Sinal recente do lead vence sinal velho de score-base igual.
 *   - MMR: reranking por relevância × diversidade (λ configurável) contra os já escolhidos.
 *
 * Isolamento (regra dura nº 1 + blueprint 6.7): TODA query é escopada por
 * (tenant_id, lead_id) de FONTE CONFIÁVEL (o runtime, nunca o payload). O filtro é
 * determinístico na camada de query — jamais delegado ao LLM. Nota de um lead nunca
 * entra no recall de outro lead/tenant.
 *
 * Knobs, nunca constantes: meia-vida, λ do MMR, top-K e os pesos BM25×vetorial vêm de
 * config (env → recallConfigFromEnv). PII: headline/body são o conteúdo recuperado (é
 * o ponto), mas nunca vão a log estruturado aqui.
 */
import type { Queryable } from '../queue/queue';

/**
 * Embedding em LOTE: recebe [query, ...textos de nota] e devolve os vetores na MESMA
 * ordem e comprimento. Injetada — o seam provider-agnóstico (edge/llm) em produção,
 * fixture nos testes. Uma única chamada por recall.
 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface RecallConfig {
  /** meia-vida do decay em dias (default doutrina: 30). */
  halfLifeDays: number;
  /** λ do MMR em [0,1]: 1 = só relevância, 0 = só diversidade. */
  mmrLambda: number;
  /** teto de notas retornadas. */
  topK: number;
  /** peso do componente BM25 no score-base. */
  bm25Weight: number;
  /** peso do componente vetorial no score-base. */
  vectorWeight: number;
}

export interface RecalledNote {
  id: string;
  headline: string;
  body: string;
  createdAt: Date;
  /** rank BM25 normalizado [0,1] (dividido pelo máximo do conjunto do lead). */
  bm25: number;
  /** cosseno query×nota, clampado a [0,1]. */
  similarity: number;
  /** bm25Weight·bm25 + vectorWeight·similarity. */
  baseScore: number;
  /** 0.5^(idadeDias/halfLifeDays), clampado a ≤1 (nota "futura" não ganha bônus). */
  decay: number;
  /** relevância final usada pelo MMR: baseScore·decay. */
  score: number;
}

interface CandidateRow {
  id: string;
  headline: string;
  body: string;
  created_at: Date;
  embedding: number[] | null;
  bm25: number;
}

const MS_PER_DAY = 86_400_000;

/** Cosseno; vetor nulo (ou dimensões incompatíveis) ⇒ 0, nunca NaN. */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function noteText(headline: string, body: string): string {
  return `${headline}\n${body}`;
}

interface Scored extends RecalledNote {
  vector: number[];
}

/**
 * Recupera as notas mais relevantes do lead para `query`, já rerankeadas por MMR.
 * `now` é injetado (clock) para o decay ser determinístico nos testes.
 */
export async function recallLeadNotes(
  db: Queryable,
  ids: { tenantId: string; leadId: string },
  query: string,
  embed: EmbedFn,
  cfg: RecallConfig,
  now: Date,
): Promise<RecalledNote[]> {
  // Escopo (tenant_id, lead_id) na PRÓPRIA query — o isolamento é da camada de dados.
  // ts_rank da config 'simple' (sem stemming) preserva IDs/códigos exatos.
  const { rows } = await db.query<CandidateRow>(
    `select id, headline, body, created_at, embedding,
            ts_rank(
              to_tsvector('simple', headline || ' ' || body),
              websearch_to_tsquery('simple', $3)
            ) as bm25
       from lead_notes
      where tenant_id = $1 and lead_id = $2`,
    [ids.tenantId, ids.leadId, query],
  );
  if (rows.length === 0) {
    return [];
  }

  // Embedding: query + notas ainda sem vetor persistido, numa única chamada em lote.
  const missing = rows.filter((r) => r.embedding === null);
  const texts = [query, ...missing.map((r) => noteText(r.headline, r.body))];
  const embedded = await embed(texts);
  if (embedded.length !== texts.length) {
    throw new Error('embed retornou um número de vetores diferente do solicitado');
  }
  const queryVec = embedded[0]!;
  const freshByNoteId = new Map<string, number[]>();
  missing.forEach((r, i) => freshByNoteId.set(r.id, embedded[i + 1]!));

  // Persiste os vetores recém-computados (write-once: notas não têm UPDATE de body,
  // então o cache nunca fica stale). Escopado por (tenant, lead, id).
  for (const [noteId, vec] of freshByNoteId) {
    await db.query(
      `update lead_notes set embedding = $4
        where tenant_id = $1 and lead_id = $2 and id = $3`,
      [ids.tenantId, ids.leadId, noteId, JSON.stringify(vec)],
    );
  }

  // Normaliza o BM25 pelo máximo do conjunto do lead → [0,1] comparável ao cosseno.
  const maxBm25 = Math.max(0, ...rows.map((r) => r.bm25));
  const nowMs = now.getTime();

  const scored: Scored[] = rows.map((r) => {
    const vector = r.embedding ?? freshByNoteId.get(r.id) ?? [];
    const bm25 = maxBm25 > 0 ? r.bm25 / maxBm25 : 0;
    const similarity = Math.max(0, cosine(queryVec, vector));
    const baseScore = cfg.bm25Weight * bm25 + cfg.vectorWeight * similarity;
    const ageDays = Math.max(0, (nowMs - r.created_at.getTime()) / MS_PER_DAY);
    const decay = Math.pow(0.5, ageDays / cfg.halfLifeDays);
    return {
      id: r.id,
      headline: r.headline,
      body: r.body,
      createdAt: r.created_at,
      bm25,
      similarity,
      baseScore,
      decay,
      score: baseScore * decay,
      vector,
    };
  });

  return mmrSelect(scored, cfg).map((s) => ({
    id: s.id,
    headline: s.headline,
    body: s.body,
    createdAt: s.createdAt,
    bm25: s.bm25,
    similarity: s.similarity,
    baseScore: s.baseScore,
    decay: s.decay,
    score: s.score,
  }));
}

/**
 * Maximal Marginal Relevance: escolhe iterativamente a nota que maximiza
 * λ·score − (1−λ)·max(cosseno com as já escolhidas). Determinístico: empate de MMR
 * desempata por score, depois nota mais recente, depois id.
 */
function mmrSelect(items: Scored[], cfg: RecallConfig): Scored[] {
  const remaining = [...items];
  const selected: Scored[] = [];
  while (selected.length < cfg.topK && remaining.length > 0) {
    let best: Scored | null = null;
    let bestMmr = 0;
    let bestIdx = -1;
    for (let i = 0; i < remaining.length; i += 1) {
      const cand = remaining[i]!;
      const maxSim =
        selected.length === 0 ? 0 : Math.max(...selected.map((s) => cosine(cand.vector, s.vector)));
      const mmr = cfg.mmrLambda * cand.score - (1 - cfg.mmrLambda) * maxSim;
      if (best === null || betterThan(cand, mmr, best, bestMmr)) {
        best = cand;
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    selected.push(best!);
    remaining.splice(bestIdx, 1);
  }
  return selected;
}

/** Ordem total determinística: MMR desc → score desc → mais recente → id asc. */
function betterThan(a: Scored, aMmr: number, b: Scored, bMmr: number): boolean {
  if (aMmr !== bMmr) return aMmr > bMmr;
  if (a.score !== b.score) return a.score > b.score;
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) return at > bt;
  return a.id < b.id;
}

/** Monta a config de recall a partir do env validado (knobs, nunca constantes). */
export function recallConfigFromEnv(env: {
  LEAD_RECALL_HALF_LIFE_DAYS: number;
  LEAD_RECALL_MMR_LAMBDA: number;
  LEAD_RECALL_TOP_K: number;
  LEAD_RECALL_BM25_WEIGHT: number;
  LEAD_RECALL_VECTOR_WEIGHT: number;
}): RecallConfig {
  return {
    halfLifeDays: env.LEAD_RECALL_HALF_LIFE_DAYS,
    mmrLambda: env.LEAD_RECALL_MMR_LAMBDA,
    topK: env.LEAD_RECALL_TOP_K,
    bm25Weight: env.LEAD_RECALL_BM25_WEIGHT,
    vectorWeight: env.LEAD_RECALL_VECTOR_WEIGHT,
  };
}
