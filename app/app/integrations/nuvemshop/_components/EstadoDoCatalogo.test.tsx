import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * O ESTADO DA FONTE "Catálogo de produtos" NA TELA DA INTEGRAÇÃO (#4357).
 *
 * A tela da Nuvemshop passa a mostrar o que de fato aconteceu com o catálogo:
 * quantos trechos entraram, quando foi preparado pela última vez e o erro, se
 * houve. "Preparar de novo" chama a rota que já existe
 * (`/api/v1/ai/knowledge/sources/:id/reindex`) pelo hook compartilhado — nenhuma
 * rota nova, nenhuma leitura paralela.
 *
 * O caso que importa de verdade é o VAZIO: organização conectada que ainda não
 * sincronizou produto nenhum não pode ler "a integração está quebrada". Ela
 * ainda não fez nada de errado.
 */

const { sourcesMock, mutateMock, pendingMock } = vi.hoisted(() => ({
  sourcesMock: vi.fn(),
  mutateMock: vi.fn(),
  pendingMock: { value: false },
}));

vi.mock("@/hooks/ai/useKnowledgeSources", () => ({
  useKnowledgeSources: sourcesMock,
  useReindexSource: () => ({ mutate: mutateMock, isPending: pendingMock.value }),
}));

import { EstadoDoCatalogo } from "./EstadoDoCatalogo";

const FONTE = {
  id: "33333333-3333-4333-8333-333333333333",
  agent_id: null,
  organization_id: "11111111-1111-4111-8111-111111111111",
  source_type: "catalogo",
  name: "Catálogo de produtos",
  status: "ready",
  last_index_status: "success",
  last_index_error: null,
  last_indexed_at: "2026-11-09T14:30:00.000Z",
  chunks_count: 42,
  is_active: true,
  source_metadata: {},
  active_kb_version_id: null,
  created_at: "2026-10-20T10:00:00.000Z",
  updated_at: "2026-11-09T14:30:00.000Z",
};

function montar(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingMock.value = false;
});

describe("estado do catálogo na tela da Nuvemshop", () => {
  it("com a fonte preparada, mostra os trechos e quando foi preparada", () => {
    sourcesMock.mockReturnValue({ data: [FONTE], isError: false, isLoading: false });

    montar(<EstadoDoCatalogo podePreparar />);

    expect(screen.getByTestId("catalogo-nuvemshop")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText(/2026/)).toBeTruthy();
    expect(screen.getByText("Preparado em")).toBeTruthy();
  });

  it("com a fonte falhando, mostra o erro que o índice registrou", () => {
    sourcesMock.mockReturnValue({
      data: [
        {
          ...FONTE,
          last_index_status: "failed",
          last_index_error: "Limite de embeddings da organização atingido.",
          chunks_count: 0,
        },
      ],
      isError: false,
      isLoading: false,
    });

    montar(<EstadoDoCatalogo podePreparar />);

    expect(screen.getByText("Limite de embeddings da organização atingido.")).toBeTruthy();
  });

  it("sem fonte, o estado vazio é honesto: não afirma que a integração quebrou", () => {
    sourcesMock.mockReturnValue({ data: [], isError: false, isLoading: false });

    montar(<EstadoDoCatalogo podePreparar />);

    const vazio = screen.getByTestId("catalogo-vazio");
    expect(vazio.textContent).toContain("ainda não foi preparado");
    // O que NÃO pode estar escrito: a conclusão errada que a issue relata.
    expect(vazio.textContent?.toLowerCase()).not.toMatch(/quebrad|falh|erro/);
  });

  it("se a leitura do estado falhar, diz que não conseguiu ler — e não que a integração caiu", () => {
    sourcesMock.mockReturnValue({ data: undefined, isError: true, isLoading: false });

    montar(<EstadoDoCatalogo podePreparar />);

    const erro = screen.getByTestId("catalogo-erro-leitura");
    expect(erro.textContent).toContain("Não consegui ler o estado do catálogo agora");
    expect(erro.textContent?.toLowerCase()).not.toMatch(/quebrad/);
  });

  it("'Preparar de novo' reindexa a fonte que está na tela", () => {
    sourcesMock.mockReturnValue({ data: [FONTE], isError: false, isLoading: false });

    montar(<EstadoDoCatalogo podePreparar />);

    fireEvent.click(screen.getByTestId("catalogo-preparar-de-novo"));
    expect(mutateMock).toHaveBeenCalledWith(FONTE.id);
  });

  it("controle positivo: quem não pode preparar vê o estado, sem botão que não obedece", () => {
    sourcesMock.mockReturnValue({ data: [FONTE], isError: false, isLoading: false });

    montar(<EstadoDoCatalogo podePreparar={false} />);

    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.queryByTestId("catalogo-preparar-de-novo")).toBeNull();
  });
});
