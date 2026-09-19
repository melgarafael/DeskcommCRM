import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/onboarding/marcarTeste", () => ({
  marcarTesteFeito: vi.fn(),
  pularTeste: vi.fn(),
}));

import { TestarClient } from "@/app/onboarding/testar/_client";
import { urlEnsaioDoAgente } from "@/lib/ai/agents/rota-de-ensaio";

const AGENTE = "aaaaaaaa-0000-4000-8000-000000000001";
const VERSAO = "bbbbbbbb-0000-4000-8000-000000000002";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function montar() {
  render(
    <TestarClient nome="Assistente Sigilium" agenteId={AGENTE} versaoId={VERSAO} noAr={false} />,
  );
}

describe("ensaio interno com rascunho configurado", () => {
  it("com versão em rascunho mostra o formulário de ensaio, não o bloqueio antigo", () => {
    montar();
    expect(screen.getByTestId("aviso-ensaio-sem-canal")).toHaveTextContent(
      "Você pode testar este agente aqui. Para atender clientes, conecte um canal.",
    );
    expect(screen.getByRole("button", { name: "Mandar mensagem" })).toBeEnabled();
    expect(
      screen.queryByText(/Rascunho não responde mensagem, então não há o que ensaiar/i),
    ).not.toBeInTheDocument();
  });

  it("sem versão continua sem o que ensaiar", () => {
    render(
      <TestarClient
        nome="Assistente Sigilium"
        agenteId={AGENTE}
        versaoId={null}
        noAr={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Mandar mensagem" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("ainda não foi para o ar.");
  });
});

describe("Mandar mensagem — um POST, sem retry", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("429 dispara exatamente 1 fetch", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: { code: "rate_limited", message: "slow down" } }, { "Retry-After": "1" }),
    );
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Mandar mensagem" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(urlEnsaioDoAgente(AGENTE, VERSAO));
    const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("503 dispara exatamente 1 fetch", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { error: { code: "unavailable", message: "down" } }),
    );
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Mandar mensagem" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clique duplo durante pending não gera outro POST", async () => {
    let liberar: (value: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          liberar = resolve;
        }),
    );
    montar();
    const botao = screen.getByRole("button", { name: "Mandar mensagem" });
    fireEvent.click(botao);
    fireEvent.click(botao);
    fireEvent.click(botao);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(botao).toBeDisabled();
    liberar(jsonResponse(200, { data: { run_id: "run-1", status: "ok", final_text: "Oi" } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Mandar mensagem" })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
