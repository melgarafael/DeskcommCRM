/**
 * O resolvedor de nome de etapa do construtor tem três respostas, e a diferença
 * entre elas é o que separa um aviso útil de uma acusação falsa:
 *
 *   - "…"   → ainda não sei (a lista não chegou, ou a leitura falhou);
 *   - nome  → é esta etapa;
 *   - null  → NÃO existe etapa com esse id, e o cartão acusa.
 *
 * Quem lê o `null` é o cartão (`regraSemEtapa`, comparação estrita) e a frase da
 * regra ("(não encontrada)"). Sem este arquivo, a linha que decide as três
 * respostas não é executada por teste nenhum — e ela é uma linha só.
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import * as hook from "@/hooks/followup/useEtapasDeGatilho";

import { EtapasDoFluxoProvider, useEtapasDoFluxo } from "./EtapasDoFluxo";

// Mocka o SEAM DE REDE, não o provider: o que está sob teste é justamente o que
// o provider faz com a resposta do hook. `nomeDaEtapa` vem do mesmo módulo e é
// preservado de propósito — é ele que compõe «Etapa · Funil».
vi.mock("@/hooks/followup/useEtapasDeGatilho", async (original) => {
  const real = await original<typeof hook>();
  return { ...real, useEtapasDeGatilho: vi.fn() };
});

const ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const PAGO = { stageId: ID, stageName: "Pago", pipelineId: "p1", pipelineName: "Vendas", isPerda: false, settingsDoFunil: null };

function resolver(estado: hook.EtapasDeGatilho): (id: string) => string | null {
  vi.mocked(hook.useEtapasDeGatilho).mockReturnValue(estado);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <EtapasDoFluxoProvider>{children}</EtapasDoFluxoProvider>
  );
  const { result } = renderHook(() => useEtapasDoFluxo(), { wrapper });
  return (id: string) => result.current.nomes.etapa?.(id) ?? null;
}

describe("EtapasDoFluxoProvider — o resolvedor distingue 'não sei' de 'não existe'", () => {
  it("etapa conhecida aparece como «Etapa · Funil»", () => {
    const nome = resolver({ etapas: [PAGO], carregando: false, falhou: false });
    expect(nome(ID)).toBe("Pago · Vendas");
  });

  it("enquanto carrega, responde reticências — ninguém é acusado por uma lista que ainda vem", () => {
    const nome = resolver({ etapas: [], carregando: true, falhou: false });
    expect(nome(ID)).toBe("…");
  });

  it("quando a leitura FALHA, também responde reticências — vazio por falha não é vazio por ausência", () => {
    const nome = resolver({ etapas: [], carregando: false, falhou: true });
    expect(nome(ID)).toBe("…");
  });

  it("com a lista assentada, id fora dela é null — este é o caso que PRECISA acusar", () => {
    const nome = resolver({ etapas: [PAGO], carregando: false, falhou: false });
    expect(nome("1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d")).toBeNull();
  });
});
