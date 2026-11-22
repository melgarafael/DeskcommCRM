import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { CHAVE_DA_COR_DA_ETAPA, useCorDaEtapaNoQuadro } from "./useCorDaEtapaNoQuadro";

/**
 * A escolha "só a bolinha / coluna colorida" sobrevive ao F5 e nasce na bolinha
 * (quem não fez nada continua vendo o quadro de sempre).
 */
describe("useCorDaEtapaNoQuadro", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("sem nada gravado, fica na bolinha", () => {
    const { result } = renderHook(() => useCorDaEtapaNoQuadro());
    expect(result.current.naColuna).toBe(false);
    expect(result.current.modo).toBe("bolinha");
  });

  it("lê o 'coluna' gravado depois da montagem", () => {
    window.localStorage.setItem(CHAVE_DA_COR_DA_ETAPA, "coluna");
    const { result } = renderHook(() => useCorDaEtapaNoQuadro());
    expect(result.current.naColuna).toBe(true);
  });

  it("valor gravado desconhecido cai na bolinha", () => {
    window.localStorage.setItem(CHAVE_DA_COR_DA_ETAPA, "qualquer-coisa");
    const { result } = renderHook(() => useCorDaEtapaNoQuadro());
    expect(result.current.naColuna).toBe(false);
  });

  it("alternar grava no navegador nos dois sentidos", () => {
    const { result } = renderHook(() => useCorDaEtapaNoQuadro());
    act(() => result.current.alternar());
    expect(result.current.naColuna).toBe(true);
    expect(window.localStorage.getItem(CHAVE_DA_COR_DA_ETAPA)).toBe("coluna");
    act(() => result.current.alternar());
    expect(result.current.naColuna).toBe(false);
    expect(window.localStorage.getItem(CHAVE_DA_COR_DA_ETAPA)).toBe("bolinha");
  });

  it("navegador que RECUSA o localStorage não derruba o quadro", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      const { result } = renderHook(() => useCorDaEtapaNoQuadro());
      act(() => result.current.alternar());
      expect(result.current.naColuna).toBe(true);
    } finally {
      window.localStorage.setItem = original;
    }
  });
});
