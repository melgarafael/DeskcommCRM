/**
 * O diálogo pedia "Provider / Label / API key" e nada mais. Quem nunca abriu
 * conta num provedor não sabia qual escolher nem onde a chave mora.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddCredentialDialog } from "./AddCredentialDialog";
import type { ProvedorComChave } from "@/lib/ai/pontos/provedores";

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }));

function montar(providerInicial?: ProvedorComChave) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AddCredentialDialog open onOpenChange={() => {}} providerInicial={providerInicial} />
    </QueryClientProvider>,
  );
}

describe("AddCredentialDialog — ajuda ao escolher", () => {
  it("mostra quando usar o provedor selecionado (Anthropic por padrão)", () => {
    montar();
    expect(screen.getByText(/padrão recomendado para conversar com o cliente/)).toBeInTheDocument();
  });

  it("linka para onde pegar a chave do provedor selecionado", () => {
    montar();
    expect(screen.getByRole("link", { name: "Onde pegar a chave" })).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );
  });

  it("o nome é opcional: só a chave salva, com o nome do provedor", async () => {
    // Medido em campo: o leigo colava só a chave e era barrado num "Nome"
    // obrigatório que não entendia.
    api.post.mockResolvedValue({ data: { id: "c1" } });
    montar("typesafe");
    expect(screen.getByLabelText("Nome")).not.toBeRequired();
    fireEvent.change(screen.getByLabelText("Chave"), { target: { value: "apikey_0123456789abcdef" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar e validar" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith("/api/v1/ai/credentials", {
      provider: "typesafe",
      label: "Jev (TypeSafe AI)",
      api_key: "apikey_0123456789abcdef",
    });
  });

  it("placeholder da chave é o prefixo do provedor, não 'sk-...' genérico", () => {
    montar();
    expect(screen.getByLabelText("Chave")).toHaveAttribute("placeholder", "sk-ant-…");
  });

  it("provedor personalizado: pede a base URL e SÓ grava depois do teste passar", async () => {
    // Medido: o endereço é escolha do operador, então há algo a provar ANTES
    // de gravar. O teste falha aqui — e a criação nem chega a ser chamada.
    api.post.mockClear();
    api.post.mockImplementation((url: string) =>
      url.endsWith("/credentials/test")
        ? Promise.resolve({ data: { ok: false, models: [], error: "provider_status_404" } })
        : Promise.resolve({ data: { id: "c1" } }),
    );
    montar("custom");

    expect(screen.getByLabelText("Endereço (base URL)")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Chave"), {
      target: { value: "sk-gateway-0123456789" },
    });
    fireEvent.change(screen.getByLabelText("Endereço (base URL)"), {
      target: { value: "https://gw.exemplo/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar e validar" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/v1/ai/credentials/test", {
        base_url: "https://gw.exemplo/v1",
        api_key: "sk-gateway-0123456789",
      }),
    );

    // Nada gravado: com o teste reprovado, a criação não acontece.
    expect(api.post).not.toHaveBeenCalledWith("/api/v1/ai/credentials", expect.anything());

    // E a tela diz o que deu errado, no campo que a pessoa acabou de preencher.
    expect(await screen.findByText(/não respondeu em \/models/)).toBeInTheDocument();
  });

  it("provedor personalizado: teste aprovado, aí sim a credencial é criada", async () => {
    api.post.mockClear();
    api.post.mockImplementation((url: string) =>
      url.endsWith("/credentials/test")
        ? Promise.resolve({ data: { ok: true, models: ["gpt-x"], error: null } })
        : Promise.resolve({ data: { id: "c2" } }),
    );
    montar("custom");

    fireEvent.change(screen.getByLabelText("Chave"), {
      target: { value: "sk-gateway-0123456789" },
    });
    fireEvent.change(screen.getByLabelText("Endereço (base URL)"), {
      target: { value: "https://gw.exemplo/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar e validar" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/v1/ai/credentials", {
        provider: "custom",
        label: "Provedor personalizado (compatível com OpenAI)",
        api_key: "sk-gateway-0123456789",
        base_url: "https://gw.exemplo/v1",
      }),
    );
  });
});
