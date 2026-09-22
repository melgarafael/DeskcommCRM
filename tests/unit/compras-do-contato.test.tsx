/**
 * COMPRAS DO CONTATO — o envelope `{ data }` não é a lista.
 *
 * O defeito que esta cerca fecha: a aba lia `apiClient.get<Pedido[]>` e
 * guardava o envelope no estado — o `.filter` explodia e a ficha 360°
 * morria no ErrorBoundary. Medido em produção via radar → ficha.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComprasDoContato } from "@/app/app/contacts/[id]/_compras";
import { apiClient } from "@/lib/api/client";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));

afterEach(cleanup);

const PEDIDO = {
  id: "11111111-1111-1111-1111-111111111111",
  numero: 18459,
  cliente_nome: "SCHUHMANN",
  status: "entregue",
  origem: "vendedor",
  moeda: "BRL",
  total_cents: 13000,
  created_at: "2025-10-28T12:00:00Z",
};

describe("ComprasDoContato", () => {
  it("desembrulha o envelope e lista os pedidos", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [PEDIDO] });
    render(<ComprasDoContato contactId="contato-1" />);
    await waitFor(() => expect(screen.getByText("PED-18459")).toBeTruthy());
    // Total + linha: aparece duas vezes (o que prova que somou e listou).
    expect(screen.getAllByText("R$ 130,00")).toHaveLength(2);
  });

  it("resposta fora do formato vira lista vazia, não crash", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: null });
    render(<ComprasDoContato contactId="contato-1" />);
    await waitFor(() => expect(screen.getByText("Nenhum pedido deste cliente ainda.")).toBeTruthy());
  });
});
