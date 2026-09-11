import { describe, expect, it } from "vitest";

import {
  normalizarTermoAcademia,
  periodoDoInicio,
  projetarAulaSemanal,
  resolverModalidade,
  resolverPublico,
  sinalDeConversaSobreGrade,
} from "@/lib/academia/consulta-grade";

describe("consulta da grade da academia", () => {
  const modalidades = [
    { id: "m1", name: "CrossFit", aliases: ["Cross fit", "Cross"] },
    { id: "m2", name: "Ciclismo", aliases: ["Spinning"] },
  ];

  it("resolve nome e alias sem depender de acento, caixa ou pontuação", () => {
    expect(normalizarTermoAcademia("  São-João! ")).toBe("sao joao");
    expect(resolverModalidade(modalidades, "cross-fit")).toEqual({
      tipo: "encontrada",
      id: "m1",
      nome: "CrossFit",
    });
    expect(resolverModalidade(modalidades, "SPÍNNING")).toEqual({
      tipo: "encontrada",
      id: "m2",
      nome: "Ciclismo",
    });
  });

  it("não escolhe modalidade quando o termo não existe", () => {
    expect(resolverModalidade(modalidades, "Natação")).toEqual({
      tipo: "nao_encontrada",
    });
  });

  it("não escolhe em silêncio quando duas modalidades usam o mesmo alias", () => {
    expect(
      resolverModalidade(
        [
          { id: "m1", name: "CrossFit", aliases: ["Treino"] },
          { id: "m2", name: "Funcional", aliases: ["Treino"] },
        ],
        "Treino",
      ),
    ).toEqual({ tipo: "ambigua", nomes: ["CrossFit", "Funcional"] });
  });

  it("nome canônico vence um alias conflitante", () => {
    expect(
      resolverModalidade(
        [
          { id: "m1", name: "Funcional", aliases: [] },
          { id: "m2", name: "CrossFit", aliases: ["Funcional"] },
        ],
        "Funcional",
      ),
    ).toEqual({ tipo: "encontrada", id: "m1", nome: "Funcional" });
  });

  it("resolve público apenas pelo nome canônico", () => {
    expect(
      resolverPublico(
        [
          { id: "p1", name: "Adulto" },
          { id: "p2", name: "Terceira idade" },
        ],
        "TERCEIRA IDÁDE",
      ),
    ).toEqual({ id: "p2", name: "Terceira idade" });
    expect(resolverPublico([{ id: "p1", name: "Adulto" }], "Sênior")).toBeNull();
  });

  it.each([
    ["00:00", "manha"],
    ["11:59", "manha"],
    ["12:00", "tarde"],
    ["17:59", "tarde"],
    ["18:00", "noite"],
    ["23:59", "noite"],
  ] as const)("classifica %s como %s pelo início", (inicio, esperado) => {
    expect(periodoDoInicio(inicio)).toBe(esperado);
  });

  it("projeta o CrossFit conhecido sem id ou observações e marca professor pendente", () => {
    expect(
      projetarAulaSemanal(
        {
          id: "aula-interna",
          weekday: 1,
          start_time: "08:00:00",
          duration_minutes: 60,
        },
        {
          modalidade: "CrossFit",
          publico: "Adulto",
          professor: "A definir",
          ambiente: "Box",
        },
      ),
    ).toEqual({
      dia_semana: 1,
      dia: "Segunda-feira",
      inicio: "08:00",
      fim: "09:00",
      duracao_minutos: 60,
      publico: "Adulto",
      professor: "A definir",
      ambiente: "Box",
      pendencias: ["professor"],
    });
  });

  it("não cria pendência para professor definido", () => {
    expect(
      projetarAulaSemanal(
        { id: "aula", weekday: 6, start_time: "23:30", duration_minutes: 60 },
        {
          modalidade: "Yoga",
          publico: "Adulto",
          professor: "Maria",
          ambiente: "Sala 1",
        },
      ),
    ).toEqual({
      dia_semana: 6,
      dia: "Sábado",
      inicio: "23:30",
      fim: "00:30 (+1 dia)",
      duracao_minutos: 60,
      publico: "Adulto",
      professor: "Maria",
      ambiente: "Sala 1",
    });
  });

  it("reconhece assunto de grade nas seis mensagens recentes", () => {
    expect(
      sinalDeConversaSobreGrade([
        { direction: "inbound", body: "Quero Cross fit" },
        { direction: "outbound", body: "Qual período?" },
        { direction: "inbound", body: "Pela manhã" },
        { direction: "outbound", body: "Qual dia?" },
        { direction: "inbound", body: "Segunda-feira" },
      ]),
    ).toBe(true);
  });

  it("não confunde uma verificação de rastreio com grade", () => {
    expect(
      sinalDeConversaSobreGrade([
        { direction: "inbound", body: "Pode verificar meu pedido?" },
        { direction: "outbound", body: "Vou olhar o rastreio." },
      ]),
    ).toBe(false);
  });
});
