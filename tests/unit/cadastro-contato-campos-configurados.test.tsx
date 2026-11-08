import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ fields: [] as unknown[], save: vi.fn(), enabled: vi.fn(), leadId: vi.fn() }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ orgId: "11111111-1111-4111-8111-111111111111", role: "agent", country: "BR" }), useAuth: () => ({ activeOrg: null }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: (enabled: boolean) => { state.enabled(enabled); return { data: { pipeline: { settings: { fields: state.fields } } } }; } }));
vi.mock("@/hooks/contacts/useCreateContact", () => ({ useCreateContact: (leadId?: string) => { state.leadId(leadId); return { mutateAsync: state.save, isPending: false }; } }));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [], isError: false }) }));
vi.mock("@/hooks/tags/useDefinirCorDaEtiqueta", () => ({ useDefinirCorDaEtiqueta: () => ({ definirCor: vi.fn() }) }));
vi.mock("@/components/contacts/EtiquetasDoContato", () => ({ EtiquetasDoContato: () => null }));
vi.mock("@/components/channels/AbrirConversaAposSalvar", () => ({ AbrirConversaAposSalvar: () => null }));
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
function mount(open = true) { return render(<QueryClientProvider client={new QueryClient()}><NewContactDialog open={open} onOpenChange={() => {}} permitirIniciarConversa={false} /></QueryClientProvider>); }
beforeEach(() => { vi.clearAllMocks(); state.fields = [{ key: "preferencia", label: "Preferência", type: "text", escopo: "contato" }, { key: "etapa_extra", label: "Só negócio", type: "text", escopo: "negocio" }]; state.save.mockResolvedValue({ data: { contact: { id: "synthetic" } } }); });
afterEach(cleanup);
describe("campos configurados no cadastro", () => {
  it("mostra somente campos do contato e envia o valor pela criação nativa", async () => {
    mount();
    expect(screen.queryByText("Só negócio")).toBeNull();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pessoa sintética" } });
    fireEvent.change(screen.getByLabelText("Preferência"), { target: { value: "Manhã" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar contato" }));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ custom_fields: { preferencia: "Manhã" } })));
  });
  it("criar pelo negócio envia os campos configurados e o endereço junto dos dados do card", async () => {
    render(<QueryClientProvider client={new QueryClient()}><NewContactDialog open onOpenChange={() => {}} leadId="22222222-2222-4222-8222-222222222222" nomeInicial="Maria" dadosIniciais={{ email: "maria@exemplo.test", tags: ["quente"] }} permitirIniciarConversa={false} /></QueryClientProvider>);
    expect(state.leadId).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    fireEvent.change(screen.getByLabelText("Preferência"), { target: { value: "Manhã" } });
    fireEvent.change(screen.getByLabelText("Logradouro"), { target: { value: "Rua XV" } });
    fireEvent.change(screen.getByLabelText("Cidade"), { target: { value: "Curitiba" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar contato" }));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ name: "Maria", email: "maria@exemplo.test", tags: ["quente"], custom_fields: { preferencia: "Manhã" }, street: "Rua XV", city: "Curitiba" })));
  });
  it("sem configuração não inventa campos nem defaults de cliente", () => { state.fields = []; mount(); expect(screen.queryByText("Campos personalizados")).toBeNull(); });
  it("fechado não habilita a consulta de definições", () => { mount(false); expect(state.enabled).toHaveBeenLastCalledWith(false); });
});
