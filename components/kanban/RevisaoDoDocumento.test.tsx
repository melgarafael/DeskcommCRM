// components/kanban/RevisaoDoDocumento.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RevisaoDoDocumento } from "./RevisaoDoDocumento";

/**
 * A REVISÃO DO DOCUMENTO NA TELA (#3316).
 *
 * ─── O defeito que este arquivo mede ───────────────────────────────────────
 *
 * No #3415 a fila de revisão existia só como API: havia `GET`/`POST`
 * `/api/v1/leads/[id]/field-proposals`, com teste de rota, e NENHUM componente
 * que a mostrasse ao atendente. A rota verde provava que o servidor sabia
 * responder — não que alguém pudesse decidir. Estes testes são do COMPONENTE:
 * o que chega ao olho de quem atende, e o que o clique manda.
 *
 * ─── O que é mockado ───────────────────────────────────────────────────────
 *
 * Só o `fetch` — a fronteira com o servidor. Todo o resto é o componente real,
 * inclusive a conta que separa "aceitar como está" de "corrigir e aceitar" (ela
 * decide se o corpo leva `valor`), que é a única parte com regra própria.
 */

const PROPOSTA = {
  id: "p1",
  campo: "localizador",
  rotulo: "Localizador",
  tipo: "text",
  valor_atual: null,
  valor_proposto: "ABC123",
  trecho: "Localizador: ABC123 — confirmação da reserva",
  documento: { id: "a1", nome: "voucher.pdf", url: "/api/v1/leads/l1/attachments/a1/media" },
  expires_at: "2099-01-01T00:00:00.000Z",
};

function respondeJson(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe("a revisão do documento no card (#3316)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("⭐ mostra o valor proposto, o atual, o TRECHO de onde veio e o documento", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => respondeJson({ data: { propostas: [PROPOSTA] } })),
    );

    render(<RevisaoDoDocumento leadId="l1" podeDecidir />);

    // O valor que a IA leu e o que está no card hoje, lado a lado.
    expect(await screen.findByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText(/hoje:/)).toBeInTheDocument();
    // O trecho é a coluna que permite CONFERIR em vez de acreditar: sem ele a
    // proposta não nasce no servidor, e sem ele a tela não deveria confirmá-la.
    expect(screen.getByText(/Localizador: ABC123/)).toBeInTheDocument();
    // O arquivo, para abrir o documento ao lado do trecho.
    expect(screen.getByRole("link", { name: /Abrir o documento/ })).toHaveAttribute(
      "href",
      "/api/v1/leads/l1/attachments/a1/media",
    );
    expect(screen.getByText(/Nada foi gravado no card ainda/)).toBeInTheDocument();
  });

  it("sem nada pendente a seção NÃO existe — seção vazia ensina a ignorar o espaço", async () => {
    vi.stubGlobal("fetch", vi.fn(() => respondeJson({ data: { propostas: [] } })));

    const { container } = render(<RevisaoDoDocumento leadId="l1" podeDecidir />);

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container.querySelector('[data-peca="revisao-do-documento"]')).toBeNull();
  });

  it("'Está certo, salvar' manda a decisão SEM `valor` — aceitar não é corrigir", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      url.endsWith("/field-proposals")
        ? respondeJson({ data: { propostas: [PROPOSTA] } })
        : respondeJson({ data: { decision: "accepted", campo: "localizador" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const aoDecidir = vi.fn();
    const user = userEvent.setup();

    render(<RevisaoDoDocumento leadId="l1" podeDecidir aoDecidir={aoDecidir} />);
    await user.click(await screen.findByRole("button", { name: "Está certo, salvar" }));

    await waitFor(() => expect(aoDecidir).toHaveBeenCalled());
    const chamada = fetchMock.mock.calls.find(([url]) => String(url).includes("/field-proposals/p1"));
    expect(chamada).toBeDefined();
    const corpo = JSON.parse(String(chamada?.[1]?.body));
    expect(corpo).toEqual({ decision: "accept" });
    expect("valor" in corpo).toBe(false);
  });

  it("⭐ a pessoa CORRIGE e o corpo leva o valor digitado — a IA lê errado", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      url.endsWith("/field-proposals")
        ? respondeJson({ data: { propostas: [PROPOSTA] } })
        : respondeJson({ data: { decision: "accepted", campo: "localizador" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<RevisaoDoDocumento leadId="l1" podeDecidir />);

    const campo = await screen.findByRole("textbox", { name: /Corrigir Localizador/ });
    // O input nasce com o valor PROPOSTO: corrigir é editar o que está lá, não
    // digitar tudo de novo.
    expect(campo).toHaveValue("ABC123");
    await user.clear(campo);
    await user.type(campo, "XYZ789");
    await user.click(screen.getByRole("button", { name: "Está certo, salvar" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/field-proposals/p1"))).toBe(
        true,
      ),
    );
    const chamada = fetchMock.mock.calls.find(([url]) => String(url).includes("/field-proposals/p1"));
    expect(JSON.parse(String(chamada?.[1]?.body))).toEqual({
      decision: "accept",
      valor: "XYZ789",
    });
  });

  it("o 409 do servidor ('venceu pelo prazo') aparece na tela e a proposta FICA", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      url.endsWith("/field-proposals")
        ? respondeJson({ data: { propostas: [PROPOSTA] } })
        : respondeJson(
            { error: { message: "Esta sugestão venceu pelo prazo." } },
            false,
            409,
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<RevisaoDoDocumento leadId="l1" podeDecidir />);
    await user.click(await screen.findByRole("button", { name: "Está certo, salvar" }));

    // A frase do servidor, não uma genérica: é ela que explica por que o clique
    // não valeu. E a proposta continua na tela — sumir diria "decidido".
    expect(await screen.findByText("Esta sugestão venceu pelo prazo.")).toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
  });

  it("quem não pode editar o card LÊ a fila, mas não vê botão de decisão", async () => {
    vi.stubGlobal("fetch", vi.fn(() => respondeJson({ data: { propostas: [PROPOSTA] } })));

    render(<RevisaoDoDocumento leadId="l1" podeDecidir={false} />);

    expect(await screen.findByText("ABC123")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Está certo, salvar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
