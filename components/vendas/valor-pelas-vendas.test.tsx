/**
 * O VALOR DO NEGÓCIO SEGUE AS VENDAS — uma porta só para "quanto vendeu".
 *
 *  1. sem venda registrada, o Valor é o campo de sempre (digita e salva), e o
 *     "+" de registrar venda mora AO LADO dele;
 *  2. com venda registrada, o Valor mostra a SOMA das vendas na moeda do
 *     negócio, em leitura, com o "+" para registrar mais;
 *  3. salvar o formulário com venda registrada NÃO manda `value_cents` — a
 *     soma é do banco (migration 9450), e um Salvar de ficha aberta antes da
 *     venda a apagaria;
 *  4. apagar a última venda devolve o valor digitado (decisão 2B do doc 396):
 *     o campo volta editável com o valor RELIDO, não com a soma em memória;
 *  5. abaixo de `agent` (o piso do `POST /api/v1/vendas`) o "+" não aparece —
 *     ele só abriria um diálogo que termina em 403.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";
import type { Lead } from "@/lib/types/leads";

const estado = vi.hoisted(() => ({
  vendas: [] as Array<{ id: string; valor_cents: number; currency: string }>,
  editarLead: vi.fn(),
  papel: "agent" as "viewer" | "agent",
}));

vi.mock("@/hooks/vendas/useVendasRegistradas", () => ({
  useVendasDoNegocio: () => ({ data: estado.vendas }),
  useRegistrarVenda: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useApagarVenda: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: "BR", orgId: "org-1", role: estado.papel }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync: estado.editarLead, isPending: false }),
}));
vi.mock("@/components/inbox/ContactTagsEditor", () => ({ ContactTagsEditor: () => null }));

const negocio: Lead = {
  id: "22222222-2222-4222-8222-222222222222",
  organization_id: "org-1",
  pipeline_id: "33333333-3333-4333-8333-333333333333",
  stage_id: "11111111-1111-4111-8111-111111111111",
  contact_id: "44444444-4444-4444-8444-444444444444",
  title: "Dãm Dãm Baby - Financeiro",
  description: null,
  status: "open",
  lost_reason: null,
  position_in_stage: 0,
  value_cents: 18_000,
  currency: "BRL",
  owner_user_id: null,
  owner_kind: null,
  owner_agent_id: null,
  assigned_at: null,
  last_activity_at: null,
  stage_changed_at: null,
  expected_close_date: null,
  closed_at: null,
  source: "manual",
  source_metadata: {},
  external_id: null,
  custom_fields: {},
  tags: [],
  created_at: "2026-11-20T12:00:00.000Z",
  updated_at: "2026-11-20T12:00:00.000Z",
  created_by_user_id: null,
};

beforeEach(() => {
  estado.papel = "agent";
  estado.vendas = [];
  estado.editarLead.mockReset().mockResolvedValue({});
});

describe("o Valor do negócio e as vendas registradas", () => {
  it("sem venda: o Valor é editável, e o '+' de venda fica ao lado dele", async () => {
    render(<LeadFieldsForm lead={negocio} pipelineId={negocio.pipeline_id} />);

    const campo = screen.getByLabelText(/^Valor \(/) as HTMLInputElement;
    expect(campo.readOnly).toBe(false);
    expect(screen.getByTestId("valor-registrar-venda")).toBeTruthy();

    fireEvent.change(campo, { target: { value: "250,00" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(estado.editarLead).toHaveBeenCalled());
    expect(estado.editarLead.mock.calls[0]![0].patch.value_cents).toBe(25_000);
  });

  it("com vendas: o Valor é a soma na moeda do negócio, em leitura", () => {
    estado.vendas = [
      { id: "v1", valor_cents: 18_000, currency: "BRL" },
      { id: "v2", valor_cents: 12_000, currency: "BRL" },
      { id: "v3", valor_cents: 5_000, currency: "USD" }, // outra moeda não entra
    ];
    render(<LeadFieldsForm lead={negocio} pipelineId={negocio.pipeline_id} />);

    const campo = screen.getByTestId("valor-pelas-vendas") as HTMLInputElement;
    expect(campo.readOnly).toBe(true);
    expect(campo.value).toMatch(/R\$.300,00/);
    expect(screen.getByTestId("valor-pelas-vendas-legenda").textContent).toContain("3");
    expect(screen.getByTestId("valor-registrar-venda")).toBeTruthy();
  });

  it("com vendas: salvar o formulário não reescreve o valor", async () => {
    estado.vendas = [{ id: "v1", valor_cents: 18_000, currency: "BRL" }];
    render(<LeadFieldsForm lead={negocio} pipelineId={negocio.pipeline_id} />);

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(estado.editarLead).toHaveBeenCalled());
    expect(estado.editarLead.mock.calls[0]![0].patch).not.toHaveProperty("value_cents");
  });

  it("apagar a última venda: o campo volta editável com o valor devolvido pelo banco", () => {
    estado.vendas = [{ id: "v1", valor_cents: 18_000, currency: "BRL" }];
    const { rerender } = render(<LeadFieldsForm lead={negocio} pipelineId={negocio.pipeline_id} />);

    // A venda saiu e o banco devolveu o valor digitado antes dela (R$ 500).
    estado.vendas = [];
    rerender(<LeadFieldsForm lead={{ ...negocio, value_cents: 50_000 }} pipelineId={negocio.pipeline_id} />);

    const campo = screen.getByLabelText(/^Valor \(/) as HTMLInputElement;
    expect(campo.readOnly).toBe(false);
    expect(campo.value).toMatch(/^500/);
  });

  it("viewer: vê o Valor, mas não recebe o '+' de registrar venda", () => {
    estado.papel = "viewer";
    estado.vendas = [{ id: "v1", valor_cents: 18_000, currency: "BRL" }];
    render(<LeadFieldsForm lead={negocio} pipelineId={negocio.pipeline_id} />);

    expect(screen.getByTestId("valor-pelas-vendas")).toBeTruthy();
    expect(screen.queryByTestId("valor-registrar-venda")).toBeNull();
  });
});
