import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConexaoDaCobranca } from "./_conexao";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// Achado da prova pela tela do #4095: numa instalação sem https, o aviso do
// topo nomeava a Stripe com o Efi escolhido — o ternário só tinha Asaas/Stripe.
describe("Conexão da cobrança sem endereço https", () => {
  it.each([
    ["efi", "O Efi só avisa"],
    ["asaas", "O Asaas só avisa"],
    ["stripe", "A Stripe só avisa"],
  ])("com %s escolhido, o aviso nomeia o próprio provedor", (provedor, frase) => {
    render(<ConexaoDaCobranca provedor={provedor} modo={null} last4={null} urlDoWebhook={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent(frase);
  });
});
