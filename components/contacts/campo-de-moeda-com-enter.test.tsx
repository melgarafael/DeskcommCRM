import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import type { Stage } from "@/lib/kanban/types";
import type { Contact } from "@/lib/types/contacts";
import type { Lead } from "@/lib/types/leads";

const estado = vi.hoisted(() => ({
  moeda: "BRL",
  criarLead: vi.fn(),
  editarLead: vi.fn(),
  editarContato: vi.fn(),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: estado.moeda, country: "BR", orgId: "org-1" }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/kanban/useCreateLead", () => ({
  useCreateLead: () => ({ mutateAsync: estado.criarLead, isPending: false }),
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync: estado.editarLead, isPending: false }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync: estado.editarContato, isPending: false }),
}));
vi.mock("@/hooks/tags/useDefinirCorDaEtiqueta", () => ({
  useDefinirCorDaEtiqueta: () => ({ definirCor: vi.fn() }),
}));
// Etiquetas gravam por outro caminho. O editor de campos e os três formulários
// ficam reais: é o valor entregue por eles ao salvar que a issue #3428 descreve.
vi.mock("@/components/inbox/ContactTagsEditor", () => ({ ContactTagsEditor: () => null }));

const FUNIL = "33333333-3333-4333-8333-333333333333";
const ETAPA = "11111111-1111-4111-8111-111111111111";
const CONTATO_ID = "44444444-4444-4444-8444-444444444444";
const CAMPO: CustomFieldDef = { key: "entrada", label: "Valor de entrada", type: "currency" };
const etapa: Stage = {
  id: ETAPA,
  organization_id: "org-1",
  pipeline_id: FUNIL,
  name: "Prospecção",
  slug: "prospeccao",
  position: 0,
  color: null,
  is_won: false,
  is_lost: false,
  is_archived: false,
  expected_duration_hours: null,
};
const contato: Contact = {
  id: CONTATO_ID,
  organization_id: "org-1",
  name: "Ana",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: null,
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  blocked_reason: null,
  is_personal: false,
  ai_opt_out: false,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: [],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-10-25T12:00:00.000Z",
  updated_at: "2026-10-25T12:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
};
const negocio: Lead = {
  id: "22222222-2222-4222-8222-222222222222",
  organization_id: "org-1",
  pipeline_id: FUNIL,
  stage_id: ETAPA,
  contact_id: CONTATO_ID,
  title: "Consultoria",
  description: null,
  status: "open",
  lost_reason: null,
  position_in_stage: 0,
  value_cents: null,
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
  custom_fields: { observacao: "Preservar este campo" },
  tags: [],
  created_at: "2026-10-25T12:00:00.000Z",
  updated_at: "2026-10-25T12:00:00.000Z",
  created_by_user_id: null,
};

const telas = ["Novo Lead", "Ficha do negócio", "Editar contato"] as const;
type Tela = (typeof telas)[number];

function abrir(tela: Tela, campos: Record<string, unknown> = negocio.custom_fields) {
  if (tela === "Novo Lead") {
    render(
      <NewLeadDialog
        open
        onOpenChange={vi.fn()}
        pipelineId={FUNIL}
        stages={[etapa]}
        contactId={CONTATO_ID}
        settings={{ fields: [{ ...CAMPO, obrigatorio_em: { etapas: [ETAPA] } }] }}
      />,
    );
    return estado.criarLead;
  }
  if (tela === "Ficha do negócio") {
    render(
      <LeadFieldsForm
        lead={{ ...negocio, custom_fields: campos }}
        pipelineId={FUNIL}
        fieldDefs={[CAMPO]}
      />,
    );
    return estado.editarLead;
  }
  render(
    <EditContactDialog
      open
      onOpenChange={vi.fn()}
      contact={{ ...contato, custom_fields: campos }}
      customFieldDefs={[CAMPO]}
    />,
  );
  return estado.editarContato;
}

beforeEach(() => {
  estado.moeda = "BRL";
  estado.criarLead.mockReset().mockResolvedValue({ data: { id: "lead-1" } });
  estado.editarLead.mockReset().mockResolvedValue({});
  estado.editarContato.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe.each(telas)("%s: salvar o campo de moeda (#3428)", (tela) => {
  describe.each(["clique", "Enter"])("envio por %s", (envio) => {
    it.each([
      ["BRL", "1.500,25", 1500.25],
      ["USD", "1,300", 1300],
    ] as const)("%s: grava %s com o valor correto", async (moeda, texto, valor) => {
      estado.moeda = moeda;
      // O clique é o controle: já funcionava antes da correção. Enter precisa
      // entregar o mesmo payload sem depender de tirar o foco do input.
      const salvar = abrir(tela);
      const usuario = userEvent.setup();
      if (tela === "Novo Lead") await usuario.type(screen.getByLabelText("Título"), "Consulta");
      const campo = screen.getByLabelText(CAMPO.label);
      await usuario.type(campo, texto);

      if (envio === "Enter") {
        expect(document.activeElement).toBe(campo);
        await usuario.keyboard("{Enter}");
      } else {
        await usuario.click(screen.getByRole("button", { name: tela === "Novo Lead" ? "Criar lead" : "Salvar" }));
      }

      await waitFor(() => expect(salvar).toHaveBeenCalledTimes(1));
      const chamada = salvar.mock.calls[0]![0];
      const payload = tela === "Ficha do negócio" ? chamada.patch : chamada;
      expect(payload.custom_fields).toEqual(
        tela === "Editar contato"
          ? { ...negocio.custom_fields, entrada: valor }
          : { entrada: valor },
      );
    });
  });
});

it("Novo Lead: Enter com moeda vazia continua recusando o campo obrigatório", async () => {
  abrir("Novo Lead");
  const usuario = userEvent.setup();
  await usuario.type(screen.getByLabelText("Título"), "Consulta");
  await usuario.click(screen.getByLabelText(CAMPO.label));
  await usuario.keyboard("{Enter}");
  expect(screen.getByRole("alert").textContent).toContain(CAMPO.label);
  expect(estado.criarLead).not.toHaveBeenCalled();
});

it.each([
  ["0", 0],
  ["", null],
] as const)("Ficha do negócio: Enter grava a alteração para %j", async (texto, valor) => {
  abrir("Ficha do negócio", { entrada: 1500, observacao: "Preservar este campo" });
  const usuario = userEvent.setup();
  const campo = screen.getByLabelText(CAMPO.label);
  await usuario.clear(campo);
  if (texto) await usuario.type(campo, texto);
  await usuario.keyboard("{Enter}");
  await waitFor(() => expect(estado.editarLead).toHaveBeenCalledTimes(1));
  // O formulário manda apenas o que mudou, inclusive zero e limpeza explícita.
  expect(estado.editarLead.mock.calls[0]![0].patch.custom_fields).toEqual({ entrada: valor });
});
