import { describe, expect, it, vi } from "vitest";

import { levarEmLote, MAXIMO_DO_LOTE_ENTRE_FUNIS } from "./levar-em-lote";

const GENERICO = "Não foi possível levar este negócio.";

describe("levarEmLote", () => {
  it("leva um de cada vez, na ordem, e nunca dois ao mesmo tempo", async () => {
    let emVoo = 0;
    let picoEmVoo = 0;
    const ordem: string[] = [];
    const levar = vi.fn(async (id: string) => {
      emVoo++;
      picoEmVoo = Math.max(picoEmVoo, emVoo);
      await new Promise((r) => setTimeout(r, 1));
      ordem.push(id);
      emVoo--;
    });

    const r = await levarEmLote({ leadIds: ["a", "b", "c"], levar, motivoGenerico: GENERICO });

    expect(ordem).toEqual(["a", "b", "c"]);
    expect(picoEmVoo).toBe(1);
    expect(r).toEqual({ levados: ["a", "b", "c"], recusados: [], foraDoTeto: [] });
  });

  it("a recusa de um não para os outros, e volta com o motivo da API", async () => {
    const levar = vi.fn(async (id: string) => {
      if (id === "b") throw new Error("Preencha o campo obrigatório CPF.");
    });

    const r = await levarEmLote({ leadIds: ["a", "b", "c"], levar, motivoGenerico: GENERICO });

    expect(r.levados).toEqual(["a", "c"]);
    expect(r.recusados).toEqual([{ leadId: "b", motivo: "Preencha o campo obrigatório CPF." }]);
  });

  it("falha sem mensagem vira o motivo genérico — nunca linha em branco", async () => {
    const r = await levarEmLote({
      leadIds: ["a"],
      levar: async () => {
        throw "falhou";
      },
      motivoGenerico: GENERICO,
    });

    expect(r.recusados).toEqual([{ leadId: "a", motivo: GENERICO }]);
  });

  it("respeita o teto, declara o que ficou de fora, e não repete id", async () => {
    const ids = Array.from({ length: MAXIMO_DO_LOTE_ENTRE_FUNIS + 3 }, (_, i) => `id-${i}`);
    const levar = vi.fn(async () => undefined);

    const r = await levarEmLote({ leadIds: [...ids, "id-0"], levar, motivoGenerico: GENERICO });

    expect(levar).toHaveBeenCalledTimes(MAXIMO_DO_LOTE_ENTRE_FUNIS);
    expect(r.foraDoTeto).toEqual(ids.slice(MAXIMO_DO_LOTE_ENTRE_FUNIS));
  });

  it("conta o progresso depois de cada negócio", async () => {
    const passos: Array<[number, number]> = [];
    await levarEmLote({
      leadIds: ["a", "b"],
      levar: async () => undefined,
      aoProgredir: (feitos, total) => passos.push([feitos, total]),
      motivoGenerico: GENERICO,
    });

    expect(passos).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
