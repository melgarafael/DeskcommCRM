/**
 * #4133 item 2 — `ler_documento`: a ferramenta que abre o material inteiro pelo
 * id, nos TRÊS caminhos do acervo (FAQ → blob → chunks), com os desfechos de
 * ENSINO e o teto de leitura declarado.
 *
 * A prova central do pedido da issue — "uma chave só" — está no último bloco:
 * com `embedText` injetado para LANÇAR, o índice e a leitura continuam
 * funcionando. Nada no modo `leitura_direta` toca em provedor de embedding.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const embedTextFalso = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("embedding_sem_chave: o modo leitura_direta não pode chamar embedding");
  }),
);

vi.mock("@/lib/ai/embed", () => ({ embedText: embedTextFalso }));

import {
  TETO_DE_CARACTERES_DO_DOCUMENTO,
  lerDocumentoDoMaterial,
  renderizarParesDeFaq,
} from "./ler-documento";
import {
  buildKnowledgeIndexBlock,
  limparCacheDoIndiceDeConhecimento,
} from "./indice-de-conhecimento";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";

interface FonteFalsa {
  id: string;
  organization_id: string;
  name: string;
  source_type: string;
  source_metadata: Record<string, unknown>;
  active_kb_version_id: string | null;
  chunks_count: number;
}

function bancoFalso(estado: {
  fonte: FonteFalsa | null;
  faq?: { question: string; answer: string }[];
  totalDoFaq?: number;
  trechos?: string[];
}) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("from ai_knowledge_sources")) {
        const [id, org] = params as [string, string];
        const bate =
          estado.fonte !== null && estado.fonte.id === id && estado.fonte.organization_id === org;
        return { rows: bate ? [estado.fonte] : [] };
      }
      if (sql.includes("count(*)::int as total")) {
        return { rows: [{ total: estado.totalDoFaq ?? estado.faq?.length ?? 0 }] };
      }
      if (sql.includes("from ai_faq_items")) {
        return { rows: estado.faq ?? [] };
      }
      if (sql.includes("from ai_chunks")) {
        return { rows: (estado.trechos ?? []).map((content) => ({ content })) };
      }
      return { rows: [] };
    },
  } as never;
}

function fonte(p: Partial<FonteFalsa> & { id: string }): FonteFalsa {
  return {
    organization_id: ORG,
    name: "Material",
    source_type: "documento",
    source_metadata: {},
    active_kb_version_id: null,
    chunks_count: 0,
    ...p,
  };
}

beforeEach(() => {
  limparCacheDoIndiceDeConhecimento();
  embedTextFalso.mockClear();
});

describe("ler_documento — os três caminhos", () => {
  it("FAQ: devolve os pares na ordem, como texto", async () => {
    const db = bancoFalso({
      fonte: fonte({ id: "a1", name: "Perguntas frequentes", source_type: "faq" }),
      faq: [
        { question: "que horas abrem?", answer: "das 9h às 18h" },
        { question: "aceitam pix?", answer: "sim" },
      ],
    });
    const out = await lerDocumentoDoMaterial(db, { organizationId: ORG, sourceId: "a1" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.origem).toBe("faq");
    expect(out.conteudo).toBe("P: que horas abrem?\nR: das 9h às 18h\n\nP: aceitam pix?\nR: sim");
    expect(out.truncado).toBe(false);
    expect(out.motivo).toBeNull();
  });

  it("FAQ com mais pares que o teto da leitura: parcial com motivo", async () => {
    const db = bancoFalso({
      fonte: fonte({ id: "a1", source_type: "faq", name: "FAQ grande" }),
      faq: [{ question: "p", answer: "r" }],
      totalDoFaq: 900,
    });
    const out = await lerDocumentoDoMaterial(db, { organizationId: ORG, sourceId: "a1" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.truncado).toBe(true);
    expect(out.total).toBe(900);
    expect(out.motivo).toContain("900");
  });

  it("blob: reusa a extração (o MESMO caminho da tela)", async () => {
    const extrair = vi.fn(async () => ({
      texto: "Política de troca: 30 dias.",
      extensao: "md" as const,
    }));
    const db = bancoFalso({
      fonte: fonte({
        id: "b2",
        name: "Política de troca",
        source_metadata: { blob_path: `${ORG}/pol.md`, ext: "md" },
      }),
    });
    const out = await lerDocumentoDoMaterial(
      db,
      { organizationId: ORG, sourceId: "b2" },
      { extrair },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.origem).toBe("arquivo");
    expect(out.conteudo).toBe("Política de troca: 30 dias.");
    expect(extrair).toHaveBeenCalledWith(`${ORG}/pol.md`, "md");
  });

  it("chunks: cai no índice da versão ativa e declara o que não coube", async () => {
    const db = bancoFalso({
      fonte: fonte({
        id: "c3",
        name: "Conversas anteriores",
        source_type: "conversations",
        active_kb_version_id: "v1",
        chunks_count: 5,
      }),
      trechos: ["trecho 1", "trecho 2"],
    });
    const out = await lerDocumentoDoMaterial(db, { organizationId: ORG, sourceId: "c3" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.origem).toBe("indice");
    expect(out.conteudo).toBe("trecho 1\n\ntrecho 2");
    expect(out.truncado).toBe(true);
    expect(out.motivo).not.toBeNull();
  });

  it("material grande: conteúdo parcial com `truncado` e o motivo escrito", async () => {
    const enorme = "x".repeat(TETO_DE_CARACTERES_DO_DOCUMENTO + 500);
    const extrair = vi.fn(async () => ({ texto: enorme, extensao: "md" as const }));
    const db = bancoFalso({
      fonte: fonte({ id: "d4", source_metadata: { blob_path: `${ORG}/big.md` } }),
    });
    const out = await lerDocumentoDoMaterial(
      db,
      { organizationId: ORG, sourceId: "d4" },
      { extrair },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.conteudo.length).toBe(TETO_DE_CARACTERES_DO_DOCUMENTO);
    expect(out.truncado).toBe(true);
    expect(out.motivo).toContain(String(TETO_DE_CARACTERES_DO_DOCUMENTO));
  });
});

describe("ler_documento — desfechos são ENSINO, nunca exceção", () => {
  it("id inexistente devolve documento_nao_encontrado", async () => {
    const out = await lerDocumentoDoMaterial(bancoFalso({ fonte: null }), {
      organizationId: ORG,
      sourceId: "nao-existe",
    });
    expect(out).toMatchObject({ ok: false, error: { code: "documento_nao_encontrado" } });
    if (out.ok) return;
    expect(out.error.message).toContain("índice de documentos");
  });

  it("id de OUTRA organização é MISS, não vazamento", async () => {
    const db = bancoFalso({
      fonte: fonte({ id: "z9", organization_id: OUTRA_ORG, name: "Segredo de outra empresa" }),
    });
    const out = await lerDocumentoDoMaterial(db, { organizationId: ORG, sourceId: "z9" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("documento_nao_encontrado");
    expect(JSON.stringify(out)).not.toContain("Segredo de outra empresa");
  });

  it("material vazio devolve documento_vazio com o motivo da tela", async () => {
    const out = await lerDocumentoDoMaterial(
      bancoFalso({ fonte: fonte({ id: "e5", source_type: "documento" }) }),
      { organizationId: ORG, sourceId: "e5" },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("documento_vazio");
    expect(out.error.message).toContain("não invente");
  });

  it("falha do banco vira internal_error (o turno não cai)", async () => {
    const db = {
      query: async () => {
        throw new Error("connection reset");
      },
    } as never;
    const out = await lerDocumentoDoMaterial(db, { organizationId: ORG, sourceId: "x" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("internal_error");
  });

  it("pares de FAQ são renderizados em P:/R: — o mesmo formato em todo lugar", () => {
    expect(renderizarParesDeFaq([{ question: "q", answer: "a" }])).toBe("P: q\nR: a");
  });
});

describe("#4133 — leitura_direta faz ZERO chamada a embedding", () => {
  it("índice e leitura funcionam com um embedText que LANÇA", async () => {
    // Se qualquer um dos dois chamasse embedding, este teste explodiria.
    const dbDoIndice = {
      query: async (sql: string) => {
        if (sql.includes("from ai_knowledge_sources")) {
          return {
            rows: [
              {
                id: "a1",
                name: "Horários",
                source_type: "faq",
                updated_at: "2026-11-01T00:00:00.000Z",
              },
            ],
          };
        }
        if (sql.includes("from ai_faq_items")) {
          return { rows: [{ knowledge_source_id: "a1", question: "que horas abrem?" }] };
        }
        return { rows: [] };
      },
    } as never;
    const indice = await buildKnowledgeIndexBlock(dbDoIndice, ORG, ["a1"], 600);
    expect(indice).toContain("[a1] Horários — que horas abrem?");

    const leitura = await lerDocumentoDoMaterial(
      bancoFalso({ fonte: fonte({ id: "a1", source_type: "faq" }) }),
      { organizationId: ORG, sourceId: "a1" },
      { extrair: vi.fn(async () => ({ texto: "", extensao: "md" as const })) },
    );
    expect(leitura.ok).toBe(false); // vazio, mas por conteúdo — não por chave
    if (leitura.ok) return;
    expect(leitura.error.code).toBe("documento_vazio");
    expect(embedTextFalso).not.toHaveBeenCalled();
  });
});
