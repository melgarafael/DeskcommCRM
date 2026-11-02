/**
 * A MENSALIDADE NOS TRÊS FORMULÁRIOS DO NEGÓCIO (#3610, fatia 1 da #3602).
 *
 * Dois defeitos que só a prova pela tela pegou, porque o teste da régua
 * (`tests/unit/negocio-valor-recorrente.test.ts`) não monta formulário:
 *
 *  D1. depois de criar um negócio com mensalidade, reabrir "Novo Lead" SEM
 *      recarregar mostrava a mensalidade e a duração do negócio anterior — o
 *      `form.reset` pós-criação não conhecia os dois campos novos, e o próximo
 *      negócio nascia com a mensalidade do outro;
 *  D2. apagar a mensalidade de um negócio que a tinha (funil e dossiê) não
 *      levava a duração junto: a régua do formulário via "duração sem
 *      mensalidade" e recusava, e o negócio não salvava. O servidor já trata
 *      mensalidade nula como "sem recorrência" e zera o trio
 *      (`recorrenciaParaGravar`); a tela agora pede o mesmo.
 *
 * O que continua recusa, e este arquivo prende: duração digitada num negócio
 * que NUNCA teve mensalidade (é o passo 3 da prova).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Stage } from "@/lib/kanban/types";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
const editar = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null, role: "agent", orgId: "org-1" }),
  useAuth: () => ({ user: { id: "usuario-eu" }, activeOrg: null }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/inbox/ContactTagsEditor", () => ({ ContactTagsEditor: () => null }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync: editar.mutateAsync, isPending: false }),
}));

import { EditLeadDialog } from "@/components/kanban/EditLeadDialog";
import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";

const FUNIL = "11111111-1111-4111-8111-111111111111";
const ETAPA = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "44444444-4444-4444-8444-444444444444";

const STAGE: Stage = {
  id: ETAPA,
  organization_id: "org-1",
  pipeline_id: FUNIL,
  name: "Novo",
  slug: "novo",
  position: 0,
  color: null,
  is_won: false,
  is_lost: false,
  is_archived: false,
  expected_duration_hours: null,
};

/** Negócio de setup + mensalidade, como o funil e o dossiê o recebem. */
function negocio(recorrente: { cents: number | null; meses: number | null }) {
  return {
    id: LEAD_ID,
    organization_id: "org-1",
    pipeline_id: FUNIL,
    stage_id: ETAPA,
    title: "Plano clínica",
    description: null,
    value_cents: 300000,
    recurring_value_cents: recorrente.cents,
    recurring_period: recorrente.cents === null ? null : "monthly",
    recurring_months: recorrente.meses,
    currency: "BRL",
    expected_close_date: null,
    tags: [],
    custom_fields: {},
  } as never;
}

function comQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** O `patch` da primeira gravação que o formulário pediu. */
function patchGravado(): Record<string, unknown> {
  const chamada = editar.mutateAsync.mock.calls[0];
  if (!chamada) throw new Error("o formulário não chamou a gravação");
  return (chamada[0] as { patch: Record<string, unknown> }).patch;
}

beforeEach(() => {
  editar.mutateAsync.mockReset();
  editar.mutateAsync.mockResolvedValue({ lead: { id: LEAD_ID } });
  Object.values(toastMock).forEach((f) => f.mockReset());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const corpo = String(url).includes("/api/v1/leads")
        ? { data: { id: LEAD_ID, title: "Plano clínica" } }
        : { data: [] };
      return new Response(JSON.stringify(corpo), {
        status: String(url).includes("/api/v1/leads") ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("D1 — Novo Lead reaberto sem recarregar nasce sem a mensalidade do anterior", () => {
  it("criar com 500/mês por 12 meses e reabrir: os dois campos voltam vazios", async () => {
    function Pai() {
      const [aberto, setAberto] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setAberto(true)}>
            reabrir
          </button>
          <NewLeadDialog open={aberto} onOpenChange={setAberto} pipelineId={FUNIL} stages={[STAGE]} leads={[]} />
        </>
      );
    }
    const user = userEvent.setup();
    comQuery(<Pai />);

    await user.type(screen.getByLabelText("Título"), "Plano clínica");
    await user.type(screen.getByLabelText(/^Valor recorrente \(mensal\)/), "500");
    await user.type(screen.getByLabelText("Duração (meses)"), "12");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Lead criado"));
    await waitFor(() => expect(screen.queryByLabelText("Título")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "reabrir" }));

    expect(await screen.findByLabelText(/^Valor recorrente \(mensal\)/)).toHaveValue("");
    expect(screen.getByLabelText("Duração (meses)")).toHaveValue("");
  });
});

describe("D2 — apagar a mensalidade leva a duração junto", () => {
  it.each([
    ["EditLeadDialog (funil)", () => <EditLeadDialog open onOpenChange={() => {}} lead={negocio({ cents: 50000, meses: 12 })} pipelineId={FUNIL} />],
    ["LeadFieldsForm (dossiê)", () => <LeadFieldsForm lead={negocio({ cents: 50000, meses: 12 })} pipelineId={FUNIL} />],
  ])("%s: salva e grava o trio nulo", async (_nome, montar) => {
    const user = userEvent.setup();
    comQuery(montar());

    await user.clear(screen.getByLabelText(/^Valor recorrente \(mensal\)/));
    await user.click(screen.getByRole("button", { name: /Salvar/ }));

    await waitFor(() => expect(editar.mutateAsync).toHaveBeenCalled());
    expect(patchGravado()).toMatchObject({
      recurring_value_cents: null,
      recurring_period: null,
      recurring_months: null,
    });
    expect(screen.queryByText("Informe a mensalidade para usar a duração")).not.toBeInTheDocument();
  });

  it.each([
    ["EditLeadDialog (funil)", () => <EditLeadDialog open onOpenChange={() => {}} lead={negocio({ cents: null, meses: null })} pipelineId={FUNIL} />],
    ["LeadFieldsForm (dossiê)", () => <LeadFieldsForm lead={negocio({ cents: null, meses: null })} pipelineId={FUNIL} />],
  ])("%s: duração num negócio que nunca teve mensalidade continua recusa", async (_nome, montar) => {
    const user = userEvent.setup();
    comQuery(montar());

    await user.type(screen.getByLabelText("Duração (meses)"), "12");
    await user.click(screen.getByRole("button", { name: /Salvar/ }));

    expect(await screen.findByText("Informe a mensalidade para usar a duração")).toBeInTheDocument();
    expect(editar.mutateAsync).not.toHaveBeenCalled();
  });
});
