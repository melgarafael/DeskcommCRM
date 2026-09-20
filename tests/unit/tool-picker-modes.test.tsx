import * as React from "react";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
const tools = [
  { id: "read", name: "read", rotulo: "Consultar conversa", explicacao: "Lê o histórico", risco: "seguro", pacotes: ["atender"], o_que_toca: "Conversa" },
  { id: "send", name: "send", rotulo: "Enviar mensagem", explicacao: "Envia ao cliente", risco: "critico", pacotes: ["atender"], o_que_toca: "Conversa" },
];
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: tools }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
import { ToolPicker } from "@/app/app/ai/agents/[id]/_components/ToolPicker";
afterEach(cleanup);
it("troca de modo sem mudar escolhas, inclusive personalizadas e indisponíveis", () => {
  const change = vi.fn();
  render(<ToolPicker value={["send", "indisponivel"]} onChange={change} />);
  expect(screen.getByRole("button", { name: "Simples" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByTestId("lista-avancada")).not.toBeInTheDocument();
  expect(screen.getByTestId("criticas-atender")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Avançado" }));
  expect(screen.queryByTestId("pacote-atender")).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Enviar mensagem" })).toBeChecked();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Enviar" } });
  expect(screen.queryByRole("checkbox", { name: "Consultar conversa" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Simples" }));
  expect(screen.getByTestId("capacidades-orfas")).toHaveTextContent("indisponivel");
  expect(change).not.toHaveBeenCalled();
});
it("escolher uma tarefa não autoriza envios ao cliente", () => {
  const change = vi.fn();
  render(<ToolPicker value={[]} onChange={change} />);
  fireEvent.click(screen.getByTestId("switch-pacote-atender"));
  expect(change).toHaveBeenCalledWith(["read"]);
});
