import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const copiar = vi.fn(async () => true);
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: () => copiar() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ParaIntegrar } from "@/components/connections/ParaIntegrar";

describe("ParaIntegrar — dados não-secretos da conexão", () => {
  it("mostra os campos preenchidos e esconde os vazios", () => {
    render(
      <ParaIntegrar
        campos={[
          { rotulo: "Endpoint da API", valor: "https://graph.facebook.com/v22.0" },
          { rotulo: "Número", valor: null },
        ]}
        ajuda={<p>onde obter o token</p>}
      />,
    );
    expect(screen.getByText("https://graph.facebook.com/v22.0")).toBeInTheDocument();
    // Campo sem valor não vira linha; o rótulo Número não aparece.
    expect(screen.queryByText("Número")).not.toBeInTheDocument();
  });

  it("copia os dados preenchidos ao clicar", async () => {
    render(
      <ParaIntegrar
        campos={[{ rotulo: "Endpoint da API", valor: "https://exemplo.test/api" }]}
        ajuda={<p>ajuda</p>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copiar dados" }));
    await waitFor(() => expect(copiar).toHaveBeenCalledTimes(1));
  });

  it("sem dados, não oferece copiar e a ajuda continua acessível", () => {
    render(<ParaIntegrar campos={[]} ajuda={<p>ajuda</p>} />);
    expect(screen.queryByRole("button", { name: "Copiar dados" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Onde obter o token" })).toBeInTheDocument();
  });

  it("mostra o aviso de webhook quando passado", () => {
    render(
      <ParaIntegrar
        campos={[]}
        ajuda={<p>ajuda</p>}
        aviso={<>Um número tem um único webhook.</>}
      />,
    );
    expect(screen.getByText("Um número tem um único webhook.")).toBeInTheDocument();
  });
});
