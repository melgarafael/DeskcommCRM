import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AcervoSearch } from "./AcervoSearch";
import { apiClient } from "@/lib/api/client";

/**
 * "PERGUNTAR AO ACERVO" NA TELA DO INBOX (#1869, F1).
 *
 * ─── O que este arquivo mede, e o que ele NÃO mede ──────────────────────────
 *
 * O retrieval não mora aqui: quem decide limiar, top-K e o texto de "não tem"
 * é a rota, que chama `buscarConhecimento` — a mesma operação da IA. O que este
 * arquivo tranca é o que o operador VÊ:
 *
 *  1. digitar e enviar mostra os trechos, cada um com o nome do material de
 *     onde saiu (é a citação que separa "a IA respondeu" de "a IA inventou");
 *  2. quando a base não tem a resposta, a tela diz exatamente isso — não mostra
 *     uma lista vazia muda, que o atendente leria como "a tela quebrou";
 *  3. o corpo do POST leva SÓ a pergunta. A organização vem do cookie, e a tela
 *     nem tem de onde tirá-la: mandar `organization_id` daqui seria uma segunda
 *     fonte de verdade para o tenant.
 *
 * A borda dublada é o `apiClient` (faria rede). O componente é o de verdade —
 * dublar o componente provaria o dublê.
 */

const resposta = vi.hoisted(() => ({
  valor: {
    trechos: [] as Array<{
      chunk_id: string;
      source_name?: string | null;
      content: string;
      similarity: number;
    }>,
    melhorSimilaridade: null as number | null,
    motivo: null as string | null,
    acervo: { fontes: 0, limiar: 0.4 },
  },
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: vi.fn(async () => ({ data: resposta.valor })),
  },
}));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  resposta.valor = {
    trechos: [],
    melhorSimilaridade: null,
    motivo: null,
    acervo: { fontes: 0, limiar: 0.4 },
  };
});

async function perguntar(texto: string) {
  const usuario = userEvent.setup();
  await usuario.type(screen.getByTestId("acervo-pergunta"), texto);
  await usuario.click(screen.getByTestId("acervo-buscar"));
}

describe("perguntar ao acervo pelo inbox", () => {
  it("mostra os trechos com o nome do material de origem", async () => {
    resposta.valor = {
      trechos: [
        {
          chunk_id: "c1",
          source_name: "Manual do plano",
          content: "O prazo de entrega é de 5 dias úteis.",
          similarity: 0.87,
        },
      ],
      melhorSimilaridade: 0.87,
      motivo: null,
      acervo: { fontes: 1, limiar: 0.4 },
    };

    render(<AcervoSearch />);
    await perguntar("qual o prazo de entrega");

    await waitFor(() => expect(screen.getAllByTestId("acervo-trecho")).toHaveLength(1));
    expect(screen.getByText("O prazo de entrega é de 5 dias úteis.")).toBeTruthy();
    // A ORIGEM: sem ela o trecho é um parágrafo anônimo.
    expect(screen.getByText("Manual do plano")).toBeTruthy();
    // E qual acervo foi consultado — acervo vazio sem este número parece defeito.
    expect(screen.getByTestId("acervo-resumo").textContent).toContain("Materiais consultados");
    expect(screen.getByTestId("acervo-resumo").textContent).toContain("1");
  });

  it("base sem a informação diz 'a base não tem essa informação'", async () => {
    // O motivo vem da rota; quando ele falta, a tela não pode ficar muda.
    resposta.valor = {
      trechos: [],
      melhorSimilaridade: null,
      motivo: "A base não tem essa informação.",
      acervo: { fontes: 2, limiar: 0.4 },
    };

    render(<AcervoSearch />);
    await perguntar("vocês entregam aos sábados?");

    await waitFor(() =>
      expect(screen.getByTestId("acervo-motivo").textContent).toContain(
        "A base não tem essa informação.",
      ),
    );
    // Lista vazia não é resposta: nada de `acervo-trechos` "vazio e mudo".
    expect(screen.queryByTestId("acervo-trechos")).toBeNull();
  });

  it("manda SÓ a pergunta — a organização é a da sessão", async () => {
    render(<AcervoSearch />);
    await perguntar("qual o horário");

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    const [url, corpo] = vi.mocked(apiClient.post).mock.calls[0]!;
    expect(url).toBe("/api/v1/ai/knowledge/busca");
    expect(corpo).toEqual({ pergunta: "qual o horário" });
    expect(corpo).not.toHaveProperty("organization_id");
    expect(corpo).not.toHaveProperty("organizationId");
  });
});
