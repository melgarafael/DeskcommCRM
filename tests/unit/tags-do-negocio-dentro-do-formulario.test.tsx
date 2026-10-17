/**
 * O EDITOR DE ETIQUETAS DENTRO DO FORMULÁRIO DO NEGÓCIO NÃO SUBMETE O FORMULÁRIO (#3021).
 *
 * O `ContactTagsEditor` nasceu fora de `<form>` (Inbox). No funil ele mora
 * DENTRO do "Editar lead" e do formulário do dossiê, e um `<button>` sem `type`
 * dentro de `<form>` é `submit`: o "+" gravava a etiqueta E salvava os outros
 * campos (2 PATCH, e o diálogo fechava), e ainda virava o botão padrão do
 * formulário — desabilitado com o rascunho vazio, o Enter no Título parava de
 * salvar. Os três casos abaixo ficam vermelhos sem `type="button"` no "+".
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", currency: "BRL" }),
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: "agent" } }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
const api = vi.hoisted(() => ({
  get: vi.fn(async () => ({ data: [] })),
  post: vi.fn(async () => ({ data: {} })),
  patch: vi.fn(async () => ({ data: {} })),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

import { EditLeadDialog } from "@/components/kanban/EditLeadDialog";
import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";

const LEAD = {
  id: "l-1", title: "Pacote Lisboa", description: null, value_cents: null, currency: "BRL",
  tags: [], expected_close_date: null, custom_fields: {},
} as never;

function montar(ui: React.ReactElement) {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={c}>{ui}</QueryClientProvider>);
}
afterEach(() => { cleanup(); api.patch.mockClear(); });

const corpos = () => api.patch.mock.calls.map((c) => (c as unknown[])[1]);

describe("o + do editor de etiquetas dentro do formulario do negocio (#3021)", () => {
  it("EditLeadDialog: clicar + grava so a etiqueta; nao salva nem fecha o formulario", async () => {
    const onOpenChange = vi.fn();
    montar(<EditLeadDialog open onOpenChange={onOpenChange} lead={LEAD} pipelineId="p-1" />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Adicionar tag ao negócio"), "vip");
    await u.click(screen.getByRole("button", { name: "Adicionar tag" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 100));
    expect(corpos()).toEqual([{ tags: ["vip"] }]);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("LeadFieldsForm (dossie): clicar + grava so a etiqueta; nao dispara o Salvar", async () => {
    const onSaved = vi.fn();
    montar(<LeadFieldsForm lead={LEAD} pipelineId="p-1" onSaved={onSaved} />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Adicionar tag ao negócio"), "vip");
    await u.click(screen.getByRole("button", { name: "Adicionar tag" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 100));
    expect(corpos()).toEqual([{ tags: ["vip"] }]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("EditLeadDialog: Enter no titulo continua salvando o formulario", async () => {
    montar(<EditLeadDialog open onOpenChange={vi.fn()} lead={LEAD} pipelineId="p-1" />);
    const u = userEvent.setup();
    const titulo = screen.getByLabelText("Título");
    await u.clear(titulo);
    await u.type(titulo, "Pacote Porto{Enter}");
    await waitFor(() => expect(api.patch).toHaveBeenCalled(), { timeout: 2000 });
    expect(corpos()[0]).toMatchObject({ title: "Pacote Porto" });
  });
});
