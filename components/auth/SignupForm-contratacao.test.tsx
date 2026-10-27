import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ signup: vi.fn(), replace: vi.fn() }));
vi.mock("@/app/actions/auth/signUp", () => ({ signUp: h.signup }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace }) }));
import { SignupForm } from "./SignupForm";
const P = "11111111-1111-4111-8111-111111111111", T = "22222222-2222-4222-8222-222222222222";
const planos = [{ id: P, nome: "Pago", preco_cents: 120000, intervalo: "ano" as const, trial_dias: 0 }, { id: T, nome: "Teste", preco_cents: 10000, intervalo: "mes" as const, trial_dias: 7 }];
function preencher() {
  fireEvent.change(screen.getByLabelText("Nome da empresa"), { target: { value: "Empresa fictícia" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "pessoa@example.test" } });
  fireEvent.change(screen.getByLabelText("Senha", { exact: true }), { target: { value: "SenhaTeste2026!" } });
  fireEvent.change(screen.getByLabelText("Confirmar senha", { exact: true }), { target: { value: "SenhaTeste2026!" } });
}
beforeEach(() => { vi.clearAllMocks(); h.signup.mockResolvedValue({ ok: true, sessao_ativa: false }); });
describe("compromisso explícito no formulário nativo", () => {
  it("plano pago muda o CTA e envia intenção, preservando a confirmação de e-mail", async () => {
    render(<SignupForm planos={planos} planoInicial={P} />); preencher();
    fireEvent.click(screen.getByRole("button", { name: "Criar conta e continuar para pagamento" }));
    await waitFor(() => expect(h.signup).toHaveBeenCalledTimes(1));
    expect(h.signup.mock.calls[0]?.[0]).toMatchObject({ cobranca_plan_id: P, continuar_pagamento: true });
    expect(await screen.findByText("Confirme seu e-mail")).toBeVisible();
    expect(screen.getByText(/Seu plano está preservado/)).toBeVisible();
  });
  it("trocar para trial antes do envio remove o compromisso automático de pagamento", async () => {
    render(<SignupForm planos={planos} planoInicial={P} />); preencher();
    fireEvent.change(screen.getByLabelText("Plano"), { target: { value: T } });
    fireEvent.click(screen.getByRole("button", { name: "Criar conta", exact: true }));
    await waitFor(() => expect(h.signup).toHaveBeenCalledTimes(1));
    expect(h.signup.mock.calls[0]?.[0]).toMatchObject({ cobranca_plan_id: T, continuar_pagamento: false });
  });
});
