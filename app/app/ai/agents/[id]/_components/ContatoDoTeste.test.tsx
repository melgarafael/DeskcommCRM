import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
const m = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: m }));
import { ContatoDoTeste } from "./ContatoDoTeste";
it("não busca sem intenção e oferece somente contatos não bloqueados ou anonimizados", async () => {
  const onChange = vi.fn();
  m.get.mockResolvedValue({
    data: [
      { id: "permitido", name: "Teste permitido", phone_number: "5511999990000" },
      { id: "bloqueado", name: "Teste bloqueado", is_blocked: true },
      { id: "anonimizado", name: "Teste anonimizado", is_anonymized: true },
    ],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ContatoDoTeste value={null} onChange={onChange} />
    </QueryClientProvider>,
  );
  expect(m.get).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Consultar um contato cadastrado (opcional)"), {
    target: { value: "Teste" },
  });
  const button = await screen.findByRole("button", { name: "Teste permitido" });
  expect(screen.queryByRole("button", { name: "Teste bloqueado" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Teste anonimizado" })).not.toBeInTheDocument();
  fireEvent.click(button);
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "permitido" })),
  );
});
