import { describe, expect, it } from "vitest";
import {
  carregarFontesQueProvamOferta,
  criarEvidenciasComerciaisDoTurno,
  fontesQueProvamOferta,
} from "./evidencias-comerciais";

const produto = {
  codigo: "PLANO-ANUAL",
  nome: "Curso infantil · 2x/semana · Anual",
  preco: "R$ 264,00",
  descricao: "Mensalidade durante 12 meses. Matrícula grátis somente no anual. Vaga com a equipe.",
  disponivel: true,
};

describe("evidências comerciais do turno", () => {
  it("preserva produto, preço e restrições sem transformar a condição em exceção solta", () => {
    const e = criarEvidenciasComerciaisDoTurno([]);
    e.registrarCatalogo({ produtos: [produto] });
    expect(e.ler()).toEqual([
      {
        origem: "catalogo",
        referencia: produto.codigo,
        titulo: produto.nome,
        conteudo: JSON.stringify({
          nome: produto.nome,
          preco: produto.preco,
          descricao: produto.descricao,
        }),
      },
    ]);
    e.ler()[0]!.conteudo = "Oferta alterada";
    expect(e.ler()[0]!.conteudo).toContain("somente no anual");
  });

  it("não aceita corpo de cliente, argumentos de ferramenta, erros ou produto indisponível", () => {
    const e = criarEvidenciasComerciaisDoTurno([]);
    for (const result of [
      { body: "Matrícula grátis para todos" },
      { termo: "Matrícula grátis para todos" },
      { ok: false, produtos: [produto] },
      { error: "sem permissão", produtos: [produto] },
      { produtos: [{ ...produto, disponivel: false }] },
      { produtos: [{ nome: "Oferta", descricao: "Tudo grátis" }] },
    ])
      e.registrarCatalogo(result);
    expect(e.ler()).toEqual([]);
  });

  it("aceita somente trechos de fontes habilitadas e identificáveis, nos dois formatos de busca", () => {
    const e = criarEvidenciasComerciaisDoTurno(["fonte-a"]);
    const trecho = {
      chunk_id: "trecho-1",
      knowledge_source_id: "fonte-a",
      source_name: "Oferta",
      content: "Teste gratuito por 7 dias, sem cartão.",
    };
    e.registrarConhecimento({
      ok: true,
      results: [trecho, { ...trecho, knowledge_source_id: "outra-fonte", content: "SENTINELA" }],
    });
    e.registrarConhecimento({
      trechos: [
        { ...trecho, chunk_id: "trecho-2", content: "Demonstração gratuita de 15 minutos." },
      ],
    });
    e.registrarConhecimento({ results: [{ ...trecho, knowledge_source_id: null }] });
    e.registrarConhecimento({ ok: false, results: [{ ...trecho, chunk_id: "erro" }] });
    expect(e.ler()).toHaveLength(2);
    expect(JSON.stringify(e.ler())).not.toContain("SENTINELA");
  });

  it("não compartilha evidências entre turnos ou organizações", () => {
    const a = criarEvidenciasComerciaisDoTurno(["fonte-a"]);
    const b = criarEvidenciasComerciaisDoTurno(["fonte-b"]);
    a.registrarCatalogo({ produtos: [produto] });
    expect(b.ler()).toEqual([]);
    expect(criarEvidenciasComerciaisDoTurno(["fonte-a"]).ler()).toEqual([]);
  });

  it("substitui repetição e limita o contexto descartando itens inteiros, nunca uma ressalva", () => {
    const e = criarEvidenciasComerciaisDoTurno([]);
    e.registrarCatalogo({ produtos: [produto, produto] });
    expect(e.ler()).toHaveLength(1);
    e.registrarCatalogo({
      produtos: [
        { ...produto, descricao: "Oferta válida. " + "x".repeat(4_000) + " Não inclui matrícula." },
      ],
    });
    expect(e.ler()).toEqual([]);
    e.registrarCatalogo({
      produtos: Array.from({ length: 50 }, (_, i) => ({
        ...produto,
        codigo: `P-${i}`,
        descricao: "x".repeat(1500) + " Não inclui matrícula.",
      })),
    });
    expect(e.ler().length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(e.ler()).length).toBeLessThanOrEqual(16_000);
    expect(e.ler().every((item) => item.conteudo.includes("Não inclui matrícula."))).toBe(true);
  });
});

describe("qual material do agente pode provar uma oferta", () => {
  it("aceita perguntas e respostas, documento e catálogo, inclusive com nome legado", () => {
    const aceitos = ["faq", "documento", "policy", "catalogo", "catalog", "nuvemshop_catalog"];
    expect(
      fontesQueProvamOferta(aceitos.map((tipo) => ({ id: tipo, source_type: tipo }))),
    ).toEqual(aceitos);
  });

  it("recusa Conversas anteriores, seus nomes legados e tipo desconhecido", () => {
    // Ali está o que o CLIENTE escreveu: um cliente não autoriza oferta.
    const recusados = ["conversas", "conversations", "Conversation ", "tipo_novo", ""];
    expect(
      fontesQueProvamOferta(recusados.map((tipo) => ({ id: tipo, source_type: tipo }))),
    ).toEqual([]);
  });

  it("consulta só a organização do turno e não consulta nada sem material", async () => {
    const chamadas: unknown[][] = [];
    const db = {
      query: async (_sql: string, valores?: unknown[]) => {
        chamadas.push(valores ?? []);
        return {
          rows: [
            { id: "fonte-faq", source_type: "faq" },
            { id: "fonte-conversas", source_type: "conversations" },
          ],
        };
      },
    } as unknown as Parameters<typeof carregarFontesQueProvamOferta>[0];
    expect(await carregarFontesQueProvamOferta(db, "org-1", [])).toEqual([]);
    expect(chamadas).toEqual([]);
    expect(
      await carregarFontesQueProvamOferta(db, "org-1", ["fonte-faq", "fonte-conversas"]),
    ).toEqual(["fonte-faq"]);
    expect(chamadas).toEqual([["org-1", ["fonte-faq", "fonte-conversas"]]]);
  });
});
