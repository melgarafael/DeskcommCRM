import { describe, expect, it } from "vitest";

import {
  corpoDoEvento,
  diasDaSemana,
  fechamentoUmaSemanaDepois,
  gradeDoMes,
  horaLocal,
  inicioDaSemana,
  instanteDoDia,
  lembretesQueVencem,
  podeVerReuniao,
  posicaoNaFaixa,
  rotuloDoLembrete,
  textoAoCliente,
  type QuemOlhaAgenda,
} from "@/lib/agencia/calendario/regras";

/** As regras puras da Fase 3 (docs/agencia/SPEC-calendario.md). */

describe("semana e mês no fuso de Brasília", () => {
  it("a semana vai de segunda a domingo", () => {
    expect(inicioDaSemana("2026-10-28")).toBe("2026-10-26"); // quarta → segunda
    expect(inicioDaSemana("2026-11-01")).toBe("2026-10-26"); // domingo fica na semana que começou na segunda
    expect(diasDaSemana("2026-10-26")).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });

  it("o mês é coberto por semanas inteiras", () => {
    const g = gradeDoMes("2026-11-15");
    expect(g[0]?.[0]).toBe("2026-10-26");
    expect(g.at(-1)?.[6]).toBe("2026-12-06");
    expect(g.flat()).toContain("2026-11-30");
    expect(g.every((s) => s.length === 7)).toBe(true);
  });

  it("10h de Brasília é 13h UTC, e volta como 10:00", () => {
    const i = instanteDoDia("2026-10-26", "10:00");
    expect(i.toISOString()).toBe("2026-10-26T13:00:00.000Z");
    expect(horaLocal(i.toISOString())).toBe("10:00");
  });

  it("a reunião cai na faixa das 7h às 22h", () => {
    const p = posicaoNaFaixa("2026-10-26T13:00:00Z", "2026-10-26T14:00:00Z", "2026-10-26");
    expect(p?.topo).toBeCloseTo(3 / 15); // 10h está 3 h depois das 7h, numa faixa de 15 h
    expect(p?.altura).toBeCloseTo(1 / 15);
    expect(posicaoNaFaixa("2026-10-26T13:00:00Z", "2026-10-26T14:00:00Z", "2026-10-27")).toBeNull();
  });
});

describe("Fechamento uma semana depois (K5)", () => {
  it("mesmo horário, sete dias depois", () => {
    expect(fechamentoUmaSemanaDepois("2026-10-26T13:00:00.000Z", "2026-10-26T14:00:00.000Z")).toEqual({
      inicio: "2026-11-02T13:00:00.000Z",
      fim: "2026-11-02T14:00:00.000Z",
    });
  });
});

describe("lembretes (K7)", () => {
  const r = { inicio: "2026-10-27T13:00:00Z", horarioEm: "2026-10-20T12:00:00Z" };

  it("1 dia antes vence; 1 hora antes ainda não", () => {
    const agora = new Date("2026-10-26T13:05:00Z");
    expect(lembretesQueVencem(r, [1440, 60], [], agora)).toEqual({ enviar: 1440, registrar: [1440] });
  });

  it("cada marco uma vez", () => {
    const agora = new Date("2026-10-26T13:05:00Z");
    expect(lembretesQueVencem(r, [1440, 60], ["1440"], agora)).toEqual({ enviar: null, registrar: [] });
  });

  it("relógio atrasado: manda só o mais próximo e registra os dois", () => {
    const agora = new Date("2026-10-27T12:30:00Z");
    expect(lembretesQueVencem(r, [1440, 60], [], agora)).toEqual({ enviar: 60, registrar: [1440, 60] });
  });

  it("marcada há pouco: o marco que já tinha passado não dispara", () => {
    const recem = { inicio: "2026-10-27T13:00:00Z", horarioEm: "2026-10-27T00:00:00Z" };
    expect(lembretesQueVencem(recem, [1440, 60], [], new Date("2026-10-27T01:00:00Z"))).toEqual({ enviar: null, registrar: [] });
    expect(lembretesQueVencem(recem, [1440, 60], [], new Date("2026-10-27T12:10:00Z")).enviar).toBe(60);
  });

  it("depois que começou, nada", () => {
    expect(lembretesQueVencem(r, [1440, 60], [], new Date("2026-10-27T13:01:00Z")).enviar).toBeNull();
  });

  it("o texto do lembrete", () => {
    expect(rotuloDoLembrete(1440)).toBe("amanhã");
    expect(rotuloDoLembrete(60)).toBe("em 1 hora");
    expect(rotuloDoLembrete(2880)).toBe("em 2 dias");
    expect(rotuloDoLembrete(15)).toBe("em 15 minutos");
  });
});

describe("quem vê a reunião (K9)", () => {
  const quem = (p: Partial<QuemOlhaAgenda>): QuemOlhaAgenda => ({
    gerencia: false,
    membroId: "m1",
    alcance: { todos: false, ids: new Set(["c1"]) },
    ...p,
  });

  it("reunião de cliente: só quem alcança o cliente", () => {
    expect(podeVerReuniao(quem({}), { clienteId: "c1", membros: [] })).toBe(true);
    expect(podeVerReuniao(quem({}), { clienteId: "c2", membros: ["m1"] })).toBe(false);
    expect(podeVerReuniao(quem({ gerencia: true }), { clienteId: "c2", membros: [] })).toBe(false);
  });

  it("interna: quem está nela e quem gerencia", () => {
    expect(podeVerReuniao(quem({}), { clienteId: null, membros: ["m1"] })).toBe(true);
    expect(podeVerReuniao(quem({}), { clienteId: null, membros: ["m2"] })).toBe(false);
    expect(podeVerReuniao(quem({ gerencia: true }), { clienteId: null, membros: [] })).toBe(true);
  });
});

describe("o que sai para fora", () => {
  it("o evento do Google pede Meet só online e não repete e-mail", () => {
    const base = {
      reuniaoId: "r1",
      titulo: "Apresentação — Turbo Kids",
      inicio: "2026-10-26T13:00:00.000Z",
      fim: "2026-10-26T14:00:00.000Z",
      local: "Rua A, 10",
      emails: ["Ana@x.com", "ana@x.com", "sem-arroba", "bia@y.com"],
      pedidoDeMeet: "r1-1",
    };
    const online = corpoDoEvento({ ...base, formato: "online" });
    expect(online.attendees).toEqual([{ email: "ana@x.com" }, { email: "bia@y.com" }]);
    expect(online.conferenceData).toEqual({ createRequest: { requestId: "r1-1", conferenceSolutionKey: { type: "hangoutsMeet" } } });
    expect(online.location).toBeUndefined();
    const presencial = corpoDoEvento({ ...base, formato: "presencial" });
    expect(presencial.conferenceData).toBeUndefined();
    expect(presencial.location).toBe("Rua A, 10");
  });

  it("o WhatsApp ao cliente leva dia, hora e link — e nada da pauta", () => {
    const t = textoAoCliente({
      nome: "Gabriel Souza",
      agencia: "Em Movimento",
      situacao: "marcada",
      tipo: "apresentacao",
      inicio: "2026-10-26T13:00:00.000Z",
      formato: "online",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      local: null,
    });
    expect(t).toContain("Olá, Gabriel!");
    expect(t).toContain("Apresentação");
    expect(t).toContain("às 10:00");
    expect(t).toContain("https://meet.google.com/abc-defg-hij");
    const cancelada = textoAoCliente({
      nome: "Gabriel",
      agencia: "Em Movimento",
      situacao: "cancelada",
      tipo: "fechamento",
      inicio: "2026-10-26T13:00:00.000Z",
      formato: "online",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      local: null,
    });
    expect(cancelada).toContain("foi cancelada");
    expect(cancelada).not.toContain("meet.google.com");
  });

  it("a Apresentação já conta, na mesma mensagem, quando é o Fechamento", () => {
    const t = textoAoCliente({
      nome: "Gabriel",
      agencia: "Em Movimento",
      situacao: "marcada",
      tipo: "apresentacao",
      inicio: "2026-10-26T13:00:00.000Z",
      formato: "presencial",
      meetUrl: null,
      local: "Rua A, 10",
      seguinte: { tipo: "fechamento", inicio: "2026-11-02T13:00:00.000Z" },
    });
    expect(t).toContain("Local: Rua A, 10");
    expect(t).toMatch(/Fechamento já fica marcado para .*02\/11.*às 10:00/);
  });
});
