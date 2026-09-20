import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AiAllowanceCard } from "./AiAllowanceCard";
import type { AiAllowanceView } from "@/lib/billing/ai-allowance-view";
const balance: AiAllowanceView = {
  status: "ready",
  budget: 3000,
  rate: 6,
  used: 550,
  reserved: 100,
  remaining: 2350,
  periodStart: "2026-09-01T00:00:00Z",
  periodEnd: "2026-10-01T00:00:00Z",
};
it("explains used and reserved balances without adding a purchasing action", () => {
  render(<AiAllowanceCard balance={balance} idioma="pt-BR" />);
  expect(screen.getByText("Já utilizado")).toBeInTheDocument();
  expect(screen.getByText("Reservado")).toBeInTheDocument();
  expect(screen.getByText(/23,50/)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("hides amounts while the cycle is unconfirmed", () => {
  render(
    <AiAllowanceCard
      balance={{ ...balance, status: "unconfirmed", periodStart: null, periodEnd: null }}
      idioma="pt-BR"
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("confirmação do ciclo");
  expect(screen.queryByText(/R\$/)).not.toBeInTheDocument();
});
it.each([
  ["review", "pausado"],
  ["inactive", "não está liberado"],
] as const)("explains %s restrictions", (status, message) => {
  render(<AiAllowanceCard balance={{ ...balance, status }} idioma="pt-BR" />);
  expect(screen.getByRole("status")).toHaveTextContent(message);
});
it("localizes the balance for Spanish", () => {
  render(<AiAllowanceCard balance={balance} idioma="es" />);
  expect(screen.queryByText("Já utilizado")).not.toBeInTheDocument();
  expect(screen.getByRole("region")).not.toHaveAccessibleName("Sua franquia de IA");
});
