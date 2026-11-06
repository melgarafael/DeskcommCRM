import { beforeEach, describe, expect, it, vi } from "vitest";
import { indexarFonte } from "@/workers/rag-indexer";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedTexts } from "@/lib/ai/embed";
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
 *
 * Desde a batelada dos embeddings, o embedding e o upsert vão por LOTE de 100.
 * Isso não afrouxa o contrato — aperta: o lote é atômico, então um trecho que
 * não grava derruba os outros 99 com ele, e a versão continua não ativando.
 * Os dois últimos casos exercitam justamente a fronteira entre dois lotes.
 */

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/embed", () => ({
  embedTexts: vi.fn(),
  SemChaveDeEmbeddingError: class SemChaveDeEmbeddingError extends Error {},
}));
vi.mock("@/lib/ai/embeddings/chave", () => ({
  resolverChaveDeEmbedding: vi.fn(),
  modeloDeEmbedding: () => "openai/text-embedding-3-small",
}));
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

const DOIS = [
  { question: "Qual o prazo?", answer: "Cinco dias úteis." },
  { question: "Tem frete grátis?", answer: "Acima de cem reais." },
];

/** FAQ de N itens, uma pergunta por trecho, para cruzar a fronteira do lote. */
const muitos = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    question: `Pergunta ${i}?`,
    answer: `Resposta ${i}.`,
  }));

/**
 * O vetor que ESTE texto deve receber.
 *
 * Pesado pela posição do caractere de propósito: a primeira versão desta
 * função usava só tamanho e inicial, e deixava "Pergunta 5?" e "Pergunta 7?"
 * caírem no mesmo vetor — ou seja, a cerca abaixo passava por sorte.
 */
const vetorDe = (texto: string) => [
  [...texto].reduce((soma, c, i) => soma + c.charCodeAt(0) * (i + 1), 0),
  texto.length,
  0.5,
];

interface LinhaGravada {
  position: number;
  content: string;
  embedding: unknown;
}

/** As linhas que o upsert ACEITOU, para conferir o par trecho × vetor. */
let gravadas: LinhaGravada[] = [];

/** A FAQ que o banco dublado devolve nesta execução. */
let faq: Array<{ question: string; answer: string }> = DOIS;
/** Mensagem de erro do upsert para cada posição; `null` = grava. */
let falhaDeUpsert: (posicao: number) => string | null = () => null;
/** Posições em que o embedding rejeita. */
let falhaDeEmbed: Set<number> = new Set();

beforeEach(() => {
  vi.clearAllMocks();
  faq = DOIS;
  gravadas = [];
  falhaDeUpsert = () => null;
  falhaDeEmbed = new Set();

  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      if (tabela === "ai_faq_items") {
        const cadeia = {
          select: () => cadeia,
          eq: () => cadeia,
          order: () => Promise.resolve({ data: faq, error: null }),
        };
        return cadeia;
      }
      if (tabela === "ai_chunks") {
        return {
          // O lote chega como ARRAY, e é atômico: basta uma linha recusada
          // para nenhuma entrar.
          upsert: (linhas: LinhaGravada[]) => {
            const recusada = linhas
              .map((l) => falhaDeUpsert(l.position))
              .find((m) => m !== null);
            if (!recusada) gravadas.push(...linhas);
            return Promise.resolve(recusada ? { error: { message: recusada } } : { error: null });
          },
        };
      }
      throw new Error(`tabela não dublada no teste: ${tabela}`);
    },
  } as never);

  vi.mocked(embedTexts).mockImplementation(async (textos: string[]) => {
    for (const texto of textos) {
      const posicao = faq.findIndex((item) => texto.includes(item.question));
      if (falhaDeEmbed.has(posicao)) throw new Error("quota estourou");
    }
    return { embeddings: textos.map((t) => vetorDe(t)) } as never;
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
    const resultado = await indexarFonte(FONTE as never, CHAVE as never);

    expect(resultado).toEqual({ tipo: "ok", versionId: "v-2", chunks: 2, contentHash: expect.any(String) });
    expect(markVersionReady).toHaveBeenCalledWith("v-2", "org-1", 2);
    expect(activateVersion).toHaveBeenCalledWith({
      organizationId: "org-1",
      knowledgeSourceId: "ks-1",
      versionId: "v-2",
    });
    expect(markVersionFailed).not.toHaveBeenCalled();
  });

  it("1 trecho do lote não grava: o lote é atômico, nada entra e a versão não ativa", async () => {
    falhaDeUpsert = (posicao) => (posicao === 1 ? "deadlock detected" : null);

    const resultado = await indexarFonte(FONTE as never, CHAVE as never);

    expect(resultado).toEqual({ tipo: "erro", detalhe: "nenhum_trecho_gravado" });
    expect(markVersionFailed).toHaveBeenCalledWith("v-2", "org-1", "nenhum trecho gravado");
    expect(markVersionReady).not.toHaveBeenCalled();
    expect(activateVersion).not.toHaveBeenCalled();
  });

  it("2 de 2 trechos não gravam: erro com detalhe nenhum_trecho_gravado", async () => {
    falhaDeUpsert = () => "permission denied";

    const resultado = await indexarFonte(FONTE as never, CHAVE as never);

    expect(resultado).toEqual({ tipo: "erro", detalhe: "nenhum_trecho_gravado" });
    expect(markVersionFailed).toHaveBeenCalledWith("v-2", "org-1", "nenhum trecho gravado");
    expect(markVersionReady).not.toHaveBeenCalled();
    expect(activateVersion).not.toHaveBeenCalled();
  });

  it("embedding falha no 1º trecho: erro, versão falha e SEM ready/activate", async () => {
    falhaDeEmbed = new Set([0]);

    const resultado = await indexarFonte(FONTE as never, CHAVE as never);

    // A faixa do LOTE, não um trecho: em lote o provedor não diz qual texto
    // recusou, e este texto chega ao cliente no cartão da fonte.
    expect(resultado).toEqual({
      tipo: "erro",
      detalhe: "embedding falhou no lote 0-1: quota estourou",
    });
    expect(markVersionFailed).toHaveBeenCalledWith("v-2", "org-1", "embed@lote 0-1: quota estourou");
    expect(markVersionReady).not.toHaveBeenCalled();
    expect(activateVersion).not.toHaveBeenCalled();
  });

  // ─── a fronteira do lote ────────────────────────────────────────────────────

  it("⭐ 150 trechos saem em 2 chamadas de embedding, de 100 e 50", async () => {
    faq = muitos(150);

    const resultado = await indexarFonte(FONTE as never, CHAVE as never);

    expect(resultado).toEqual({
      tipo: "ok",
      versionId: "v-2",
      chunks: 150,
      contentHash: expect.any(String),
    });
    const tamanhos = vi.mocked(embedTexts).mock.calls.map(([textos]) => textos.length);
    expect(tamanhos).toEqual([100, 50]);
  });

  // A COSTURA QUE A BATELADA CRIOU.
  //
  // Antes, `embedText(p.content)` devolvia um vetor para um texto, consumido na
  // hora: não havia índice para errar. Agora existem dois (`embeddings[j]` e
  // `position: inicio + j`), e só a posição tinha instrumento. A revisão provou
  // o buraco entregando o vetor do lote INVERTIDO: 60 de 60 testes verdes, com
  // o acervo inteiro embaralhado e a versão carimbada como pronta.
  //
  // Esse é o pior modo de falhar que este caminho tem, porque não há erro:
  // a busca devolve o trecho A com a similaridade do B, com nota alta. E não se
  // conserta sozinho — o `content_hash` do acervo errado faz a carga seguinte
  // ser pulada por `sem_mudanca`.
  it("⭐ cada linha leva o vetor DO SEU trecho, inclusive no 2º lote", async () => {
    faq = muitos(150);

    await indexarFonte(FONTE as never, CHAVE as never);

    expect(gravadas).toHaveLength(150);
    for (const linha of gravadas) {
      expect(linha.embedding, `trecho na posição ${linha.position}`).toEqual(
        vetorDe(linha.content),
      );
    }
    expect(gravadas.map((l) => l.position)).toEqual(Array.from({ length: 150 }, (_, i) => i));
  });

  it("⭐ falha no 2º lote: o 1º já gravou, e a versão ainda não ativa", async () => {
    faq = muitos(150);
    falhaDeUpsert = (posicao) => (posicao === 120 ? "deadlock detected" : null);

    const resultado = await indexarFonte(FONTE as never, CHAVE as never);

    // 100 gravados e 50 perdidos: a contagem é por FAIXA, não por posição, para
    // a mensagem não virar uma lista de cinquenta números iguais.
    expect(resultado).toEqual({ tipo: "erro", detalhe: "trechos_nao_gravados:50" });
    const chamada = vi.mocked(markVersionFailed).mock.calls[0]!;
    expect(chamada[2]).toContain("posições 100-149");
    expect(chamada[2]).toContain("deadlock detected");
    expect(markVersionReady).not.toHaveBeenCalled();
    expect(activateVersion).not.toHaveBeenCalled();
  });
});
