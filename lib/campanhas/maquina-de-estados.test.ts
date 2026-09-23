import { describe, expect, it } from "vitest";

import {
  destinosDe,
  ehEditavel,
  ehStatusDaCampanha,
  ehTerminal,
  podeTransitar,
} from "./maquina-de-estados";
import { STATUS_DA_CAMPANHA, type StatusDaCampanha } from "./tipos";

describe("máquina de estados da campanha", () => {
  it("cobre TODOS os estados do vocabulário — estado sem linha na tabela explodiria em produção", () => {
    for (const status of STATUS_DA_CAMPANHA) {
      expect(() => destinosDe(status)).not.toThrow();
    }
  });

  it("aceita as transições da Spec 12 §7.3", () => {
    const validas: Array<[StatusDaCampanha, StatusDaCampanha]> = [
      ["draft", "preparing"],
      ["preparing", "ready"],
      ["preparing", "failed"],
      ["ready", "running"],
      ["ready", "scheduled"],
      ["ready", "draft"],
      ["scheduled", "running"],
      ["scheduled", "paused"],
      ["scheduled", "cancelled"],
      ["running", "paused"],
      ["running", "completed"],
      ["running", "cancelled"],
      ["running", "failed"],
      ["paused", "running"],
      ["paused", "scheduled"],
      ["paused", "cancelled"],
      ["failed", "draft"],
    ];
    for (const [de, para] of validas) {
      expect(podeTransitar(de, para), `${de} -> ${para}`).toEqual({ pode: true });
    }
  });

  it("recusa o que a spec não lista — e a recusa diz os dois estados", () => {
    const proibidas: Array<[StatusDaCampanha, StatusDaCampanha]> = [
      ["draft", "running"], // pular a preparação é enviar sem snapshot
      ["draft", "completed"],
      ["ready", "completed"],
      ["completed", "running"], // ressuscitar campanha concluída
      ["cancelled", "running"], // cancelamento é irreversível
      ["cancelled", "draft"],
      ["paused", "completed"],
      ["running", "ready"],
      ["failed", "running"], // não retoma execução parcial em silêncio
    ];
    for (const [de, para] of proibidas) {
      const r = podeTransitar(de, para);
      expect(r.pode, `${de} -> ${para}`).toBe(false);
      if (!r.pode) expect(r.motivo).toContain(para);
    }
  });

  it("transição para o MESMO estado não é avanço (clique duplo não vira progresso)", () => {
    const r = podeTransitar("running", "running");
    expect(r.pode).toBe(false);
    if (!r.pode) expect(r.motivo).toContain("já está");
  });

  it("os terminais são exatamente completed e cancelled", () => {
    const terminais = STATUS_DA_CAMPANHA.filter((s) => ehTerminal(s));
    expect(terminais).toEqual(["completed", "cancelled"]);
  });

  it("só o rascunho é editável — editar depois do snapshot mudaria mensagem já preparada", () => {
    expect(ehEditavel("draft")).toBe(true);
    for (const status of STATUS_DA_CAMPANHA.filter((s) => s !== "draft")) {
      expect(ehEditavel(status), status).toBe(false);
    }
  });

  it("reconhece valor legado do banco como desconhecido em vez de tratá-lo como válido", () => {
    expect(ehStatusDaCampanha("running")).toBe(true);
    expect(ehStatusDaCampanha("done")).toBe(false);
    expect(ehStatusDaCampanha("")).toBe(false);
  });
});
