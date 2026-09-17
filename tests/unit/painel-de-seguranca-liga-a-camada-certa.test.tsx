/**
 * O INTERRUPTOR TEM DE GRAVAR A CAMADA, NÃO O NOME DA TELA.
 *
 * Cada conferência tem dois identificadores: `nome` ("jailbreak_detect"), que é
 * de tela, e `camada` ("jailbreak"), que é a chave de `org_guardrail_layers` e o
 * único valor que `PUT /api/v1/ai/guardrail-layers` aceita — a rota valida
 * contra o enum `CAMADAS_SEMANTICAS`.
 *
 * O interruptor mandava o `nome`, e ligar qualquer uma das duas camadas
 * devolvia 422 em toda instalação. A posição do controle parecia certa porque a
 * LEITURA já usava `camada`; só a escrita divergia.
 *
 * O typecheck não pegava: o call site fazia `layer as CamadaDeSeguranca["layer"]`,
 * e um `as` desliga exatamente a checagem que reprovaria isto. O conserto tira o
 * cast — mas um cast volta fácil num refactor, então a fiação fica medida aqui.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const gravar = vi.fn();

vi.mock("@/hooks/ai/useGuardrailLayers", () => ({
  useGuardrailLayers: () => ({
    data: {
      camadas: [
        { layer: "promessa_semantica", escolha: false, padraoDoAmbiente: false, efetivo: false },
        { layer: "jailbreak", escolha: false, padraoDoAmbiente: false, efetivo: false },
      ],
      podeEditar: true,
    },
  }),
  useSetGuardrailLayer: () => ({ mutate: gravar, isPending: false }),
}));

import { PainelDeSeguranca } from "@/app/app/ai/agents/[id]/_components/PainelDeSeguranca";
import { CONFERENCIA_DE_ENTRADA, CONFERENCIAS_DE_SAIDA } from "@/lib/ai/guardrails/lista-de-conferencia";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PainelDeSeguranca />
    </QueryClientProvider>,
  );
}

/** As conferências que TÊM interruptor — as outras não se desligam. */
const COM_ESCOLHA = [...CONFERENCIAS_DE_SAIDA, CONFERENCIA_DE_ENTRADA].filter(
  (c) => c.camada !== null,
);

describe("o interruptor de segurança grava a camada, não o nome de tela", () => {
  it("o instrumento está vivo: existe conferência com escolha, e nome ≠ camada", () => {
    // Controle positivo. Se a lista ficasse vazia (refactor, renomeação), o
    // `it.each` abaixo passaria por vacuidade — zero caso é zero reprovação.
    expect(COM_ESCOLHA.length).toBeGreaterThanOrEqual(2);
    expect(COM_ESCOLHA.some((c) => c.nome !== c.camada)).toBe(true);
  });

  it.each(COM_ESCOLHA)("«$rotulo» manda layer=$camada", (c) => {
    gravar.mockClear();
    montar();

    fireEvent.click(screen.getByTestId(`conferencia-${c.nome}-liga`));

    expect(gravar).toHaveBeenCalledTimes(1);
    expect(gravar).toHaveBeenCalledWith({ layer: c.camada, enabled: true });
    // O nome de tela NÃO pode chegar à rota: é o valor que ela recusa com 422.
    expect(gravar).not.toHaveBeenCalledWith(expect.objectContaining({ layer: c.nome }));
  });
});
