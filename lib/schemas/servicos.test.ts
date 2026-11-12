import { describe, expect, it } from "vitest";

import { problemasDoServico, servicoCreateSchema, servicoPatchSchema } from "./servicos";

/**
 * AS REGRAS DO CADASTRO DE SERVIÇO — issue #3372, fatia B, critério 3.
 *
 * Cada caso aqui é uma recusa que a issue pede explicitamente: unidade
 * incompatível com o tipo, preço negativo, sinal fora de 1 a 100, sinal fixo
 * acima da menor variação e prazo em item que não é projeto. A régua é UMA
 * (`problemasDoServico`) — o schema de create e o PATCH mesclado chamam a mesma.
 */

const BASE = {
  codigo: "CONS-1H",
  nome: "Consultoria de marketing (1 hora)",
  preco_cents: 35_000,
  tipo: "hora_marcada" as const,
  unidade: "hora" as const,
};

describe("servicoCreateSchema", () => {
  it("aceita hora marcada com sinal de 30% (o caso da issue)", () => {
    const parsed = servicoCreateSchema.safeParse({
      ...BASE,
      sinal: { tipo: "percentual", valor: 30 },
    });
    expect(parsed.success).toBe(true);
  });

  it("aceita projeto com prazo em dias úteis e valor fechado", () => {
    const parsed = servicoCreateSchema.safeParse({
      codigo: "SITE",
      nome: "Site institucional",
      preco_cents: 450_000,
      tipo: "projeto",
      unidade: "valor_fechado",
      prazo_dias_uteis: 30,
      sinal: { tipo: "percentual", valor: 50 },
    });
    expect(parsed.success).toBe(true);
  });

  it("aceita plano recorrente por mês", () => {
    const parsed = servicoCreateSchema.safeParse({
      codigo: "SOCIAL",
      nome: "Social media",
      preco_cents: 120_000,
      tipo: "recorrente",
      unidade: "mes",
    });
    expect(parsed.success).toBe(true);
  });

  it("recusa unidade incompatível com o tipo", () => {
    const parsed = servicoCreateSchema.safeParse({
      ...BASE,
      tipo: "projeto",
      unidade: "mes",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(["unidade"]);
  });

  it("recusa prazo em item que não é projeto", () => {
    const parsed = servicoCreateSchema.safeParse({ ...BASE, prazo_dias_uteis: 10 });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(["prazo_dias_uteis"]);
  });

  it("recusa preço negativo", () => {
    const parsed = servicoCreateSchema.safeParse({ ...BASE, preco_cents: -1 });
    expect(parsed.success).toBe(false);
  });

  it("recusa sinal percentual fora de 1 a 100", () => {
    for (const valor of [0, 101, -5]) {
      const parsed = servicoCreateSchema.safeParse({
        ...BASE,
        sinal: { tipo: "percentual", valor },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("recusa sinal fixo zero ou negativo", () => {
    for (const valor of [0, -100]) {
      const parsed = servicoCreateSchema.safeParse({ ...BASE, sinal: { tipo: "fixo", valor } });
      expect(parsed.success).toBe(false);
    }
  });

  it("exige tipo e unidade no serviço principal", () => {
    const semTipo = servicoCreateSchema.safeParse({
      codigo: "X",
      nome: "Serviço sem tipo",
      preco_cents: 1000,
    });
    expect(semTipo.success).toBe(false);
  });

  it("variação herda tipo e unidade — mandar isso nela é recusado", () => {
    const parsed = servicoCreateSchema.safeParse({
      ...BASE,
      pai_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues.map((i) => i.path[0])).toContain("tipo");
  });

  it("variação com nome, código e preço próprios passa", () => {
    const parsed = servicoCreateSchema.safeParse({
      codigo: "SOCIAL-20",
      nome: "Social media 20 posts + 4 reels",
      preco_cents: 190_000,
      pai_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(parsed.success).toBe(true);
  });

  it("aceita instruções internas com teto de 2000", () => {
    const parsed = servicoCreateSchema.safeParse({
      ...BASE,
      instrucoes_ia: "x".repeat(2001),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("problemasDoServico — o sinal fixo e a menor variação", () => {
  it("recusa sinal fixo acima do preço da menor variação", () => {
    // O piso é o preço da variação mais barata: pedir de entrada mais do que o
    // serviço inteiro custa é pedir o serviço duas vezes.
    const problemas = problemasDoServico(
      { ...BASE, tipo: "hora_marcada", unidade: "hora", sinal: { tipo: "fixo", valor: 40_000 } },
      { menorPrecoDoServico: 35_000 },
    );
    expect(problemas).toContainEqual({
      campo: "sinal",
      mensagem: "o sinal fixo não pode passar do preço da menor variação",
    });
  });

  it("aceita sinal fixo igual ao preço da menor variação", () => {
    const problemas = problemasDoServico(
      { ...BASE, tipo: "hora_marcada", unidade: "hora", sinal: { tipo: "fixo", valor: 35_000 } },
      { menorPrecoDoServico: 35_000 },
    );
    expect(problemas).toEqual([]);
  });

  it("devolve TODOS os problemas de uma vez, não o primeiro", () => {
    const problemas = problemasDoServico({
      tipo: "recorrente",
      unidade: "hora",
      prazo_dias_uteis: 5,
      sinal: { tipo: "percentual", valor: 300 },
    });
    expect(problemas.map((p) => p.campo).sort()).toEqual(["prazo_dias_uteis", "sinal", "unidade"]);
  });

  it("serviço com estoque é recusado (#2497: serviço não baixa estoque)", () => {
    const problemas = problemasDoServico({ ...BASE, controla_estoque: true });
    expect(problemas.map((p) => p.campo)).toContain("controla_estoque");
  });
});

describe("servicoPatchSchema", () => {
  it("exige a revisão que quem edita viu", () => {
    const semRevisao = servicoPatchSchema.safeParse({ nome: "Novo nome" });
    expect(semRevisao.success).toBe(false);

    const comRevisao = servicoPatchSchema.safeParse({ nome: "Novo nome", expected_revision: 4 });
    expect(comRevisao.success).toBe(true);
  });

  it("não aceita trocar a variação de principal por PATCH", () => {
    const parsed = servicoPatchSchema.safeParse({ pai_id: null, expected_revision: 1 });
    // `pai_id` não está no schema: o Zod o descarta, e a variação continua onde
    // está. Mudar de principal seria criar outro item, não editar este.
    expect(parsed.success).toBe(true);
    expect(parsed.success && "pai_id" in parsed.data).toBe(false);
  });
});
