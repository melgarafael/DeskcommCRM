/**
 * A PORTA DO SUPABASE — o que é decidido nela, sem banco.
 *
 * A gravação da vaga é `fn_lista_de_espera_ofertar`, provada em Postgres em
 * `tests/invariants/lista-de-espera-encaixe.test.ts`. Aqui fica o que é TypeScript
 * puro: a leitura das janelas falha fechada, e pedir encaixe duas vezes não duplica
 * a pessoa na fila.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));

import { decideEncaixe } from "@/lib/agenda/lista-de-espera";
import { inscreverNaEspera, lerJanelas } from "@/lib/agenda/encaixe-supabase";

describe("as janelas da inscrição falham fechado", () => {
  it("lista vazia é qualquer horário", () => {
    expect(lerJanelas([])).toEqual([]);
  });

  it("janela válida passa", () => {
    const janela = { dow: 2, start: "09:00", end: "12:00" };
    expect(lerJanelas([janela])).toEqual([janela]);
  });

  it.each([
    ["chaves erradas", [{ dia: 2, de: "09:00", ate: "12:00" }]],
    ["uma boa e uma ruim", [{ dow: 2, start: "09:00", end: "12:00" }, { dow: 9, start: "x", end: "y" }]],
    ["hora que não é hora", [{ dow: 2, start: "25:00", end: "26:00" }]],
    ["início depois do fim", [{ dow: 2, start: "12:00", end: "09:00" }]],
    ["não é lista", { dow: 2 }],
  ])("%s não vira qualquer horário", (_caso, bruto) => {
    expect(lerJanelas(bruto)).toBeNull();
  });

  it("controle positivo: lista vazia casa num domingo de madrugada, por isso o `null` importa", () => {
    const inicio = new Date("2026-11-08T05:00:00.000Z");
    const decisao = decideEncaixe(
      {
        appointmentId: "v",
        startsAt: inicio,
        endsAt: new Date(inicio.getTime() + 3_600_000),
        ownerUserId: null,
        timeZone: "America/Sao_Paulo",
      },
      { eventTypeId: "t", nome: "T", duracaoMinutos: 60, avisoMinimoMinutos: 0 },
      {
        id: "i",
        contactId: "c",
        eventTypeId: "t",
        ownerUserId: null,
        janelas: lerJanelas([]) ?? [],
        antecedenciaMinimaHoras: 0,
        validoAte: null,
        urgencia: 0,
        createdAt: new Date(0),
      },
      new Date("2026-11-07T05:00:00.000Z"),
    );
    expect(decisao).toEqual({ cabe: true });
  });
});

describe("pedir encaixe", () => {
  const pedido = {
    organizationId: "org-1",
    contactId: "contato-a",
    eventTypeId: "limpeza",
    consentimentoEm: new Date("2026-11-06T10:00:00.000Z"),
    consentimentoOrigem: "tela" as const,
    createdByKind: "user" as const,
  };

  /** O índice único parcial é do banco; aqui basta o que ele devolve. */
  function dublê() {
    const linhas: Array<Record<string, unknown>> = [];
    const leitura = {
      eq: () => leitura,
      in: () => leitura,
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
    };
    return {
      linhas,
      from: () => ({
        insert: (linha: Record<string, unknown>) => ({
          select: () => ({
            maybeSingle: async () => {
              if (linhas.length > 0) return { data: null, error: { code: "23505", message: "duplicada" } };
              linhas.push({ ...linha, id: "espera-1" });
              return { data: linhas[0], error: null };
            },
          }),
        }),
        select: () => leitura,
      }),
    };
  }

  it("grava o consentimento junto da inscrição", async () => {
    const db = dublê();
    const r = await inscreverNaEspera(db as never, pedido);
    expect(r).toMatchObject({ inscrito: true, jaEstava: false });
    expect(db.linhas[0]).toMatchObject({
      consentimento_em: "2026-11-06T10:00:00.000Z",
      consentimento_origem: "tela",
    });
  });

  it("pedir de novo devolve a MESMA inscrição, sem duplicar a pessoa", async () => {
    const db = dublê();
    await inscreverNaEspera(db as never, pedido);
    const segunda = await inscreverNaEspera(db as never, pedido);
    expect(segunda).toEqual({ inscrito: true, esperaId: "espera-1", jaEstava: true });
    expect(db.linhas).toHaveLength(1);
  });
});
