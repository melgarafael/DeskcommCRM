/**
 * #4133 item 1 — ÍNDICE DA BASE DE CONHECIMENTO NO CONTEXTO.
 *
 * O que este arquivo prova (e é o critério da issue):
 *
 *  1. uma linha por material, na ordem estável (nome, id), com o resumo derivado
 *     em UM lugar (FAQ → primeiro trecho → rótulo do tipo);
 *  2. isolamento por organização (material de outra org não entra nem por id);
 *  3. corte DECLARADO em orçamento pequeno: primeiro reduz o resumo, depois lista
 *     só por nome, e o rodapé conta o que ficou fora — nada desaparece em silêncio;
 *  4. cache: acerto não repete as consultas de resumo, TTL expira, `updated_at`
 *     novo invalida, lista diferente muda a chave, e o teto de entradas morde;
 *  5. medição 50/200/1.000 materiais sintéticos — tamanho do índice e sobra do
 *     orçamento (números copiados para o corpo do PR).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { countPayloadTokens } from "@/lib/ai/estimativa-de-tokens";
import {
  CACHE_MAX_ENTRADAS,
  CACHE_TTL_MS,
  RESUMO_CURTO_MAX_CHARS,
  buildKnowledgeIndexBlock,
  cortarTexto,
  limparCacheDoIndiceDeConhecimento,
  renderizarIndiceComOrcamento,
  resumoDoMaterial,
  tamanhoDoCacheDoIndiceDeConhecimento,
  type MaterialDoIndice,
} from "./indice-de-conhecimento";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";

interface FonteFalsa {
  id: string;
  organization_id: string;
  name: string;
  source_type: string;
  updated_at: string;
  is_active: boolean;
}

interface EstadoFalso {
  fontes: FonteFalsa[];
  faq: Map<string, string>;
  trechos: Map<string, string>;
  consultas: string[];
}

/**
 * Pool fingido com o formato de CADA consulta do índice. A organização entra no
 * filtro — é isso que o teste de isolamento mede.
 */
function bancoFalso(estado: EstadoFalso) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      estado.consultas.push(sql);
      if (sql.includes("from ai_knowledge_sources")) {
        const [org, ids] = params as [string, string[]];
        return {
          rows: estado.fontes
            .filter((f) => f.organization_id === org && ids.includes(f.id) && f.is_active)
            .map(({ id, name, source_type, updated_at }) => ({
              id,
              name,
              source_type,
              updated_at,
            })),
        };
      }
      if (sql.includes("from ai_faq_items")) {
        const [org, ids] = params as [string, string[] | string];
        const lista = Array.isArray(ids) ? ids : [ids];
        const daOrg = new Set(
          estado.fontes.filter((f) => f.organization_id === org).map((f) => f.id),
        );
        return {
          rows: lista
            .filter((id) => daOrg.has(id) && estado.faq.has(id))
            .map((id) => ({ knowledge_source_id: id, question: estado.faq.get(id)! })),
        };
      }
      if (sql.includes("from ai_chunks")) {
        const [org, ids] = params as [string, string[] | string];
        const lista = Array.isArray(ids) ? ids : [ids];
        const daOrg = new Set(
          estado.fontes.filter((f) => f.organization_id === org).map((f) => f.id),
        );
        return {
          rows: lista
            .filter((id) => daOrg.has(id) && estado.trechos.has(id))
            .map((id) => ({ knowledge_source_id: id, content: estado.trechos.get(id)! })),
        };
      }
      return { rows: [] };
    },
  } as never;
}

function fonte(p: Partial<FonteFalsa> & { id: string; name: string }): FonteFalsa {
  return {
    organization_id: ORG,
    source_type: "documento",
    updated_at: "2026-11-01T10:00:00.000Z",
    is_active: true,
    ...p,
  };
}

function estadoInicial(): EstadoFalso {
  return {
    fontes: [
      fonte({ id: "a1", name: "Horários de atendimento", source_type: "faq" }),
      fonte({ id: "b2", name: "Política de troca", source_type: "documento" }),
      fonte({ id: "c3", name: "Catálogo de produtos", source_type: "catalogo" }),
    ],
    faq: new Map([["a1", "que horas vocês abrem?"]]),
    trechos: new Map([["b2", "# Política de troca\nTrocas em até 30 dias com a etiqueta."]]),
    consultas: [],
  };
}

beforeEach(() => {
  limparCacheDoIndiceDeConhecimento();
});

describe("índice da base — uma linha por material", () => {
  it("renderiza id, nome e resumo na ordem estável de nome", () => {
    const materiais: MaterialDoIndice[] = [
      { id: "c3", nome: "Catálogo de produtos", resumo: "Catálogo de produtos" },
      { id: "a1", nome: "Horários de atendimento", resumo: "que horas vocês abrem?" },
      { id: "b2", nome: "Política de troca", resumo: "Trocas em até 30 dias" },
    ];
    const bloco = renderizarIndiceComOrcamento(
      [...materiais].sort((a, b) => (a.nome < b.nome ? -1 : 1)),
      10_000,
    );
    const linhas = bloco.split("\n").filter((l) => l.startsWith("- "));
    expect(linhas).toEqual([
      "- [c3] Catálogo de produtos — Catálogo de produtos",
      "- [a1] Horários de atendimento — que horas vocês abrem?",
      "- [b2] Política de troca — Trocas em até 30 dias",
    ]);
    expect(bloco).toContain("ler_documento");
  });

  it("o resumo vem do FAQ, senão do primeiro trecho, senão do tipo", () => {
    expect(
      resumoDoMaterial({ tipo: "faq", perguntaDoFaq: "  que horas abrem?  ", primeiroTrecho: "x" }),
    ).toBe("que horas abrem?");
    expect(
      resumoDoMaterial({
        tipo: "documento",
        perguntaDoFaq: null,
        primeiroTrecho: "## Política de troca\nTrocas em até 30 dias.",
      }),
    ).toBe("Política de troca");
    expect(
      resumoDoMaterial({ tipo: "conversations", perguntaDoFaq: null, primeiroTrecho: null }),
    ).toBe("Conversas anteriores");
  });

  it("deriva os resumos das três fontes e ignora material inativo", async () => {
    const estado = estadoInicial();
    estado.fontes.push(fonte({ id: "d4", name: "Material desligado", is_active: false }));
    const bloco = await buildKnowledgeIndexBlock(
      bancoFalso(estado),
      ORG,
      ["a1", "b2", "c3", "d4"],
      10_000,
    );

    expect(bloco).toContain("- [a1] Horários de atendimento — que horas vocês abrem?");
    expect(bloco).toContain("- [b2] Política de troca — Política de troca");
    expect(bloco).toContain("- [c3] Catálogo de produtos — Catálogo de produtos");
    expect(bloco).not.toContain("Material desligado");
    expect(bloco.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
  });

  it("isola por organização: id de outra empresa não entra", async () => {
    const estado = estadoInicial();
    estado.fontes.push(
      fonte({ id: "z9", name: "Segredo de outra empresa", organization_id: OUTRA_ORG }),
    );
    const bloco = await buildKnowledgeIndexBlock(bancoFalso(estado), ORG, ["a1", "z9"], 10_000);
    expect(bloco).not.toContain("Segredo de outra empresa");
    expect(bloco).toContain("[a1]");
  });

  it("sem material ativo devolve bloco vazio (ausência não custa token)", async () => {
    const estado = estadoInicial();
    expect(await buildKnowledgeIndexBlock(bancoFalso(estado), ORG, [], 600)).toBe("");
    expect(await buildKnowledgeIndexBlock(bancoFalso(estado), ORG, ["nao-existe"], 600)).toBe("");
  });
});

describe("índice da base — corte DECLARADO, nunca silencioso", () => {
  const materiais: MaterialDoIndice[] = Array.from({ length: 12 }, (_, i) => ({
    id: `id-${String(i).padStart(2, "0")}`,
    nome: `Material ${String(i).padStart(2, "0")}`,
    resumo:
      "Um resumo razoavelmente longo para ocupar orçamento e forçar o corte em degraus, " +
      "com detalhe suficiente para não caber tudo de uma vez no bloco do prompt.",
  }));

  it("deg1: com orçamento folgado, cabe tudo com resumo completo", () => {
    const bloco = renderizarIndiceComOrcamento(materiais, 100_000);
    expect(bloco.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(12);
    expect(bloco).not.toContain("fora do índice");
  });

  it("deg2: orçamento apertado reduz o resumo antes de cortar material", () => {
    const folgado = renderizarIndiceComOrcamento(materiais, 100_000);
    const apertado = renderizarIndiceComOrcamento(
      materiais,
      Math.floor(countPayloadTokens(folgado) * 0.6),
    );
    const linhas = apertado.split("\n").filter((l) => l.startsWith("- "));

    expect(linhas).toHaveLength(12); // ninguém saiu
    expect(apertado).not.toContain("fora do índice");
    for (const material of materiais) {
      const linha = linhas.find((l) => l.includes(`[${material.id}]`))!;
      expect(linha).toBeTruthy();
      const resumo = linha.split(" — ")[1] ?? "";
      expect(resumo.length).toBeLessThanOrEqual(RESUMO_CURTO_MAX_CHARS);
    }
  });

  it("deg3: sem espaço para o resumo, completa com id e nome e conta o que ficou fora", () => {
    const bloco = renderizarIndiceComOrcamento(materiais, 200);
    expect(bloco).toContain("só com id e nome");
    const linhas = bloco.split("\n").filter((l) => /^- \[\S+\] [^—-]+$/.test(l));
    const rodape = bloco.split("\n").find((l) => l.startsWith("+"));
    const fora = Number(rodape?.match(/^\+(\d+)/)?.[1] ?? 0);
    const comResumo = bloco
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.includes(" — ")).length;

    expect(comResumo + linhas.length + fora).toBe(materiais.length);
    expect(bloco).toContain("fora do índice — peça pelo nome");
    // Os primeiros (ordem estável) são os que ficam — e todos têm id.
    expect(bloco).toContain(`[${materiais[0]!.id}]`);
  });

  it("orçamento mínimo: o AVISO sai sozinho, sem esconder que o acervo existe", () => {
    const bloco = renderizarIndiceComOrcamento(materiais, 5);
    expect(bloco).toBe("+12 materiais fora do índice — peça pelo nome.");
  });

  it("cortarTexto declara o corte com reticências", () => {
    expect(cortarTexto("a".repeat(200), 20)).toHaveLength(20);
    expect(cortarTexto("a".repeat(200), 20).endsWith("…")).toBe(true);
    expect(cortarTexto("  curto \n demais  ", 50)).toBe("curto demais");
  });
});

describe("índice da base — cache em processo", () => {
  it("acerto não repete as consultas de resumo", async () => {
    const estado = estadoInicial();
    const db = bancoFalso(estado);
    const primeiro = await buildKnowledgeIndexBlock(db, ORG, ["a1", "b2"], 600);
    expect(estado.consultas).toHaveLength(3); // fontes + faq + trechos

    estado.consultas.length = 0;
    const segundo = await buildKnowledgeIndexBlock(db, ORG, ["b2", "a1"], 600);
    expect(segundo).toBe(primeiro);
    // Só a consulta de fontes: é ela que lê `updated_at` (a chave do cache).
    expect(estado.consultas).toHaveLength(1);
  });

  it("TTL curto expira e refaz a montagem", async () => {
    const estado = estadoInicial();
    const db = bancoFalso(estado);
    const base = 1_000_000;
    const opcoes = { agora: () => base };
    await buildKnowledgeIndexBlock(db, ORG, ["a1"], 600, opcoes);
    estado.consultas.length = 0;

    opcoes.agora = () => base + CACHE_TTL_MS - 1;
    await buildKnowledgeIndexBlock(db, ORG, ["a1"], 600, opcoes);
    expect(estado.consultas).toHaveLength(1); // ainda em cache

    estado.consultas.length = 0;
    opcoes.agora = () => base + CACHE_TTL_MS;
    await buildKnowledgeIndexBlock(db, ORG, ["a1"], 600, opcoes);
    expect(estado.consultas).toHaveLength(3); // expirou: montou de novo
  });

  it("updated_at novo invalida (publicar material não espera o TTL)", async () => {
    const estado = estadoInicial();
    const db = bancoFalso(estado);
    await buildKnowledgeIndexBlock(db, ORG, ["a1"], 600);

    estado.faq.set("a1", "novo horário: 9h às 18h");
    estado.fontes[0] = { ...estado.fontes[0]!, updated_at: "2026-11-02T09:00:00.000Z" };
    const bloco = await buildKnowledgeIndexBlock(db, ORG, ["a1"], 600);
    expect(bloco).toContain("novo horário: 9h às 18h");
  });

  it("lista de materiais diferente é chave diferente", async () => {
    const estado = estadoInicial();
    const db = bancoFalso(estado);
    const um = await buildKnowledgeIndexBlock(db, ORG, ["a1"], 600);
    const dois = await buildKnowledgeIndexBlock(db, ORG, ["a1", "b2"], 600);
    expect(dois).not.toBe(um);
    expect(dois).toContain("[b2]");
  });

  it("orçamento diferente é chave diferente (o corte não vem do cache)", async () => {
    const estado = estadoInicial();
    const db = bancoFalso(estado);
    const grande = await buildKnowledgeIndexBlock(db, ORG, ["a1", "b2"], 10_000);
    const pequeno = await buildKnowledgeIndexBlock(db, ORG, ["a1", "b2"], 5);
    expect(pequeno).not.toBe(grande);
    expect(pequeno).toContain("fora do índice");
  });

  it("o cache tem teto: nunca cresce sem limite", async () => {
    // Um banco que responde QUALQUER organização: o teto é do cache, não da query.
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from ai_knowledge_sources")) {
          return {
            rows: [
              {
                id: "a1",
                name: "Material",
                source_type: "documento",
                updated_at: "2026-11-01T00:00:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      },
    } as never;
    for (let i = 0; i < CACHE_MAX_ENTRADAS + 5; i += 1) {
      // Uma organização por iteração ⇒ uma chave por iteração.
      await buildKnowledgeIndexBlock(db, `org-${i}`, ["a1"], 600);
    }
    expect(tamanhoDoCacheDoIndiceDeConhecimento()).toBeLessThanOrEqual(CACHE_MAX_ENTRADAS);
  });
});

/**
 * A MEDIÇÃO QUE A ISSUE PEDE (50/200/1.000 documentos SINTÉTICOS).
 *
 * Cenário: nome de ~30 caracteres e resumo de uma linha (~90 caracteres) — o
 * material típico de quem cola uma política. O número que interessa é o do
 * orçamento DEFAULT do produto (600 tokens) e o "natural" (sem teto), que mostra
 * quanto acervo cabe inteiro.
 */
describe("índice da base — medição 50 / 200 / 1.000 documentos", () => {
  function acervo(n: number): MaterialDoIndice[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      nome: `Documento ${String(i).padStart(4, "0")} da empresa`,
      resumo: "Pergunta frequente que resume o material em uma linha de texto.",
    }));
  }

  it("respeita o orçamento default (600) e conta o que ficou fora, com 50, 200 e 1.000 documentos", () => {
    for (const n of [50, 200, 1000]) {
      const materiais = acervo(n);
      const natural = renderizarIndiceComOrcamento(materiais, 10_000_000);
      const comDefault = renderizarIndiceComOrcamento(materiais, 600);
      const linhasCompletas = comDefault
        .split("\n")
        .filter((l) => l.startsWith("- ") && l.includes(" — ")).length;
      const linhasPorNome = comDefault
        .split("\n")
        .filter((l) => /^- \[\S+\] [^—-]+$/.test(l)).length;
      const fora = Number(
        comDefault
          .split("\n")
          .find((l) => l.startsWith("+"))
          ?.match(/^\+(\d+)/)?.[1] ?? 0,
      );

      // O orçamento é respeitado (o bloco do default NUNCA passa de 600 tokens)…
      expect(countPayloadTokens(comDefault)).toBeLessThanOrEqual(600);
      // …e o acervo não desaparece: o que não coube está contado.
      expect(linhasCompletas + linhasPorNome + fora).toBe(n);
      // Natural cresce com o acervo — é o custo que o orçamento evita.
      expect(countPayloadTokens(natural)).toBeGreaterThan(600);
    }
  });
});
