import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FaixaDaCobranca } from "@/components/cobranca/FaixaDaCobranca";

afterEach(cleanup);

const atraso = (link: string) => ({ tipo: "atraso" as const, desde: "2026-10-01T12:00:00Z", link });

describe("FaixaDaCobranca — o link de pagamento só vira href se for https", () => {
  it("⭐ https válido: o botão aponta para a fatura", () => {
    render(<FaixaDaCobranca faixa={atraso("https://invoice.example.com/i/x")} />);
    expect(screen.getByRole("link", { name: "Pagar agora" }).getAttribute("href")).toBe("https://invoice.example.com/i/x");
  });

  it("⭐ javascript: nunca vira href; cai no painel do plano", () => {
    render(<FaixaDaCobranca faixa={atraso("javascript:alert(1)")} />);
    expect(screen.getByRole("link", { name: "Pagar agora" }).getAttribute("href")).toBe("/app/settings/billing");
  });
});

describe("FaixaDaCobranca — a data sai no fuso da empresa, não no do servidor", () => {
  // O Asaas grava o fim do período pago como fim do dia em São Paulo (02:59:59Z do dia seguinte).
  const fim = { tipo: "cancelamento" as const, ate: "2026-11-10T02:59:59Z" };
  it("⭐ 02:59:59Z de 10/11 é 09/11 em São Paulo, igual ao painel", () => {
    render(<FaixaDaCobranca faixa={fim} fuso="America/Sao_Paulo" />);
    expect(screen.getByText("Sua assinatura termina em 09/11.")).toBeTruthy();
  });
  it("sem fuso cai no de São Paulo (não no UTC do servidor)", () => {
    render(<FaixaDaCobranca faixa={fim} />);
    expect(screen.getByText("Sua assinatura termina em 09/11.")).toBeTruthy();
  });
});
