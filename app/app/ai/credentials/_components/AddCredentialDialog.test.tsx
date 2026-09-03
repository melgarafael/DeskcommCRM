/**
 * O diálogo pedia "Provider / Label / API key" e nada mais. Quem nunca abriu
 * conta num provedor não sabia qual escolher nem onde a chave mora.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddCredentialDialog } from "./AddCredentialDialog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));

function montar() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AddCredentialDialog open onOpenChange={() => {}} />
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
    expect(screen.getByRole("link", { name: /Pegar chave em/ })).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );
  });

  it("placeholder da chave é o prefixo do provedor, não 'sk-...' genérico", () => {
    montar();
    expect(screen.getByLabelText(/API key/)).toHaveAttribute("placeholder", "sk-ant-…");
  });
});
