/**
 * #4133 item 4 — MODO DE CONHECIMENTO POR AGENTE.
 *
 * Prova que `busca` é o comportamento de HOJE (regressão: `search_knowledge`
 * montada e removida nos mesmos casos do gate antigo) e que `leitura_direta`
 * troca a busca pela dupla índice + `ler_documento` — sem as duas conviverem.
 */
import { describe, expect, it } from "vitest";

import {
  MODO_DE_CONHECIMENTO_PADRAO,
  aplicarGateDasFerramentasDeConhecimento,
  lerModoDeConhecimento,
  modoEfetivoDeConhecimento,
  planejarConhecimentoDoTurno,
} from "./modo-de-conhecimento";

/** O turno monta as duas; o gate remove a que não cabe. */
function ferramentas() {
  return { search_knowledge: {}, ler_documento: {}, send_message: {} } as Record<string, unknown>;
}

const IDS = ["11111111-1111-4111-8111-111111111111"];

describe("leitura do config", () => {
  it("ausente, nulo ou fora do vocabulário cai em `busca`", () => {
    expect(MODO_DE_CONHECIMENTO_PADRAO).toBe("busca");
    expect(lerModoDeConhecimento(undefined)).toBe("busca");
    expect(lerModoDeConhecimento(null)).toBe("busca");
    expect(lerModoDeConhecimento({})).toBe("busca");
    expect(lerModoDeConhecimento({ knowledge_mode: "LEITURA_DIRETA" })).toBe("busca");
    expect(lerModoDeConhecimento({ knowledge_mode: "leitura_direta" })).toBe("leitura_direta");
  });
});

describe("regressão: `busca` é o turno de HOJE", () => {
  it("com lista de materiais, monta search_knowledge e NÃO monta ler_documento", () => {
    const ferramentasDoTurno = ferramentas();
    aplicarGateDasFerramentasDeConhecimento(ferramentasDoTurno, {
      modo: "busca",
      knowledgeSourceIds: IDS,
      activeKbVersionId: null,
    });
    expect(Object.keys(ferramentasDoTurno)).toEqual(["search_knowledge", "send_message"]);
  });

  it("com só o ponteiro legado, mantém search_knowledge", () => {
    const ferramentasDoTurno = ferramentas();
    aplicarGateDasFerramentasDeConhecimento(ferramentasDoTurno, {
      modo: "busca",
      knowledgeSourceIds: [],
      activeKbVersionId: "kb-v1",
    });
    expect(ferramentasDoTurno.search_knowledge).toBeDefined();
    expect(ferramentasDoTurno.ler_documento).toBeUndefined();
  });

  it("sem lista E sem ponteiro, remove search_knowledge (o gate de sempre)", () => {
    const ferramentasDoTurno = ferramentas();
    aplicarGateDasFerramentasDeConhecimento(ferramentasDoTurno, {
      modo: "busca",
      knowledgeSourceIds: [],
      activeKbVersionId: null,
    });
    expect(ferramentasDoTurno.search_knowledge).toBeUndefined();
    expect(ferramentasDoTurno.ler_documento).toBeUndefined();
    expect(ferramentasDoTurno.send_message).toBeDefined();
  });
});

describe("leitura_direta: índice + ler_documento, sem busca", () => {
  it("injeta o índice e monta ler_documento; search_knowledge NÃO entra", () => {
    const plano = planejarConhecimentoDoTurno({
      modo: "leitura_direta",
      knowledgeSourceIds: IDS,
      activeKbVersionId: null,
    });
    expect(plano).toEqual({
      modo: "leitura_direta",
      injetaIndice: true,
      montaLeitura: true,
      montaBusca: false,
    });

    const ferramentasDoTurno = ferramentas();
    aplicarGateDasFerramentasDeConhecimento(ferramentasDoTurno, {
      modo: "leitura_direta",
      knowledgeSourceIds: IDS,
      activeKbVersionId: null,
    });
    expect(Object.keys(ferramentasDoTurno)).toEqual(["ler_documento", "send_message"]);
  });

  it("sem lista de materiais cai no modo `busca` (não fica sem ferramenta)", () => {
    const ctx = {
      modo: "leitura_direta" as const,
      knowledgeSourceIds: [],
      activeKbVersionId: "kb-v1",
    };
    expect(modoEfetivoDeConhecimento(ctx)).toBe("busca");
    const plano = planejarConhecimentoDoTurno(ctx);
    expect(plano.injetaIndice).toBe(false);
    expect(plano.montaBusca).toBe(true);
    expect(plano.montaLeitura).toBe(false);
  });

  it("agente sem material nenhum não ganha índice nem ferramenta", () => {
    const plano = planejarConhecimentoDoTurno({
      modo: "leitura_direta",
      knowledgeSourceIds: [],
      activeKbVersionId: null,
    });
    expect(plano).toEqual({
      modo: "busca",
      injetaIndice: false,
      montaLeitura: false,
      montaBusca: false,
    });
  });
});
