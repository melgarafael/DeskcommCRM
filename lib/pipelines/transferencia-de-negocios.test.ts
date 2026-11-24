import { describe, expect, it } from "vitest";

import {
  etapaDeEntrada,
  resumoDaOperacao,
  validarDestinoDaTransferencia,
  type EtapaConhecida,
  type FunilConhecido,
} from "./transferencia-de-negocios";

const funil = (over: Partial<FunilConhecido> & { id: string; name: string }): FunilConhecido => ({
  is_archived: false,
  ...over,
});

const etapa = (over: Partial<EtapaConhecida> & { id: string; name: string }): EtapaConhecida => ({
  pipeline_id: "destino",
  position: 1000,
  is_won: false,
  is_lost: false,
  is_archived: false,
  ...over,
});

const FUNIS = [funil({ id: "origem", name: "Pedidos" }), funil({ id: "destino", name: "Clínica" })];

describe("etapaDeEntrada", () => {
  it("é a primeira etapa de ANDAMENTO por posição — Ganho e Perdido ficam de fora", () => {
    const entrada = etapaDeEntrada([
      etapa({ id: "ganho", name: "Ganho", position: 1000, is_won: true }),
      etapa({ id: "novo", name: "Novo", position: 2000 }),
      etapa({ id: "andamento", name: "Em andamento", position: 3000 }),
    ]);
    expect(entrada?.id).toBe("novo");
  });

  it("ignora etapa arquivada", () => {
    const entrada = etapaDeEntrada([
      etapa({ id: "velha", name: "Velha", position: 1000, is_archived: true }),
      etapa({ id: "nova", name: "Nova", position: 2000 }),
    ]);
    expect(entrada?.id).toBe("nova");
  });

  it("desempata a posição pelo id, para duas execuções escolherem a mesma etapa", () => {
    const a = etapaDeEntrada([
      etapa({ id: "b", name: "B", position: 1000 }),
      etapa({ id: "a", name: "A", position: 1000 }),
    ]);
    const b = etapaDeEntrada([
      etapa({ id: "a", name: "A", position: 1000 }),
      etapa({ id: "b", name: "B", position: 1000 }),
    ]);
    expect(a?.id).toBe("a");
    expect(b?.id).toBe("a");
  });

  it("funil sem etapa de andamento não tem entrada", () => {
    expect(etapaDeEntrada([etapa({ id: "g", name: "Ganho", is_won: true })])).toBeNull();
  });
});

describe("validarDestinoDaTransferencia", () => {
  const etapas = [etapa({ id: "novo", name: "Novo", pipeline_id: "destino" })];

  it("sem etapa escolhida, devolve a entrada do destino", () => {
    const r = validarDestinoDaTransferencia({
      origemId: "origem",
      destinoId: "destino",
      funis: FUNIS,
      etapasDoDestino: etapas,
    });
    expect(r.ok && r.valor.etapa.id).toBe("novo");
  });

  it("com etapa escolhida, devolve ELA — não a primeira do destino", () => {
    const r = validarDestinoDaTransferencia({
      origemId: "origem",
      destinoId: "destino",
      etapaId: "andamento",
      funis: FUNIS,
      etapasDoDestino: [...etapas, etapa({ id: "andamento", name: "Em andamento", pipeline_id: "destino", position: 2000 })],
    });
    expect(r.ok && r.valor.etapa.id).toBe("andamento");
  });

  it("recusa o próprio funil", () => {
    const r = validarDestinoDaTransferencia({
      origemId: "origem",
      destinoId: "origem",
      funis: FUNIS,
      etapasDoDestino: etapas,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.codigo).toBe("pipeline_unchanged");
  });

  it("recusa destino fora da organização", () => {
    const r = validarDestinoDaTransferencia({
      origemId: "origem",
      destinoId: "de-outro-tenant",
      funis: FUNIS,
      etapasDoDestino: etapas,
    });
    expect(!r.ok && r.codigo).toBe("not_found");
  });

  it("recusa destino arquivado", () => {
    const r = validarDestinoDaTransferencia({
      origemId: "origem",
      destinoId: "destino",
      funis: [FUNIS[0]!, funil({ id: "destino", name: "Clínica", is_archived: true })],
      etapasDoDestino: etapas,
    });
    expect(!r.ok && r.erro).toContain("{nome}");
  });

  it("recusa etapa que não é do destino", () => {
    const r = validarDestinoDaTransferencia({
      origemId: "origem",
      destinoId: "destino",
      etapaId: "de-outro-funil",
      funis: FUNIS,
      etapasDoDestino: etapas,
    });
    expect(!r.ok && r.codigo).toBe("stage_not_found");
  });

  it("recusa etapa de fechamento — transferir para lá encerraria todos os negócios", () => {
    const r = validarDestinoDaTransferencia({
      origemId: "origem",
      destinoId: "destino",
      etapaId: "perdido",
      funis: FUNIS,
      etapasDoDestino: [etapa({ id: "perdido", name: "Perdido", pipeline_id: "destino", is_lost: true })],
    });
    expect(!r.ok && r.erro).toContain("TODOS");
  });

  it("recusa destino sem etapa de andamento", () => {
    const r = validarDestinoDaTransferencia({
      origemId: "origem",
      destinoId: "destino",
      funis: FUNIS,
      etapasDoDestino: [etapa({ id: "ganho", name: "Ganho", pipeline_id: "destino", is_won: true })],
    });
    expect(!r.ok && r.codigo).toBe("pipeline_without_entry_stage");
  });
});

describe("resumoDaOperacao", () => {
  const base = {
    escolha: "transferir" as const,
    origem_pipeline_id: "origem",
    destino_pipeline_id: "destino",
    destino_stage_id: "novo",
    negocios_antes: 3,
  };

  it("mantém o número medido quando ele é coerente", () => {
    expect(resumoDaOperacao({ ...base, movidos: 3, restantes: 0 }).movidos).toBe(3);
  });

  it("não deixa a auditoria afirmar mais do que o funil tinha", () => {
    expect(resumoDaOperacao({ ...base, movidos: 9, restantes: 0 }).movidos).toBe(3);
    expect(resumoDaOperacao({ ...base, movidos: -2, restantes: 5 }).movidos).toBe(0);
  });
});
