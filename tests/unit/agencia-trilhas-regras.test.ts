import { describe, expect, it } from "vitest";

import {
  antecessores,
  calendarioDoContrato,
  etapaAtual,
  passosQueLiberam,
  prazoDoPasso,
  problemaNoModelo,
  progresso,
  responsaveisDoPasso,
  type PassoDoModelo,
} from "@/lib/agencia/trilhas/regras";

/** As regras puras da Fase 4 (docs/agencia/SPEC-trilhas.md). */

describe("regra do dia 15 (R6)", () => {
  it("até o dia 15: contrato no dia 1 do mesmo mês, preparação até o fim dele", () => {
    expect(calendarioDoContrato("2027-01-06")).toEqual({
      inicio: "2027-01-01",
      preparacaoFim: "2027-01-31",
      primeiraPostagem: "2027-02-01",
      fimMinimo: "2027-03-31",
    });
    expect(calendarioDoContrato("2027-01-15").inicio).toBe("2027-01-01");
  });

  it("do dia 16 em diante: contrato no mês seguinte, preparação até o fim dele", () => {
    expect(calendarioDoContrato("2027-01-20")).toEqual({
      inicio: "2027-02-01",
      preparacaoFim: "2027-02-28",
      primeiraPostagem: "2027-03-01",
      fimMinimo: "2027-04-30",
    });
  });

  it("vira o ano", () => {
    expect(calendarioDoContrato("2026-12-20")).toEqual({
      inicio: "2027-01-01",
      preparacaoFim: "2027-01-31",
      primeiraPostagem: "2027-02-01",
      fimMinimo: "2027-03-31",
    });
  });
});

describe("desbloqueio (R4) e começar do meio (R8)", () => {
  const trilha = [
    { chave: "apresentacao", situacao: "bloqueado" as const, dependeDe: [] },
    { chave: "proposta", situacao: "bloqueado" as const, dependeDe: ["apresentacao"] },
    { chave: "fechamento", situacao: "bloqueado" as const, dependeDe: ["apresentacao"] },
    { chave: "assinou_pagou", situacao: "bloqueado" as const, dependeDe: ["fechamento"] },
    { chave: "campanha", situacao: "bloqueado" as const, dependeDe: ["assinou_pagou", "proposta"] },
  ];

  it("no começo só o passo sem dependência libera", () => {
    expect(passosQueLiberam(trilha)).toEqual(["apresentacao"]);
  });

  it("todas as dependências feitas (concluído ou pulado) liberam", () => {
    const t = trilha.map((p) =>
      p.chave === "apresentacao" ? { ...p, situacao: "concluido" as const } : p.chave === "proposta" ? { ...p, situacao: "pulado" as const } : p,
    );
    expect(passosQueLiberam(t)).toEqual(["fechamento"]);
  });

  it("começar do Fechamento pula a Apresentação, mas não a proposta", () => {
    expect([...antecessores(trilha, "fechamento")]).toEqual(["apresentacao"]);
    expect([...antecessores(trilha, "campanha")].sort()).toEqual(["apresentacao", "assinou_pagou", "fechamento", "proposta"]);
  });

  it("progresso ignora os pulados; etapa atual é a menor aberta", () => {
    const p = [
      { etapa: 1, situacao: "concluido" as const },
      { etapa: 1, situacao: "pulado" as const },
      { etapa: 2, situacao: "liberado" as const },
      { etapa: 2, situacao: "bloqueado" as const },
    ];
    expect(progresso(p)).toEqual({ feitos: 1, total: 3, pct: 33 });
    expect(etapaAtual(p)).toBe(2);
    expect(etapaAtual([{ etapa: 1, situacao: "concluido" as const }])).toBeNull();
  });
});

describe("prazo do passo (R5)", () => {
  const liberadoEm = new Date("2026-10-26T15:00:00Z"); // 12h de Brasília, segunda
  const apresentacao = new Date("2026-10-27T13:00:00Z"); // terça 10h

  it("N dias depois de liberar vence às 18h de Brasília", () => {
    const p = prazoDoPasso({ regra: "apos_liberar", dias: 3, ancora: null }, { liberadoEm, instanteDaAncora: () => null, preparacaoFim: null });
    expect(p?.toISOString()).toBe("2026-10-29T21:00:00.000Z");
  });

  it("depois de outro passo: Fechamento sete dias depois da Apresentação, no mesmo horário", () => {
    const ctx = { liberadoEm, instanteDaAncora: (c: string) => (c === "apresentacao" ? apresentacao : null), preparacaoFim: null };
    expect(prazoDoPasso({ regra: "apos_ancora", dias: 7, ancora: "apresentacao" }, ctx)?.toISOString()).toBe("2026-11-03T13:00:00.000Z");
    expect(prazoDoPasso({ regra: "apos_ancora", dias: 5, ancora: "fechamento" }, ctx)).toBeNull();
  });

  it("fim da preparação e manual", () => {
    const ctx = { liberadoEm, instanteDaAncora: () => null, preparacaoFim: "2026-11-30" };
    expect(prazoDoPasso({ regra: "fim_preparacao", dias: null, ancora: null }, ctx)?.toISOString()).toBe("2026-11-30T21:00:00.000Z");
    expect(prazoDoPasso({ regra: "fim_preparacao", dias: null, ancora: null }, { ...ctx, preparacaoFim: null })).toBeNull();
    expect(prazoDoPasso({ regra: "manual", dias: 3, ancora: null }, ctx)).toBeNull();
  });
});

describe("quem faz (R7)", () => {
  const equipe = [
    { membroId: "ana", funcoes: ["editor", "designer"] },
    { membroId: "bia", funcoes: ["roteirista"] },
  ];
  it("quem da equipe do cliente tem a função", () => {
    expect(responsaveisDoPasso("editor", equipe)).toEqual(["ana"]);
  });
  it("ninguém da equipe com a função: vai para a função inteira", () => {
    expect(responsaveisDoPasso("videomaker", equipe)).toEqual([]);
    expect(responsaveisDoPasso(null, equipe)).toEqual([]);
  });
});

describe("validação do modelo", () => {
  const p = (chave: string, dependeDe: string[] = [], extra: Partial<PassoDoModelo> = {}): PassoDoModelo => ({
    chave,
    titulo: chave,
    tipo: "tarefa",
    reuniaoTipo: null,
    dependeDe,
    regra: "manual",
    ancora: null,
    ...extra,
  });

  it("modelo certo passa", () => {
    expect(problemaNoModelo([p("aa"), p("bb", ["aa"]), p("cc", ["aa", "bb"])])).toBeNull();
  });

  it("recusa chave repetida, dependência que não existe e círculo", () => {
    expect(problemaNoModelo([p("aa"), p("aa")])).toMatch(/duas vezes/);
    expect(problemaNoModelo([p("aa"), p("bb", ["zz"])])).toMatch(/não existe/);
    expect(problemaNoModelo([p("aa"), p("bb", ["cc"]), p("cc", ["bb"])])).toMatch(/círculo/);
    expect(problemaNoModelo([p("Passo A")])).toMatch(/Chave inválida/);
  });

  it("reunião precisa do tipo; prazo depois de outro passo precisa da âncora", () => {
    expect(problemaNoModelo([p("aa", [], { tipo: "reuniao" })])).toMatch(/tipo de reunião/);
    expect(problemaNoModelo([p("aa"), p("bb", ["aa"], { regra: "apos_ancora" })])).toMatch(/de qual passo/);
  });
});
