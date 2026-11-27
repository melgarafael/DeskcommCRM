/**
 * O NEGÓCIO ABERTO NÃO TEM MAIS O "VALOR" DIGITADO.
 *
 * Uma porta só para "quanto vendeu": o bloco Vendas do negócio (botão
 * "Registrar venda" + a lista). O Valor do negócio, que o card mostra, é a soma
 * das vendas, gravada pelo gatilho do banco.
 *
 *  1. o formulário "Dados do negócio" não desenha campo de Valor;
 *  2. salvar o formulário NUNCA manda `value_cents` — um Salvar com a ficha
 *     aberta antes da venda apagaria a soma que o banco acabou de gravar.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditLeadDialog } from "@/components/kanban/EditLeadDialog";
import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";
import type { Lead } from "@/lib/types/leads";

const estado = vi.hoisted(() => ({ editarLead: vi.fn() }));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: "BR", orgId: "org-1", role: "agent" }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync: estado.editarLead, isPending: false }),
}));
vi.mock("@/components/inbox/ContactTagsEditor", () => ({ ContactTagsEditor: () => null }));
// O "Contato do negócio" do EditLeadDialog (#4978) lê o contato vinculado e
// busca os existentes; aqui os dois hooks são dublês, sem QueryClient.
const CONTATO_NOVO = "55555555-5555-4555-8555-555555555555";
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: (id: string) => ({ data: id ? { data: { id, name: "Ana Vinculada" } } : undefined }),
}));
vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: () => ({
    data: { pages: [{ data: [{ id: CONTATO_NOVO, name: "Bia Nova", phone_number: "+5511999990000" }] }] },
    isLoading: false,
  }),
}));

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
  estado.editarLead.mockReset().mockResolvedValue({});
});

describe("o negócio aberto e o Valor", () => {
  it("o formulário não tem campo de Valor digitado", () => {
    render(<LeadFieldsForm lead={negocio} pipelineId={negocio.pipeline_id} />);

    expect(screen.queryByLabelText(/^Valor \(/)).toBeNull();
    expect(document.getElementById("valueReais")).toBeNull();
  });

  it("salvar o formulário nunca manda value_cents", async () => {
    render(<LeadFieldsForm lead={negocio} pipelineId={negocio.pipeline_id} />);

    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Dãm Dãm Baby" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(estado.editarLead).toHaveBeenCalled());
    const patch = estado.editarLead.mock.calls[0]![0].patch as Record<string, unknown>;
    expect(patch.title).toBe("Dãm Dãm Baby");
    expect(patch).not.toHaveProperty("value_cents");
  });

  it("EditLeadDialog com vendas: Valor fica em leitura com a soma e Salvar não manda value_cents", async () => {
    estado.vendas = [{ id: "v1", valor_cents: 10_000, currency: "BRL" }];
    render(
      <EditLeadDialog
        open
        onOpenChange={() => {}}
        lead={{ ...negocio, value_cents: 10_000, valor_pelas_vendas: true }}
        pipelineId={negocio.pipeline_id}
      />,
    );

    const campo = screen.getByTestId("valor-pelas-vendas") as HTMLInputElement;
    expect(campo.readOnly).toBe(true);
    expect(campo.value).toMatch(/R\$.100,00/);

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(estado.editarLead).toHaveBeenCalled());
    expect(estado.editarLead.mock.calls[0]![0].patch).not.toHaveProperty("value_cents");
  });

  it("EditLeadDialog sem vendas: Valor é editável e Salvar manda value_cents", async () => {
    estado.vendas = [];
    render(
      <EditLeadDialog
        open
        onOpenChange={() => {}}
        lead={{ ...negocio, value_cents: 10_000, valor_pelas_vendas: false }}
        pipelineId={negocio.pipeline_id}
      />,
    );

    const campo = screen.getByLabelText(/^Valor \(/) as HTMLInputElement;
    expect(campo.readOnly).toBe(false);

    fireEvent.change(campo, { target: { value: "50,00" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(estado.editarLead).toHaveBeenCalled());
    expect(estado.editarLead.mock.calls[0]![0].patch.value_cents).toBe(5_000);
  });

  it("EditLeadDialog com vendas: trocar o contato não reabre o Valor nem manda value_cents", async () => {
    estado.vendas = [{ id: "v1", valor_cents: 10_000, currency: "BRL" }];
    render(
      <EditLeadDialog
        open
        onOpenChange={() => {}}
        lead={{ ...negocio, value_cents: 10_000, valor_pelas_vendas: true }}
        pipelineId={negocio.pipeline_id}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Trocar contato" }));
    fireEvent.click(screen.getByRole("button", { name: "Usar" }));
    expect((screen.getByTestId("valor-pelas-vendas") as HTMLInputElement).readOnly).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(estado.editarLead).toHaveBeenCalled());
    const patch = estado.editarLead.mock.calls[0]![0].patch;
    expect(patch.contact_id).toBe(CONTATO_NOVO);
    expect(patch).not.toHaveProperty("value_cents");
  });
});
