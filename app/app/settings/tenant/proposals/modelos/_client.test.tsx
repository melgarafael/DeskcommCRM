// app/app/settings/tenant/proposals/modelos/_client.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModelosDeProposta } from "./_client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const excluir = vi.hoisted(() => vi.fn());
// `useSearchParams` é CONTROLÁVEL de propósito: a tela lê `?salvo=` da URL e o
// mock fixo (`new URLSearchParams()`) só prova a ausência da faixa. É a
// query string que o editor devolve depois de salvar, e ela precisa ter um caso.
const consulta = vi.hoisted(() => ({ params: "" }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get, post, delete: excluir } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(consulta.params),
}));

const MODELOS = [
  { slug: "site_institucional", nome: "Site institucional", origem: "plataforma", secoes: 3, version: 1 },
  { slug: "ecommerce", nome: "E-commerce nosso", origem: "personalizado", secoes: 4, version: 2 },
];

describe("ModelosDeProposta", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    excluir.mockReset();
    consulta.params = "";
    get.mockResolvedValue({ data: MODELOS });
    post.mockResolvedValue({ data: { slug: "ecommerce" } });
  });

  it("lista mostra Da plataforma e Personalizar", async () => {
    render(<ModelosDeProposta />);
    await waitFor(() => expect(screen.getByText("Site institucional")).toBeInTheDocument());
    expect(screen.getByText(/Da plataforma/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Personalizar" })).toBeInTheDocument();
  });

  it("Personalizar chama POST com acao personalizar e base_slug", async () => {
    render(<ModelosDeProposta />);
    fireEvent.click(await screen.findByRole("button", { name: "Personalizar" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/settings/proposal-templates", {
        acao: "personalizar",
        base_slug: "site_institucional",
      }),
    );
  });

  it("Voltar ao modelo da plataforma com confirm falso não chama DELETE", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(<ModelosDeProposta />);
      fireEvent.click(await screen.findByRole("button", { name: "Voltar ao modelo da plataforma" }));
      await waitFor(() => expect(screen.getByText("E-commerce nosso")).toBeInTheDocument());
      expect(excluir).not.toHaveBeenCalled();
    } finally {
      confirmar.mockRestore();
    }
  });

  it("modelo da plataforma tem botão Não usar, que chama POST ocultar", async () => {
    render(<ModelosDeProposta />);
    const botoes = await screen.findAllByRole("button", { name: "Não usar" });
    fireEvent.click(botoes[0]!);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/settings/proposal-templates", {
        acao: "ocultar",
        slug: "site_institucional",
      }),
    );
  });

  it("modelo oculto mostra Desligado e botão Usar, que chama POST mostrar", async () => {
    get.mockResolvedValue({
      data: [{ slug: "ecommerce", nome: "E-commerce", origem: "plataforma", secoes: 3, version: 1, oculto: true }],
    });
    render(<ModelosDeProposta />);
    await waitFor(() =>
      expect(screen.getByText("Desligado — não aparece para a IA nem no seletor")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Usar" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/settings/proposal-templates", {
        acao: "mostrar",
        slug: "ecommerce",
      }),
    );
  });

  it("modelo da empresa não tem botão Não usar", async () => {
    get.mockResolvedValue({
      data: [{ slug: "empresa_locacao", nome: "Locação", origem: "empresa", secoes: 1, version: 1 }],
    });
    render(<ModelosDeProposta />);
    await waitFor(() => expect(screen.getByText("Locação")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Não usar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Usar" })).toBeNull();
  });

  it("importar com resposta que não é JSON avisa que a leitura demorou demais", async () => {
    // O proxy corta a resposta por tempo e devolve HTML/texto, não JSON: o
    // `res.json()` rejeita. Sem a guarda o `importar` estourava na tela e o
    // botão ficava preso em "ocupado" — o arquivo era aceito e nada acontecia.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new Error("Unexpected token")) }),
    );
    try {
      render(<ModelosDeProposta />);
      await screen.findByText("Site institucional");
      const campo = screen.getByLabelText("Arquivo da proposta");
      fireEvent.change(campo, {
        target: { files: [new File(["x"], "proposta.pdf", { type: "application/pdf" })] },
      });
      const aviso = await screen.findByRole("alert");
      expect(aviso).toHaveTextContent(
        "A leitura demorou demais e foi interrompida. Tente de novo; se repetir, envie um arquivo menor.",
      );
      // O botão tem que voltar a ficar clicável: preso em "ocupado", a segunda
      // tentativa da pessoa não existe.
      await waitFor(() => expect(campo).toBeEnabled());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("com ?salvo= na URL mostra a faixa do modelo salvo, e Fechar a esconde", async () => {
    consulta.params = "salvo=Portal";
    render(<ModelosDeProposta />);
    const faixa = await screen.findByRole("status");
    expect(faixa).toHaveTextContent("Modelo «Portal» salvo.");

    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(screen.queryByText("Modelo «Portal» salvo.")).toBeNull());
  });

  it("com as propostas desligadas (404 not_found) mostra estado próprio com o caminho, não fica em Carregando…", async () => {
    // A rota responde 404 `not_found` quando `settings.proposals.enabled`
    // está desligado (lib/propostas/porta.ts). Antes do conserto, a tela
    // mostrava o toast cru "Not found." e ficava em "Carregando…" para sempre.
    get.mockRejectedValue(new ApiError(404, "not_found", undefined, "req-1889", "Not found."));
    render(<ModelosDeProposta />);

    expect(await screen.findByText(/propostas estão desligadas/i)).toBeInTheDocument();
    expect(screen.queryByText("Carregando…")).toBeNull();
    expect(screen.getByRole("link", { name: /Configurações › Propostas/ })).toBeInTheDocument();
  });

  it("um erro que NÃO é not_found segue mostrando o erro via showApiError, não o estado de desligado", async () => {
    get.mockRejectedValue(new ApiError(500, "internal_error", undefined, "req-1889", "Erro inesperado."));
    render(<ModelosDeProposta />);

    await waitFor(() => expect(showApiError).toHaveBeenCalled());
    expect(screen.queryByText(/propostas estão desligadas/i)).toBeNull();
  });
});
