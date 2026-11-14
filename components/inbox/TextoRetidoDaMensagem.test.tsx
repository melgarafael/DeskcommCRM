/**
 * Os quatro estados do botão **Ver texto retido** (#4500).
 *
 * O ponto do teste é o que o NAVEGADOR recebe: no caso sem permissão, a
 * resposta do servidor não carrega o texto — a tela não pode mostrar o que não
 * chegou, e o mock abaixo devolve exatamente o que a rota devolveria (o corpo do
 * erro, sem conteúdo).
 *
 * Texto fictício, sempre: nenhum conteúdo real de cliente entra em teste.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TextoRetidoDaMensagem } from "./TextoRetidoDaMensagem";

const TEXTO_FICTICIO = "combinado fictício de teste, 3 caixas";

function resposta(status: number, corpo: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
    text: async () => JSON.stringify(corpo),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verificando", () => {
  it("mostra 'Verificando permissão…' enquanto o servidor decide e depois revela", async () => {
    let liberar: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => { liberar = resolve; }),
    );

    const user = userEvent.setup();
    render(<TextoRetidoDaMensagem mensagemId="m1" />);

    await user.click(screen.getByRole("button", { name: "Ver texto retido" }));
    expect(screen.getByRole("status")).toHaveTextContent("Verificando permissão…");
    expect(screen.queryByRole("button", { name: "Ver texto retido" })).not.toBeInTheDocument();

    liberar(resposta(200, { data: { texto: TEXTO_FICTICIO } }));

    await waitFor(() => expect(screen.getByTestId("texto-retido")).toHaveTextContent(TEXTO_FICTICIO));
  });

  it("pede o texto numa rota por mensagem, sem mandar nada no corpo", async () => {
    fetchMock.mockResolvedValue(resposta(200, { data: { texto: TEXTO_FICTICIO } }));
    const user = userEvent.setup();
    render(<TextoRetidoDaMensagem mensagemId="m1" />);

    await user.click(screen.getByRole("button", { name: "Ver texto retido" }));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/messages/m1/texto-retido");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});

describe("sem permissão", () => {
  it("403 vira a frase de recusa e NENHUM texto aparece", async () => {
    fetchMock.mockResolvedValue(
      resposta(403, { error: { code: "forbidden_role", message: "Você não tem permissão para ver este texto." } }),
    );

    const user = userEvent.setup();
    render(<TextoRetidoDaMensagem mensagemId="m1" />);
    await user.click(screen.getByRole("button", { name: "Ver texto retido" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Você não tem permissão para ver este texto"),
    );
    expect(screen.queryByTestId("texto-retido")).not.toBeInTheDocument();
    // Nada do que a resposta trouxe virou conteúdo na tela.
    expect(document.body.textContent).not.toContain(TEXTO_FICTICIO);
  });
});

describe("texto indisponível", () => {
  it("409 vira 'Texto não disponível'", async () => {
    fetchMock.mockResolvedValue(
      resposta(409, { error: { code: "texto_indisponivel", message: "Texto não disponível." } }),
    );

    const user = userEvent.setup();
    render(<TextoRetidoDaMensagem mensagemId="m1" />);
    await user.click(screen.getByRole("button", { name: "Ver texto retido" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Texto não disponível"));
  });

  it("falha de rede não vira 'sem permissão'", async () => {
    fetchMock.mockRejectedValue(new Error("rede caiu"));

    const user = userEvent.setup();
    render(<TextoRetidoDaMensagem mensagemId="m1" />);
    await user.click(screen.getByRole("button", { name: "Ver texto retido" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Texto não disponível"));
    expect(document.body.textContent).not.toContain("permissão para ver");
  });
});

describe("revelado", () => {
  it("o texto entra no lugar do botão e o botão não volta", async () => {
    fetchMock.mockResolvedValue(resposta(200, { data: { texto: TEXTO_FICTICIO } }));

    const user = userEvent.setup();
    render(<TextoRetidoDaMensagem mensagemId="m1" />);
    await user.click(screen.getByRole("button", { name: "Ver texto retido" }));

    await waitFor(() => expect(screen.getByTestId("texto-retido")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Ver texto retido" })).not.toBeInTheDocument();
  });

  it("200 sem texto é indisponível, não tela vazia", async () => {
    fetchMock.mockResolvedValue(resposta(200, { data: { texto: "" } }));

    const user = userEvent.setup();
    render(<TextoRetidoDaMensagem mensagemId="m1" />);
    await user.click(screen.getByRole("button", { name: "Ver texto retido" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Texto não disponível"));
  });
});
