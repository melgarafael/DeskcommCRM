import { beforeEach, describe, expect, it, vi } from "vitest";
import { processRagIndexer } from "@/workers/rag-indexer";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedText } from "@/lib/ai/embed";
import { resolverChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import { acquireDebounce } from "@/lib/ai/rag/debounce";
import { computeContentHash } from "@/lib/ai/rag/chunker";
import { createKnowledgeVersion } from "@/lib/ai/rag/version";

/**
 * "PREPARAR TUDO DE NOVO" NÃO REEMBEDA O QUE NÃO MUDOU (recorte do #1130, @vgamkt).
 *
 * O caminho: o indexador calcula o hash do conteúdo que ia indexar e compara
 * com `ai_knowledge_sources.content_hash` (0409). Igual + `success` + versão
 * ativa no MESMO modelo de embedding = pula, sem criar versão nem chamar o
 * provedor. E o pulo RESTAURA `success` — limpar para null faria o material
 * pronto parecer "nunca indexado" na tela.
 *
 * Os controles negativos são o que prova que a condição não é "pula sempre":
 * conteúdo mudado ou modelo diferente reindexam.
 */

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/embed", () => ({
  embedText: vi.fn(),
  SemChaveDeEmbeddingError: class SemChaveDeEmbeddingError extends Error {},
}));
vi.mock("@/lib/ai/embeddings/chave", () => ({
  resolverChaveDeEmbedding: vi.fn(),
  MODELO_DE_EMBEDDING: "openai/text-embedding-3-small",
}));
vi.mock("@/lib/ai/rag/debounce", () => ({ acquireDebounce: vi.fn() }));
vi.mock("@/lib/ai/rag/ingest/documento", () => ({
  extrairTextoDoArquivo: vi.fn(),
  ErroDeExtracao: class ErroDeExtracao extends Error {},
}));
vi.mock("@/lib/ai/rag/version", () => ({
  createKnowledgeVersion: vi.fn(),
  markVersionReady: vi.fn(),
  markVersionFailed: vi.fn(),
  activateVersion: vi.fn(),
}));

const FAQ = [{ question: "Qual o prazo?", answer: "Cinco dias úteis." }];

const EVENTO = {
  id: "ev-1",
  organization_id: "org-1",
  event_type: "knowledge_source.updated",
  entity_kind: "ai_knowledge_source",
  entity_id: "ks-1",
  payload: { knowledge_source_id: "ks-1" },
  metadata: {},
  created_at: new Date().toISOString(),
};

let fonte: Record<string, unknown>;
let modeloDaVersaoAtiva: string;
let carimbos: Array<Record<string, unknown>> = [];

function fonteBase(): Record<string, unknown> {
  return {
    id: "ks-1",
    organization_id: "org-1",
    agent_id: null,
    source_type: "faq",
    name: "FAQ da loja",
    status: "ready",
    is_active: true,
    source_metadata: null,
    content_hash: null,
    last_index_status: null,
    active_kb_version_id: null,
  };
}

/** Roda uma indexação completa e devolve o hash que ela gravou na fonte. */
async function indexarUmaVez(): Promise<string> {
  await processRagIndexer(EVENTO as never);
  const sucesso = carimbos.find((c) => c["last_index_status"] === "success");
  expect(sucesso?.["content_hash"], "a indexação grava o hash do conteúdo").toEqual(expect.any(String));
  return sucesso!["content_hash"] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  fonte = fonteBase();
  modeloDaVersaoAtiva = "openai/text-embedding-3-small";
  carimbos = [];

  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      const leitura = (dado: () => unknown) => {
        const cadeia = {
          select: () => cadeia,
          eq: () => cadeia,
          order: () => Promise.resolve({ data: dado(), error: null }),
          maybeSingle: () => Promise.resolve({ data: dado(), error: null }),
        };
        return cadeia;
      };
      if (tabela === "ai_knowledge_sources") {
        return {
          ...leitura(() => fonte),
          update: (campos: Record<string, unknown>) => {
            carimbos.push(campos);
            const escrita = { eq: () => escrita, then: (ok: (v: unknown) => void) => ok({ error: null }) };
            return escrita;
          },
        };
      }
      if (tabela === "ai_faq_items") return leitura(() => FAQ);
      if (tabela === "ai_knowledge_versions") return leitura(() => ({ embedding_model: modeloDaVersaoAtiva }));
      if (tabela === "ai_chunks") return { upsert: () => Promise.resolve({ error: null }) };
      throw new Error(`tabela não dublada no teste: ${tabela}`);
    },
  } as never);

  vi.mocked(acquireDebounce).mockResolvedValue(true as never);
  vi.mocked(resolverChaveDeEmbedding).mockResolvedValue({ origem: "org" } as never);
  vi.mocked(embedText).mockResolvedValue({ embedding: [0.1, 0.2] } as never);
  vi.mocked(createKnowledgeVersion).mockResolvedValue({ versionId: "v-1", versionNumber: 1 } as never);
});

describe("rag-indexer — pulo incremental por hash do conteúdo", () => {
  it("conteúdo igual, já pronto e no mesmo modelo: pula, sem versão nem embedding, e mantém `success`", async () => {
    const hash = await indexarUmaVez();
    fonte = { ...fonteBase(), content_hash: hash, last_index_status: "success", active_kb_version_id: "v-1" };
    carimbos = [];
    vi.mocked(createKnowledgeVersion).mockClear();
    vi.mocked(embedText).mockClear();

    const r = await processRagIndexer(EVENTO as never);

    expect(r).toMatchObject({ status: "skipped", detail: "sem_mudanca" });
    expect(createKnowledgeVersion).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
    expect(carimbos.at(-1)).toEqual({ last_index_status: "success" });
  });

  it("controle: o hash gravado é o do conteúdo — não um valor constante", async () => {
    const hash = await indexarUmaVez();
    expect(hash).toBe(computeContentHash("Pergunta: Qual o prazo?\nResposta: Cinco dias úteis."));
  });

  it("conteúdo mudou: reindexa", async () => {
    fonte = { ...fonteBase(), content_hash: "hash-de-outro-conteudo", last_index_status: "success", active_kb_version_id: "v-1" };

    const r = await processRagIndexer(EVENTO as never);

    expect(r.status).toBe("ok");
    expect(createKnowledgeVersion).toHaveBeenCalledTimes(1);
  });

  it("mesmo conteúdo, mas a versão ativa é de OUTRO modelo: reindexa", async () => {
    const hash = await indexarUmaVez();
    fonte = { ...fonteBase(), content_hash: hash, last_index_status: "success", active_kb_version_id: "v-1" };
    modeloDaVersaoAtiva = "google/gemini-embedding-001";
    vi.mocked(createKnowledgeVersion).mockClear();

    const r = await processRagIndexer(EVENTO as never);

    expect(r.status).toBe("ok");
    expect(createKnowledgeVersion).toHaveBeenCalledTimes(1);
  });

  it("mesmo conteúdo, mas a última indexação falhou: reindexa", async () => {
    const hash = await indexarUmaVez();
    fonte = { ...fonteBase(), content_hash: hash, last_index_status: "failed", active_kb_version_id: "v-1" };
    vi.mocked(createKnowledgeVersion).mockClear();

    const r = await processRagIndexer(EVENTO as never);

    expect(r.status).toBe("ok");
    expect(createKnowledgeVersion).toHaveBeenCalledTimes(1);
  });
});
