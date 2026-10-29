/**
 * O CAMPO DE VALOR DO FUNIL LÊ O QUE SE DIGITOU NA MOEDA DA ORGANIZAÇÃO.
 *
 * ⚠️ ESTE CASO EXISTE PORQUE O TESTE DO PARSER NÃO PROVA O CHAMADOR.
 *
 * `lib/money.test.ts` prova que `parseReaisToCents("1,300", "USD")` devolve
 * 130000; não prova que a TELA passa a moeda — um `parseReaisToCents(reais)`
 * sem segundo argumento continuava verde lá, e é exatamente o defeito medido
 * na instalação real (#3331): organização com `currency = USD`, a pessoa
 * digitava `1,300` no campo de valor do funil e o negócio era gravado com
 * **1,30**. O rótulo do campo já mostrava `Valor ($)` — a moeda chegava ao
 * desenho e parava antes do parser.
 *
 * O que este arquivo mede, nos DOIS lugares por onde a moeda precisa
 * atravessar num campo de dinheiro:
 *
 *   1. o eco embaixo do campo (`EcoDoValor`), que usa `parseReaisToCents` para
 *      dizer o que foi ENTENDIDO antes de salvar;
 *   2. o `value_cents` que o formulário manda para a API (`LeadFieldsForm`).
 *
 * Se o eco e a gravação divergirem, o eco vira mentira — e é justamente essa
 * divergência que se quer pegar aqui, não uma das duas metades.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderRTL, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const orgAtiva = vi.hoisted(() => ({
  atual: null as { currency: string; country: string | null; orgId: string } | null,
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => orgAtiva.atual,
  useAuth: () => ({ activeOrg: null }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// As etiquetas do negócio gravam na hora, por outra rota, e não têm nada a ver
// com o valor: o dublê tira o vocabulário de etiquetas da frente deste teste
// (a tela de verdade é medida em `tests/unit/tags-do-negocio-dentro-do-formulario.test.tsx`).
vi.mock("@/components/inbox/ContactTagsEditor", () => ({ ContactTagsEditor: () => null }));
// A gravação em si (react-query + API) é de outro teste: aqui o que importa é o
// `patch` que CHEGA até ela.
const editar = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync: editar.mutateAsync, isPending: false }),
}));

import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";

const LEAD_ID = "11111111-1111-4111-8111-111111111111";
const FUNIL = "33333333-3333-4333-8333-333333333333";

/** O negócio como o dossiê o entrega: a moeda gravada no próprio negócio. */
function negocio(moeda: string | null, valueCents = 0) {
  return {
    id: LEAD_ID,
    title: "Consultoria",
    description: null,
    value_cents: valueCents,
    currency: moeda,
    stage_id: "22222222-2222-4222-8222-222222222222",
    expected_close_date: null,
    tags: [],
    custom_fields: {},
  } as never;
}

function renderForm(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderRTL(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** O `value_cents` que o formulário tentou gravar na primeira chamada da API. */
function valorGravado(): number {
  const chamada = editar.mutateAsync.mock.calls[0];
  if (!chamada) throw new Error("o formulário não chamou a gravação");
  return (chamada[0] as { patch: { value_cents: number } }).patch.value_cents;
}

beforeEach(() => {
  orgAtiva.atual = { currency: "USD", country: null, orgId: "org-1" };
  editar.mutateAsync.mockReset();
  editar.mutateAsync.mockResolvedValue({ lead: { id: LEAD_ID } });
});

afterEach(() => {
  cleanup();
  orgAtiva.atual = null;
  vi.clearAllMocks();
});

describe("o valor do negócio é lido na moeda da organização (#3331)", () => {
  it("⭐ dólar: `1,300` grava mil e trezentos dólares, e o eco concorda", async () => {
    const usuario = userEvent.setup();
    renderForm(<LeadFieldsForm lead={negocio("USD")} pipelineId={FUNIL} />);

    const campo = screen.getByLabelText(/^Valor \(/);
    await usuario.clear(campo);
    await usuario.type(campo, "1,300");

    // O eco é a metade visível: `= $1,300.00`, e não `= $1.30`.
    expect(await screen.findByText(/= \$1,300\.00/)).toBeTruthy();

    await usuario.click(screen.getByRole("button", { name: /Salvar/ }));

    await waitFor(() => expect(editar.mutateAsync).toHaveBeenCalled());
    expect(editar.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: LEAD_ID,
        patch: expect.objectContaining({ value_cents: 130000 }),
      }),
    );
  });

  it("negócio sem moeda gravada usa a da organização (é ela que o rótulo mostra)", async () => {
    const usuario = userEvent.setup();
    renderForm(<LeadFieldsForm lead={negocio(null)} pipelineId={FUNIL} />);

    expect(screen.getByText(/Valor \(\$\)/)).toBeTruthy();
    const campo = screen.getByLabelText(/^Valor \(/);
    await usuario.clear(campo);
    await usuario.type(campo, "1,300");
    await usuario.click(screen.getByRole("button", { name: /Salvar/ }));

    await waitFor(() => expect(editar.mutateAsync).toHaveBeenCalled());
    expect(valorGravado()).toBe(130000);
  });

  it("e em real nada muda: `1,300` continua um e trinta (a vírgula é o decimal)", async () => {
    // A outra metade do acordo: o conserto não pode mexer na regra do pt-BR,
    // que é a de quem já usa o produto.
    orgAtiva.atual = { currency: "BRL", country: null, orgId: "org-1" };
    const usuario = userEvent.setup();
    renderForm(<LeadFieldsForm lead={negocio("BRL")} pipelineId={FUNIL} />);

    const campo = screen.getByLabelText(/^Valor \(/);
    await usuario.clear(campo);
    await usuario.type(campo, "1,300");

    expect(await screen.findByText(/= R\$\s?1,30/)).toBeTruthy();

    await usuario.click(screen.getByRole("button", { name: /Salvar/ }));
    await waitFor(() => expect(editar.mutateAsync).toHaveBeenCalled());
    expect(valorGravado()).toBe(130);
  });
});
