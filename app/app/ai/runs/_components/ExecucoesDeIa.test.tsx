/**
 * "Ver as decisões do Jev", no cartão dele, abre esta tela com `?provider=typesafe`.
 * O filtro tem de chegar à rota (antes da onda do Jev, a rota o descartava e a
 * lista vinha inteira) e a linha tem de dizer "Jev", não o id da coluna.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExecucoesDeIa } from "./ExecucoesDeIa";

const substituir = vi.fn();
let busca = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: substituir }),
  usePathname: () => "/app/ai/runs",
  useSearchParams: () => new URLSearchParams(busca),
}));

const LINHA_DO_JEV = {
  id: "r1",
  purpose: "sentiment_classify",
  pontoRotulo: "Medir o clima da conversa",
  provider: "typesafe",
  provedorRotulo: "Jev (TypeSafe AI)",
  model: "typesafe/jev-1.13.0",
  status: "ok",
  error_code: null,
  error_message: null,
  http_status: null,
  consequencia: null,
  oQueFazer: null,
  porQueEsteModelo: null,
  input_tokens: 40,
  output_tokens: 3,
  cost_cents: 0.000168,
  latency_ms: 361,
  created_at: "2026-09-23T12:00:00Z",
};

let pedidas: string[] = [];

beforeEach(() => {
  pedidas = [];
  substituir.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      pedidas.push(url);
      return new Response(
        JSON.stringify({
          data: { execucoes: [LINHA_DO_JEV], resumo: { total: 1, erros: 0, porCodigo: [] } },
        }),
        { status: 200 },
      );
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("ExecucoesDeIa — o filtro do Jev", () => {
  it("o ?provider= da URL chega à rota, e a linha nomeia o Jev", async () => {
    busca = "provider=typesafe";
    render(<ExecucoesDeIa />);
    await screen.findByTestId("execucao-r1");
    expect(pedidas).toEqual(["/api/v1/ai/runs?provider=typesafe"]);
    expect(screen.getByTestId("execucao-r1")).toHaveTextContent("Jev (TypeSafe AI) · typesafe/jev-1.13.0");
    expect(screen.getByTestId("filtro-jev")).toHaveAttribute("aria-pressed", "true");
    // Fração de centavo não vira "US$ 0,00": 0,000168 centavo = US$ 0,000002.
    expect(screen.getByTestId("execucao-r1")).not.toHaveTextContent(/US\$\s?0,00(?!0)/);
    expect(screen.getByTestId("execucao-r1")).toHaveTextContent(/US\$\s?0,000002/);
  });

  it("o filtro de falhas soma ao do Jev, não o substitui", async () => {
    busca = "provider=typesafe";
    render(<ExecucoesDeIa />);
    fireEvent.click(await screen.findByTestId("filtro-erros"));
    await waitFor(() => expect(pedidas).toContain("/api/v1/ai/runs?status=erro&provider=typesafe"));
  });

  it("'Só o Jev' põe o filtro na URL; clicado de novo, tira", async () => {
    busca = "";
    const { unmount } = render(<ExecucoesDeIa />);
    fireEvent.click(await screen.findByTestId("filtro-jev"));
    expect(substituir).toHaveBeenCalledWith("/app/ai/runs?provider=typesafe");
    expect(pedidas).toEqual(["/api/v1/ai/runs"]);
    unmount();

    busca = "provider=typesafe";
    render(<ExecucoesDeIa />);
    fireEvent.click(await screen.findByTestId("filtro-jev"));
    expect(substituir).toHaveBeenLastCalledWith("/app/ai/runs");
  });

  it("sem nenhuma execução do Jev e sem o filtro, o botão não aparece", async () => {
    busca = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              execucoes: [{ ...LINHA_DO_JEV, provider: "anthropic", provedorRotulo: "Anthropic (Claude)" }],
              resumo: { total: 1, erros: 0, porCodigo: [] },
            },
          }),
          { status: 200 },
        ),
      ),
    );
    render(<ExecucoesDeIa />);
    await screen.findByTestId("execucao-r1");
    expect(screen.queryByTestId("filtro-jev")).toBeNull();
  });
});
