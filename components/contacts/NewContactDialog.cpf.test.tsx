/**
 * AS SEIS PROMESSAS DO CPF NO CAMPO (#3496).
 *
 * Este arquivo existe para MEDIR o recorte pedido na issue, caso a caso, contra
 * o código de HOJE — não para reescrever o que já foi entregue. Ele é a régua
 * da matriz de aceite:
 *
 *  1. vazio é válido (o documento é opcional);
 *  2. inválido avisa NO CAMPO ao sair dele;
 *  3. corrigir limpa o aviso sem sair do campo;
 *  4. válido com máscara passa;
 *  5. válido sem máscara tem o MESMO veredito da máscara;
 *  6. o payload enviado continua o digitado (só `.trim()`).
 *
 * A régua não é reimplementada aqui: o campo usa `perfil.documento.valida`, que
 * para o Brasil é `isValidCpf` (`lib/legal/perfil-do-pais.ts`).
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

function criarContato() {
  return screen.getByRole("button", { name: "Criar contato" });
}

afterEach(() => {
  cleanup();
  orgAtiva.atual = { currency: "BRL", country: null };
  vi.clearAllMocks();
});

describe("CPF no campo: a matriz de aceite da #3496", () => {
  it("1. vazio é válido: sair do campo sem digitar não acusa e não impede criar", async () => {
    const usuario = userEvent.setup();
    render(<NewContactDialog open onOpenChange={() => {}} />);

    const campo = screen.getByLabelText(/CPF/i);
    await usuario.click(campo);
    await usuario.tab();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(campo.getAttribute("aria-invalid")).toBeNull();
    expect(criarContato()).toBeEnabled();
  });

  it("2. dígito errado avisa NO CAMPO ao sair dele", async () => {
    const usuario = userEvent.setup();
    render(<NewContactDialog open onOpenChange={() => {}} />);

    const campo = screen.getByLabelText(/CPF/i);
    await usuario.type(campo, "123.456.789-00");
    // Nada antes de sair: o aviso é do blur, não de cada tecla.
    expect(screen.queryByRole("alert")).toBeNull();
    await usuario.tab();

    const erro = await screen.findByRole("alert");
    expect(erro.textContent).toBe("CPF inválido");
    expect(campo.getAttribute("aria-invalid")).toBe("true");
    expect(campo.getAttribute("aria-describedby")).toBe("cpf-erro");
  });

  it("2b. com o CPF inválido o envio fica impedido", async () => {
    const usuario = userEvent.setup();
    api.post.mockResolvedValue({ data: { contact: { id: "contato-teste" } } });
    render(<NewContactDialog open onOpenChange={() => {}} />);
    await usuario.type(screen.getByLabelText(/^Email$/), "contato@example.test");

    const campo = screen.getByLabelText(/CPF/i);
    await usuario.type(campo, "123.456.789-00");
    await usuario.tab();
    await screen.findByRole("alert");

    expect(criarContato()).toBeDisabled();
    await usuario.click(criarContato());
    expect(api.post).not.toHaveBeenCalled();
  });

  it("3. corrigir o número limpa o aviso sem sair do campo", async () => {
    const usuario = userEvent.setup();
    render(<NewContactDialog open onOpenChange={() => {}} />);

    const campo = screen.getByLabelText(/CPF/i);
    await usuario.type(campo, "123.456.789-00");
    await usuario.tab();
    await screen.findByRole("alert");

    await usuario.clear(campo);
    await usuario.type(campo, "529.982.247-25");
    // SEM `tab()`, SEM submit: o aviso tem de sumir enquanto se digita.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(campo.getAttribute("aria-invalid")).toBeNull();
    expect(criarContato()).toBeEnabled();
  });

  it("4. válido com máscara passa", async () => {
    const usuario = userEvent.setup();
    render(<NewContactDialog open onOpenChange={() => {}} />);

    const campo = screen.getByLabelText(/CPF/i);
    await usuario.type(campo, "529.982.247-25");
    await usuario.tab();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(campo.getAttribute("aria-invalid")).toBeNull();
  });

  it("5. válido sem máscara tem o MESMO veredito da máscara", async () => {
    const usuario = userEvent.setup();
    render(<NewContactDialog open onOpenChange={() => {}} />);

    const campo = screen.getByLabelText(/CPF/i);
    await usuario.type(campo, "52998224725");
    await usuario.tab();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(campo.getAttribute("aria-invalid")).toBeNull();
  });

  it("6. o payload continua o digitado: só o `.trim()`", async () => {
    const usuario = userEvent.setup();
    api.post.mockResolvedValue({ data: { contact: { id: "contato-teste" } } });
    render(<NewContactDialog open onOpenChange={() => {}} />);

    await usuario.type(screen.getByLabelText(/^Email$/), "contato@example.test");
    await usuario.type(screen.getByLabelText(/CPF/i), " 529.982.247-25 ");
    await usuario.tab();
    await usuario.click(criarContato());

    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/contacts",
      expect.objectContaining({ cpf: "529.982.247-25" }),
    );
  });
});
