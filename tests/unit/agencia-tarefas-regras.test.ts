import { describe, expect, it } from "vitest";

import { alcanceDeClientes, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { lerQuantidades } from "@/lib/agencia/clientes/vocabulario";
import {
  estaAtrasada,
  formatarDataHora,
  formatarDuracao,
  marcoDePrazo,
  podePegar,
  podeVerTarefa,
  proximaExecucao,
  tempoTotalSegundos,
  type QuemOlha,
} from "@/lib/agencia/tarefas/regras";

/** As regras puras da Fase 2 (docs/agencia/SPEC-tarefas.md e SPEC-clientes.md). */

const EDITOR = "funcao-editor";
const todos = { todos: true } as const;

function quem(p: Partial<QuemOlha>): QuemOlha {
  return { verTodas: false, membroId: "m1", funcoesIds: [EDITOR], alcance: todos, ...p };
}

describe("visibilidade de clientes (C5)", () => {
  it("dono e 've todos' veem todos; os demais, só os da equipe", () => {
    expect(alcanceDeClientes({ ehDono: true, membro: null }, []).todos).toBe(true);
    expect(alcanceDeClientes({ ehDono: false, membro: { id: "m", nome: "x", veTodosClientes: true } }, []).todos).toBe(true);
    const a = alcanceDeClientes({ ehDono: false, membro: { id: "m", nome: "x", veTodosClientes: false } }, ["c1"]);
    expect(podeVerCliente(a, "c1")).toBe(true);
    expect(podeVerCliente(a, "c2")).toBe(false);
    expect(podeVerCliente(a, null)).toBe(true);
  });
});

describe("quem vê a tarefa (T11) e quem pega (T3)", () => {
  it("responsável vê; outro membro não", () => {
    const t = { clienteId: null, funcaoId: null, responsaveis: ["m1"] };
    expect(podeVerTarefa(quem({}), t)).toBe(true);
    expect(podeVerTarefa(quem({ membroId: "m2" }), t)).toBe(false);
  });

  it("tarefa só da função aparece para a função e pode ser pega", () => {
    const t = { clienteId: null, funcaoId: EDITOR, responsaveis: [] };
    expect(podeVerTarefa(quem({}), t)).toBe(true);
    expect(podePegar(quem({}), t)).toBe(true);
    expect(podeVerTarefa(quem({ funcoesIds: ["outra"] }), t)).toBe(false);
    expect(podePegar(quem({}), { ...t, responsaveis: ["m9"] })).toBe(false);
  });

  it("ver_todas vê tudo, mas nunca fora dos clientes que alcança", () => {
    const fora = { todos: false, ids: new Set(["c1"]) } as const;
    expect(podeVerTarefa(quem({ verTodas: true }), { clienteId: "c9", funcaoId: null, responsaveis: [] })).toBe(true);
    expect(podeVerTarefa(quem({ verTodas: true, alcance: fora }), { clienteId: "c9", funcaoId: null, responsaveis: [] })).toBe(false);
  });
});

describe("prazo (T8)", () => {
  const agora = new Date("2026-11-02T15:00:00Z"); // 12h em São Paulo

  it("atrasada só se aberta e com prazo vencido", () => {
    expect(estaAtrasada({ prazo: "2026-11-01T12:00:00Z", coluna: "a_fazer" }, agora)).toBe(true);
    expect(estaAtrasada({ prazo: "2026-11-01T12:00:00Z", coluna: "concluido" }, agora)).toBe(false);
    expect(estaAtrasada({ prazo: null, coluna: "a_fazer" }, agora)).toBe(false);
  });

  it("marcos: antecedência configurada, no dia e atrasou", () => {
    expect(marcoDePrazo(new Date("2026-11-04T20:00:00Z"), [2, 1], agora)).toBe("antes_2d");
    expect(marcoDePrazo(new Date("2026-11-03T20:00:00Z"), [2, 1], agora)).toBe("antes_1d");
    expect(marcoDePrazo(new Date("2026-11-05T20:00:00Z"), [2, 1], agora)).toBeNull();
    expect(marcoDePrazo(new Date("2026-11-02T22:00:00Z"), [2, 1], agora)).toBe("no_dia");
    expect(marcoDePrazo(new Date("2026-11-02T14:00:00Z"), [2, 1], agora)).toBe("atrasou");
  });
});

describe("data e hora no fuso da agência", () => {
  it("18h de Brasília aparece como 18h, onde quer que a tela seja montada", () => {
    expect(formatarDataHora("2026-10-23T21:00:00Z")).toBe("23/10, 18:00");
    expect(formatarDataHora("2026-10-30T11:00:00Z", { comAno: true })).toBe("30/10/2026, 08:00");
  });
});

describe("cronômetro (T4)", () => {
  it("soma sessões fechadas e a aberta até agora", () => {
    const agora = new Date("2026-11-02T12:00:00Z");
    const total = tempoTotalSegundos(
      [
        { inicio: "2026-11-02T10:00:00Z", fim: "2026-11-02T10:30:00Z" },
        { inicio: "2026-11-02T11:50:00Z", fim: null },
      ],
      agora,
    );
    expect(total).toBe(40 * 60);
    expect(formatarDuracao(total)).toBe("00:40:00");
  });
});

describe("recorrência (T9)", () => {
  it("diária às 8h de São Paulo (11h UTC)", () => {
    const p = proximaExecucao(
      { padrao: "diaria", diasSemana: [], diaDoMes: null, hora: "08:00", inicio: "2026-11-01", fim: null },
      new Date("2026-11-02T12:00:00Z"),
    );
    expect(p?.toISOString()).toBe("2026-11-03T11:00:00.000Z");
  });

  it("semanal só nas sextas", () => {
    const p = proximaExecucao(
      { padrao: "semanal", diasSemana: [5], diaDoMes: null, hora: "08:00:00", inicio: "2026-11-01", fim: null },
      new Date("2026-11-02T12:00:00Z"),
    );
    expect(p?.toISOString()).toBe("2026-11-06T11:00:00.000Z");
  });

  it("mensal no dia 31 cai no último dia de mês de 30", () => {
    const p = proximaExecucao(
      { padrao: "mensal", diasSemana: [], diaDoMes: 31, hora: "09:00", inicio: "2026-11-01", fim: null },
      new Date("2026-11-02T12:00:00Z"),
    );
    expect(p?.toISOString()).toBe("2026-11-30T12:00:00.000Z");
  });

  it("respeita o início e o fim", () => {
    const r = { padrao: "diaria" as const, diasSemana: [], diaDoMes: null, hora: "08:00", inicio: "2026-12-01", fim: "2026-12-02" };
    expect(proximaExecucao(r, new Date("2026-11-02T12:00:00Z"))?.toISOString()).toBe("2026-12-01T11:00:00.000Z");
    expect(proximaExecucao(r, new Date("2026-12-02T12:00:00Z"))).toBeNull();
  });
});

describe("quantidades do pacote", () => {
  it("lê o jsonb sem confiar nele", () => {
    expect(lerQuantidades({ videos: 8, fotos: -1, artes: "12", lixo: 3 })).toEqual({ videos: 8 });
    expect(lerQuantidades(null)).toEqual({});
  });
});
