import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/v1/ai/knowledge/sources/[id]/conteudo — LER O MATERIAL NA TELA.
 *
 * A tela do acervo lista os materiais em grade e só oferecia "Ver o que ele
 * aprendeu" (os PEDAÇOS do índice). Não havia como abrir um material e ler o
 * conteúdo legível dele — o texto que a pessoa colou, os pares de pergunta e
 * resposta que ela cadastrou —, e por isso a equipe mantinha um sistema
 * externo só para consultar o que já estava aqui dentro.
 *
 * O que este arquivo guarda é a régua de LEITURA, e não uma busca nova:
 *
 *  1. **documento/texto colado** → o texto sai do blob guardado em
 *     `source_metadata.blob_path` (é a fonte da verdade; o índice é derivado).
 *  2. **FAQ** → saem os PARES de `ai_faq_items`, na ordem em que foram
 *     cadastrados.
 *  3. **material automático** (conversas/catálogo) → sai o que foi indexado,
 *     lido direto de `ai_chunks`, com o MESMO recorte da tela de trechos.
 *  4. **arquivo ilegível** → cai no índice em vez de abrir uma tela vazia.
 *  5. **nada legível** → a resposta diz o motivo, e não devolve vazio mudo.
 *
 * O papel é o mesmo do resto do acervo (>= manager), e a organização sai da
 * SESSÃO — nunca do caminho nem do corpo.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

/**
 * A extração de arquivo é o ÚNICO ponto que fala com o Storage, e é ela que o
 * teste troca. `ErroDeExtracao` é a classe REAL do produto: a leitura decide o
 * recorte de falha por `instanceof`, e um dublê de outra classe mediria o dublê.
 */
const { extrairMock, ErroDeExtracaoFalsa } = vi.hoisted(() => {
  class ErroDeExtracaoFalsa extends Error {
    readonly code = "extracao_falhou";
  }
  return { extrairMock: vi.fn(), ErroDeExtracaoFalsa };
});

vi.mock("@/lib/ai/rag/ingest/documento", () => ({
  BUCKET_DE_CONHECIMENTO: "ai-policy",
  ErroDeExtracao: ErroDeExtracaoFalsa,
  extrairTextoDoArquivo: extrairMock,
}));

import { GET } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

const ORG_DA_SESSAO = "22222222-2222-4222-8222-222222222222";
const ORG_ALHEIA = "99999999-9999-4999-9999-999999999999";
const FONTE = "66666666-6666-4666-8666-666666666666";
const VERSAO = "77777777-7777-4777-8777-777777777777";

/**
 * Supabase falso: cada tabela devolve o que o caso pediu, e as consultas ficam
 * REGISTRADAS — é assim que se prova que o texto do blob venceu o índice, e que
 * a organização veio da sessão.
 */
function supabaseFalso(opts: {
  fonte?: Record<string, unknown> | null;
  itens?: Record<string, unknown>[];
  trechos?: Record<string, unknown>[];
  /** O `count` que o PostgREST devolve com `{ count: "exact" }` em `ai_faq_items`. */
  contagemDeItens?: number;
  erroNaFonte?: string | null;
}) {
  const tabelasConsultadas: string[] = [];
  const filtros: { tabela: string; campo: string; valor: unknown }[] = [];

  const resultado = (tabela: string) => {
    if (tabela === "ai_knowledge_sources") {
      return {
        data: opts.fonte === undefined ? null : opts.fonte,
        error: opts.erroNaFonte ? { message: opts.erroNaFonte } : null,
      };
    }
    if (tabela === "ai_faq_items") {
      return { data: opts.itens ?? [], error: null, count: opts.contagemDeItens ?? null };
    }
    if (tabela === "ai_chunks") return { data: opts.trechos ?? [], error: null };
    return { data: [], error: null };
  };

  const cadeia = (tabela: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (campo: string, valor: unknown) => {
        filtros.push({ tabela, campo, valor });
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => resultado(tabela),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resultado(tabela)).then(resolve),
    };
    return q;
  };

  return {
    from: (tabela: string) => {
      tabelasConsultadas.push(tabela);
      return cadeia(tabela);
    },
    __tabelas: tabelasConsultadas,
    __filtros: filtros,
  };
}

function ler(id = FONTE) {
  return GET(new NextRequest(`http://local/api/v1/ai/knowledge/sources/${id}/conteudo`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "user-1", idioma: "pt" },
    org: { orgId: ORG_DA_SESSAO },
    response: new Response(),
  } as never);
  vi.mocked(createClient).mockReset();
});

describe("ler o material na tela (#3059)", () => {
  it("devolve o TEXTO guardado do documento, sem passar pelo índice", async () => {
    const db = supabaseFalso({
      fonte: {
        id: FONTE,
        name: "Política de troca",
        source_type: "documento",
        source_metadata: { blob_path: `${ORG_DA_SESSAO}/abc.md`, ext: "md" },
        active_kb_version_id: VERSAO,
      },
      trechos: [{ id: "t1", position: 0, content: "pedaço do índice" }],
    });
    vi.mocked(createClient).mockResolvedValue(db as never);
    extrairMock.mockResolvedValue({ texto: "Troca em até 7 dias.", extensao: "md" });

    const res = await ler();
    const corpo = (await res.json()) as {
      data: { nome: string; origem: string; conteudo: string | null; motivo: string | null };
    };

    expect(res.status).toBe(200);
    expect(corpo.data.conteudo).toContain("7 dias");
    expect(corpo.data.origem).toBe("arquivo");
    expect(corpo.data.motivo).toBeNull();
    // O caminho do blob vem de `source_metadata`, com a extensão declarada.
    expect(extrairMock).toHaveBeenCalledWith(`${ORG_DA_SESSAO}/abc.md`, "md");
    // E o índice NÃO é lido: o texto guardado é a fonte da verdade.
    expect(db.__tabelas).not.toContain("ai_chunks");
  });

  it("o FAQ devolve os PARES pergunta/resposta, e não vai ao blob", async () => {
    const db = supabaseFalso({
      fonte: {
        id: FONTE,
        name: "Dúvidas frequentes",
        source_type: "faq",
        source_metadata: {},
        active_kb_version_id: VERSAO,
      },
      itens: [
        { question: "Qual o prazo de troca?", answer: "7 dias.", tags: [], locale: "pt-BR" },
        {
          question: "Vocês entregam?",
          answer: "Sim, em toda a cidade.",
          tags: [],
          locale: "pt-BR",
        },
      ],
    });
    vi.mocked(createClient).mockResolvedValue(db as never);

    const res = await ler();
    const corpo = (await res.json()) as {
      data: { origem: string; itens: { question: string; answer: string }[] | null; total: number };
    };

    expect(res.status).toBe(200);
    expect(corpo.data.origem).toBe("faq");
    expect(corpo.data.itens?.map((i) => i.question)).toEqual([
      "Qual o prazo de troca?",
      "Vocês entregam?",
    ]);
    expect(corpo.data.total).toBe(2);
    expect(extrairMock).not.toHaveBeenCalled();
    expect(db.__tabelas).not.toContain("ai_chunks");
  });

  it("material AUTOMÁTICO (conversas) devolve o que foi indexado dele", async () => {
    const db = supabaseFalso({
      fonte: {
        id: FONTE,
        name: "Conversas aproveitáveis",
        source_type: "conversas",
        source_metadata: {},
        active_kb_version_id: VERSAO,
      },
      trechos: [
        { id: "t1", position: 0, content: "Cliente perguntou o prazo." },
        { id: "t2", position: 1, content: "Respondi 7 dias." },
      ],
    });
    vi.mocked(createClient).mockResolvedValue(db as never);

    const res = await ler();
    const corpo = (await res.json()) as { data: { origem: string; conteudo: string | null } };

    expect(res.status).toBe(200);
    expect(corpo.data.origem).toBe("indice");
    expect(corpo.data.conteudo).toContain("Cliente perguntou o prazo.");
    expect(corpo.data.conteudo).toContain("Respondi 7 dias.");
    expect(extrairMock).not.toHaveBeenCalled();
  });

  it("arquivo ilegível cai no índice em vez de abrir tela vazia", async () => {
    const db = supabaseFalso({
      fonte: {
        id: FONTE,
        name: "Manual antigo",
        source_type: "documento",
        source_metadata: { blob_path: `${ORG_DA_SESSAO}/velho.pdf`, ext: "pdf" },
        active_kb_version_id: VERSAO,
      },
      trechos: [{ id: "t1", position: 0, content: "O texto que sobrou do arquivo." }],
    });
    vi.mocked(createClient).mockResolvedValue(db as never);
    extrairMock.mockRejectedValue(
      new ErroDeExtracaoFalsa("O arquivo não está mais guardado. Envie de novo."),
    );

    const res = await ler();
    const corpo = (await res.json()) as { data: { origem: string; conteudo: string | null } };

    expect(res.status).toBe(200);
    expect(corpo.data.origem).toBe("indice");
    expect(corpo.data.conteudo).toContain("O texto que sobrou do arquivo.");
  });

  it("material sem nada legível diz o MOTIVO, e não devolve vazio mudo", async () => {
    const db = supabaseFalso({
      fonte: {
        id: FONTE,
        name: "Política recém-criada",
        source_type: "documento",
        source_metadata: {},
        active_kb_version_id: null,
      },
    });
    vi.mocked(createClient).mockResolvedValue(db as never);

    const res = await ler();
    const corpo = (await res.json()) as {
      data: { conteudo: string | null; itens: unknown; motivo: string | null };
    };

    expect(res.status).toBe(200);
    expect(corpo.data.conteudo).toBeNull();
    expect(corpo.data.itens).toBeNull();
    expect(corpo.data.motivo).toBeTruthy();
  });

  it("404 para material que não é desta organização", async () => {
    const db = supabaseFalso({ fonte: null });
    vi.mocked(createClient).mockResolvedValue(db as never);

    const res = await ler();
    const corpo = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(corpo.error.code).toBe("not_found");
    // A organização do filtro é a DA SESSÃO — o id do caminho não escolhe o dono.
    expect(db.__filtros).toContainEqual({
      tabela: "ai_knowledge_sources",
      campo: "organization_id",
      valor: ORG_DA_SESSAO,
    });
    expect(db.__filtros.some((f) => f.valor === ORG_ALHEIA)).toBe(false);
  });

  /**
   * O aviso de truncamento reusa a frase do diálogo de trechos ("Mostrando os
   * primeiros trechos de N"), e lá o N é o TOTAL do material (`chunks_count`).
   * Com `total = trechos.length`, um catálogo de 350 trechos aparecia "de 200",
   * e um material de exatamente 200 acusava truncamento sem estar truncado.
   */
  describe("o total do aviso é o do material, e não o que coube", () => {
    const duzentos = Array.from({ length: 200 }, (_, i) => ({
      id: `t${i}`,
      position: i,
      content: `t${i}`,
    }));
    const automatico = (chunks_count: number) =>
      supabaseFalso({
        fonte: {
          id: FONTE,
          name: "Catálogo",
          source_type: "catalogo",
          source_metadata: {},
          active_kb_version_id: VERSAO,
          chunks_count,
        },
        trechos: duzentos,
      });
    type Total = { data: { origem: string; total: number; truncado: boolean } };

    it("350 trechos no material, 200 na tela: total 350 e truncado", async () => {
      vi.mocked(createClient).mockResolvedValue(automatico(350) as never);
      const corpo = (await (await ler()).json()) as Total;

      expect(corpo.data.origem).toBe("indice");
      expect(corpo.data.total).toBe(350);
      expect(corpo.data.truncado).toBe(true);
    });

    it("exatamente 200 trechos: não acusa truncamento", async () => {
      vi.mocked(createClient).mockResolvedValue(automatico(200) as never);
      const corpo = (await (await ler()).json()) as Total;

      expect(corpo.data.total).toBe(200);
      expect(corpo.data.truncado).toBe(false);
    });

    it("FAQ com 230 pares, 200 na tela: total 230 e truncado", async () => {
      const db = supabaseFalso({
        fonte: {
          id: FONTE,
          name: "Dúvidas",
          source_type: "faq",
          source_metadata: {},
          active_kb_version_id: VERSAO,
        },
        itens: duzentos.map((t) => ({ question: t.content, answer: "r" })),
        contagemDeItens: 230,
      });
      vi.mocked(createClient).mockResolvedValue(db as never);
      const corpo = (await (await ler()).json()) as Total;

      expect(corpo.data.origem).toBe("faq");
      expect(corpo.data.total).toBe(230);
      expect(corpo.data.truncado).toBe(true);
    });
  });

  it("403 para papel abaixo de manager, e nada é lido antes disso", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), {
        status: 403,
      }),
    } as never);

    const res = await ler();

    expect(res.status).toBe(403);
    // O dublê devolve 403 seja qual for o papel pedido: sem fixar a régua aqui,
    // trocar "manager" por "agent" na rota passaria verde.
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(createClient).not.toHaveBeenCalled();
    expect(extrairMock).not.toHaveBeenCalled();
  });
});
