import { beforeEach, describe, expect, it, vi } from "vitest";
import { indexarFonte } from "@/workers/rag-indexer";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedText } from "@/lib/ai/embed";
import {
  activateVersion,
  createKnowledgeVersion,
  markVersionFailed,
  markVersionReady,
} from "@/lib/ai/rag/version";

/**
 * FALHA PARCIAL NÃO ATIVA VERSÃO (issue #675).
 *
 * O caminho medido: numa FAQ com dois trechos, o upsert do segundo voltava com
 * `error` e isso só virava `console.warn`. Como `gravados` era 1 (> 0), o fim do
 * laço chamava `markVersionReady` + `activateVersion`, e o índice entrava no ar
 * com um buraco — quem perguntasse exatamente o que faltou recebia "não sei",
 * com a versão carimbada como pronta. O aviso só existia quando NADA gravava.
 *
 * O contrato que estes testes travam: qualquer trecho não gravado é falha
 * explícita — `markVersionFailed` com o motivo, retorno `tipo: "erro"`, detalhe
 * `trechos_nao_gravados:N` (ou o `nenhum_trecho_gravado` de sempre quando não
 * gravou nenhum), e nem `markVersionReady` nem `activateVersion` são chamados,
 * então a versão anterior segue ativa.
 */

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/embed", () => ({
  embedText: vi.fn(),
  SemChaveDeEmbeddingError: class SemChaveDeEmbeddingError extends Error {},
}));
vi.mock("@/lib/ai/embeddings/chave", () => ({ resolverChaveDeEmbedding: vi.fn() }));
vi.mock("@/lib/ai/rag/debounce", () => ({ acquireDebounce: vi.fn() }));
// O documento puxa os extratores (pdf); o caminho exercitado aqui é o de FAQ.
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

const FONTE = {
  id: "ks-1",
  organization_id: "org-1",
  agent_id: null,
  source_type: "faq",
  name: "FAQ da loja",
  status: "ready",
  is_active: true,
  source_metadata: null,
};

const CHAVE = { origem: "org" };

const FAQ = [
  { question: "Qual o prazo?", answer: "Cinco dias úteis." },
  { question: "Tem frete grátis?", answer: "Acima de cem reais." },
];

/** Mensagem de erro do upsert para cada posição; `null` = grava. */
let falhaDeUpsert: (posicao: number) => string | null = () => null;
/** Posições em que o `embedText` rejeita. */
let falhaDeEmbed: Set<number> = new Set();

beforeEach(() => {
  vi.clearAllMocks();
  falhaDeUpsert = () => null;
  falhaDeEmbed = new Set();

  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      if (tabela === "ai_faq_items") {
        const cadeia = {
          select: () => cadeia,
          eq: () => cadeia,
          order: () => Promise.resolve({ data: FAQ, error: null }),
        };
        return cadeia;
      }
      if (tabela === "ai_chunks") {
        return {
          upsert: (linha: { position: number }) => {
            const mensagem = falhaDeUpsert(linha.position);
            return Promise.resolve(mensagem ? { error: { message: mensagem } } : { error: null });
          },
        };
      }
      throw new Error(`tabela não dublada no teste: ${tabela}`);
    },
  } as never);

  vi.mocked(embedText).mockImplementation(async (texto: string) => {
    const posicao = FAQ.findIndex((item) => texto.includes(item.question));
    if (falhaDeEmbed.has(posicao)) throw new Error("quota estourou");
    return { embedding: [0.1, 0.2, 0.3] } as never;
  });

  vi.mocked(createKnowledgeVersion).mockResolvedValue({
    versionId: "v-2",
    versionNumber: 2,
  } as never);
  vi.mocked(markVersionReady).mockResolvedValue(undefined as never);
  vi.mocked(markVersionFailed).mockResolvedValue(undefined as never);
  vi.mocked(activateVersion).mockResolvedValue(undefined as never);
});

describe("indexarFonte — falha parcial não ativa versão", () => {
  it("grava os 2 trechos: ok + markVersionReady + activateVersion", async () => {
    const resultado = await indexarFonte(FONTE as never, CHAVE as never, {});

    expect(resultado).toEqual({ tipo: "ok", versionId: "v-2", chunks: 2 });
    expect(markVersionReady).toHaveBeenCalledWith("v-2", "org-1", 2);
    expect(activateVersion).toHaveBeenCalledWith({
      organizationId: "org-1",
      knowledgeSourceId: "ks-1",
      versionId: "v-2",
    });
    expect(markVersionFailed).not.toHaveBeenCalled();
  });

  it("1 de 2 trechos não grava: erro, versão falha e SEM ready/activate", async () => {
    falhaDeUpsert = (posicao) => (posicao === 1 ? "deadlock detected" : null);

    const resultado = await indexarFonte(FONTE as never, CHAVE as never, {});

    expect(resultado).toEqual({ tipo: "erro", detalhe: "trechos_nao_gravados:1" });
    expect(markVersionFailed).toHaveBeenCalledTimes(1);
    const chamada = vi.mocked(markVersionFailed).mock.calls[0]!;
    expect(chamada[0]).toBe("v-2");
    expect(chamada[1]).toBe("org-1");
    expect(chamada[2]).toContain("posição 1");
    expect(chamada[2]).toContain("deadlock detected");
    expect(markVersionReady).not.toHaveBeenCalled();
    expect(activateVersion).not.toHaveBeenCalled();
  });

  it("2 de 2 trechos não gravam: erro com detalhe nenhum_trecho_gravado", async () => {
    falhaDeUpsert = () => "permission denied";

    const resultado = await indexarFonte(FONTE as never, CHAVE as never, {});

    expect(resultado).toEqual({ tipo: "erro", detalhe: "nenhum_trecho_gravado" });
    expect(markVersionFailed).toHaveBeenCalledWith("v-2", "org-1", "nenhum trecho gravado");
    expect(markVersionReady).not.toHaveBeenCalled();
    expect(activateVersion).not.toHaveBeenCalled();
  });

  it("embedding falha no 1º trecho: erro, versão falha e SEM ready/activate", async () => {
    falhaDeEmbed = new Set([0]);

    const resultado = await indexarFonte(FONTE as never, CHAVE as never, {});

    expect(resultado).toEqual({
      tipo: "erro",
      detalhe: "embedding falhou no trecho 0: quota estourou",
    });
    expect(markVersionFailed).toHaveBeenCalledWith("v-2", "org-1", "embed@0: quota estourou");
    expect(markVersionReady).not.toHaveBeenCalled();
    expect(activateVersion).not.toHaveBeenCalled();
  });
});
