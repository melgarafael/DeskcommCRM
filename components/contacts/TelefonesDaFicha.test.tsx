/**
 * A ficha de telefones não mente (#4242).
 *
 * O que este teste prende:
 *
 * 1. Erro da API com mensagem: a TELA mostra a frase do SERVIDOR. Ela é a única
 *    fonte que conhece o país da organização — para uma org em Portugal, quem
 *    ensina o E.164 é o servidor (`+351...`), e a frase local fixa dizia "DDD",
 *    que Portugal não tem. Trocar a frase do servidor por texto local voltaria a
 *    mentir, e é o que a sabotagem do PR derruba.
 * 2. Erro da API SEM mensagem: cai no texto local — que agora não fala em DDD e
 *    não contradiz o E.164.
 * 3. "Tornar principal" num extra COM rótulo troca direto, sem aviso de
 *    descarte: desde a 9354 o principal guarda rótulo (`contacts.phone_label`)
 *    e ele acompanha o número. Um aviso de perda que não acontece faria a
 *    pessoa cancelar sem motivo — medido na prova de tela do #4249.
 * 4. O caminho feliz de adicionar telefone continua igual.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { Contact } from "@/lib/types/contacts";

const deps = vi.hoisted(() => ({
  adicionar: vi.fn(),
  editarExtra: vi.fn(),
  editarPrincipal: vi.fn(),
  remover: vi.fn(),
  tornar: vi.fn(),
}));

vi.mock("@/hooks/contacts/useAdicionarTelefone", () => ({
  useAdicionarTelefone: () => deps.adicionar(),
}));
vi.mock("@/hooks/contacts/useEditarTelefone", () => ({
  useEditarTelefone: () => deps.editarExtra(),
}));
vi.mock("@/hooks/contacts/useEditarTelefonePrincipal", () => ({
  useEditarTelefonePrincipal: () => deps.editarPrincipal(),
}));
vi.mock("@/hooks/contacts/useRemoverTelefone", () => ({
  useRemoverTelefone: () => deps.remover(),
}));
vi.mock("@/hooks/contacts/useTornarTelefonePrincipal", () => ({
  useTornarTelefonePrincipal: () => deps.tornar(),
}));

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// components/contacts/BarraDeContatosEmLote.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { TelefonesDaFicha } from "./TelefonesDaFicha";

function ficha(comRotulo = false): Contact {
  return {
    id: "c1",
    organization_id: "o1",
    name: "Ana",
    display_name: "Ana",
    email: null,
    email_normalized: null,
    phone_number: "+351912345678",
    phone_type: "celular",
    phone_whatsapp: "nao_sei",
    additional_phones: [
      {
        id: "p-casa",
        phone_number: "+351913333444",
        type: "fixo",
        whatsapp: "nao_sei",
        label: comRotulo ? "casa" : null,
        origin: "manual",
        created_at: "2026-11-01T00:00:00Z",
      },
    ],
  } as unknown as Contact;
}

function mutacao(mutateAsync = vi.fn()) {
  return { mutateAsync, isPending: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.adicionar.mockReturnValue(mutacao(vi.fn().mockResolvedValue({ id: "p-novo" })));
  deps.editarExtra.mockReturnValue(mutacao());
  deps.editarPrincipal.mockReturnValue(mutacao());
  deps.remover.mockReturnValue(mutacao());
  deps.tornar.mockReturnValue(mutacao(vi.fn().mockResolvedValue({})));
});

async function adicionarNumero(numero: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Adicionar telefone" }));
  await user.type(screen.getByLabelText("Número"), numero);
  await user.click(screen.getByRole("button", { name: "Salvar" }));
}

describe("TelefonesDaFicha — a mensagem do servidor chega à tela (#4242)", () => {
  it("422 com a frase do E.164 aparece como veio, sem 'DDD'", async () => {
    deps.adicionar.mockReturnValue(
      mutacao(
        vi
          .fn()
          .mockRejectedValue(
            new ApiError(
              422,
              "invalid_phone",
              undefined,
              "req-1",
              "Telefone deve estar em formato E.164 (+351912345678)",
            ),
          ),
      ),
    );

    render(<TelefonesDaFicha contato={ficha()} podeEditar />);
    await adicionarNumero("912345678");

    const alerta = screen.getByRole("alert");
    expect(alerta.textContent).toContain("Telefone deve estar em formato E.164 (+351912345678)");
    expect(alerta.textContent).not.toContain("DDD");
  });

  it("resposta sem mensagem cai no texto local, que não fala em DDD", async () => {
    deps.adicionar.mockReturnValue(
      mutacao(
        vi.fn().mockRejectedValue(new ApiError(422, "invalid_phone", undefined, "req-2")),
      ),
    );

    render(<TelefonesDaFicha contato={ficha()} podeEditar />);
    await adicionarNumero("912345678");

    const alerta = screen.getByRole("alert");
    expect(alerta.textContent).toContain("formato E.164");
    expect(alerta.textContent).not.toContain("DDD");
  });
});

describe("TelefonesDaFicha — 'Tornar principal' com rótulo (#4242)", () => {
  it("troca direto, sem aviso de descarte: o rótulo acompanha o número", async () => {
    const tornar = vi.fn().mockResolvedValue({});
    deps.tornar.mockReturnValue(mutacao(tornar));

    render(<TelefonesDaFicha contato={ficha(true)} podeEditar />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tornar principal" }));

    expect(tornar).toHaveBeenCalledWith("p-casa");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/descartad/)).toBeNull();
  });
});

describe("TelefonesDaFicha — caminho feliz intacto (#4242)", () => {
  it("adiciona o número com tipo, WhatsApp e rótulo e fecha o formulário", async () => {
    const adicionar = vi.fn().mockResolvedValue({ id: "p-novo" });
    deps.adicionar.mockReturnValue(mutacao(adicionar));

    render(<TelefonesDaFicha contato={ficha()} podeEditar />);
    await adicionarNumero("+5511999998888");

    expect(adicionar).toHaveBeenCalledWith({
      phone_number: "+5511999998888",
      type: "celular",
      whatsapp: "nao_sei",
      label: undefined,
    });
    expect(screen.queryByLabelText("Número")).toBeNull();
  });
});
