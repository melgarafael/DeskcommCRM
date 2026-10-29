/**
 * O DOCUMENTO INVÁLIDO AVISA NO CAMPO, NÃO NO RODAPÉ (#3496).
 *
 * O servidor nunca aceitou CPF com dígito verificador errado —
 * `contactCreateSchemaDoPais` recusa, e isso está medido em
 * `lib/schemas/contacts.test.ts`. O defeito era de TELA: o diálogo registrava o
 * campo sem `validate`, então a digitação errada passava sem sinal, e a única
 * frase aparecia no rodapé do diálogo depois do clique — longe do campo que
 * causou o problema e indistinguível de "não validou nada".
 *
 * Estes casos falham no código anterior: sem `validate` no `register`, nenhuma
 * mensagem existe antes do submit.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderRTL, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const orgAtiva = vi.hoisted(() => ({ atual: { currency: "BRL", country: null as string | null } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => orgAtiva.atual,
  useAuth: () => ({ activeOrg: null }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { NewContactDialog } from "@/components/contacts/NewContactDialog";

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderRTL(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  orgAtiva.atual = { currency: "BRL", country: null };
  vi.clearAllMocks();
});

describe("documento do contato: a tela valida no campo", () => {
  it("CPF com dígito errado acusa embaixo do campo ao sair, sem clicar em criar", async () => {
    const usuario = userEvent.setup();
    render(<NewContactDialog open onOpenChange={() => {}} />);

    const campo = screen.getByLabelText(/CPF/i);
    await usuario.type(campo, "123.456.789-00");
    await usuario.tab();

    const erro = await screen.findByRole("alert");
    expect(erro.textContent).toBe("CPF inválido");
    // O fio é o CAMPO: o erro nasce apontado por aria-describedby/aria-invalid.
    expect(campo.getAttribute("aria-invalid")).toBe("true");
    expect(campo.getAttribute("aria-describedby")).toBe("cpf-erro");
    // E nada foi enviado: a régua barrou antes da API.
    expect(api.post).not.toHaveBeenCalled();
  });

  it("CPF válido não acusa nada", async () => {
    const usuario = userEvent.setup();
    render(<NewContactDialog open onOpenChange={() => {}} />);

    await usuario.type(screen.getByLabelText(/CPF/i), "529.982.247-25");
    await usuario.tab();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText(/CPF/i).getAttribute("aria-invalid")).toBeNull();
  });

  it("submit inválido não envia; corrigir apaga o erro e permite criar", async () => {
    const usuario = userEvent.setup();
    api.post.mockResolvedValue({ data: { contact: { id: "contato-teste" } } });
    render(<NewContactDialog open onOpenChange={() => {}} />);
    await usuario.type(screen.getByLabelText(/^Email$/), "contato@example.test");
    const campo = screen.getByLabelText(/CPF/i);
    await usuario.type(campo, "123.456.789-00");
    await usuario.click(screen.getByRole("button", { name: "Criar contato" }));
    await screen.findByRole("alert");
    expect(api.post).not.toHaveBeenCalled();

    await usuario.clear(campo);
    await usuario.type(campo, "529.982.247-25");
    await usuario.tab();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await usuario.click(screen.getByRole("button", { name: "Criar contato" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/contacts",
      expect.objectContaining({ cpf: "529.982.247-25" }),
    );
  });

  it("vazio continua opcional: sair do campo sem digitar não acusa", async () => {
    const usuario = userEvent.setup();
    render(<NewContactDialog open onOpenChange={() => {}} />);

    await usuario.click(screen.getByLabelText(/CPF/i));
    await usuario.tab();

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
