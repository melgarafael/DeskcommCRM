import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentInboxList } from "@/app/app/ai/inbox/_components/AgentInboxList";
import { useAgentInbox, useUpdateInboxItem, type AgentInboxItem } from "@/hooks/ai/useAgentInbox";
import { ApiError } from "@/lib/api/types";
vi.mock("@/hooks/ai/useAgentInbox", () => ({ useAgentInbox: vi.fn(), useUpdateInboxItem: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
const mutate = vi.fn();
const item: AgentInboxItem = { id: "aviso", kind: "handoff", severity: "warn", title: "Atendimento aguardando", body: null, ref_kind: "conversation", ref_id: "ref", status: "open", created_at: new Date().toISOString(), destination: { estado: "disponivel", href: "/app/inbox/ref", rotulo: "Abrir conversa" } };
function dados(value = item) {
  vi.mocked(useAgentInbox).mockReturnValue({ data: { items: [value], open_count: 1 }, isLoading: false } as ReturnType<typeof useAgentInbox>);
}
beforeEach(() => { vi.clearAllMocks(); dados(); vi.mocked(useUpdateInboxItem).mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<typeof useUpdateInboxItem>); });
describe("Central: navegação separada da resolução", () => {
  it("contexto é link, clique não muda status; resolver chama uma vez", () => {
    render(<AgentInboxList canResolve />);
    const link = screen.getByRole("link", { name: "Abrir conversa" });
    expect(link).toHaveAttribute("href", "/app/inbox/ref");
    fireEvent.click(link); expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Marcar resolvido" }));
    expect(mutate).toHaveBeenCalledExactlyOnceWith({ id: "aviso", status: "resolved" });
    // Sem resposta de sucesso, o item continua aberto: não há remoção otimista.
    expect(screen.getByText(item.title)).toBeVisible();
  });
  it("resolvido mantém contexto e reabertura independente", () => {
    dados({ ...item, status: "resolved" }); render(<AgentInboxList canResolve />);
    expect(screen.getByRole("link")).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "Reabrir" }));
    expect(mutate).toHaveBeenCalledExactlyOnceWith({ id: "aviso", status: "open" });
  });
  it("fallback mostra orientação sem botão defeituoso", () => {
    dados({ ...item, destination: { estado: "indisponivel", orientacao: "Contexto indisponível" } }); render(<AgentInboxList canResolve />);
    expect(screen.queryByRole("link")).toBeNull(); expect(screen.getByText("Contexto indisponível")).toBeVisible();
    expect(screen.getByRole("button", { name: "Marcar resolvido" })).toBeEnabled();
  });
  it("falha inicial oferece nova tentativa e nunca afirma lista vazia", () => {
    const refetch = vi.fn();
    vi.mocked(useAgentInbox).mockReturnValue({ data: undefined, isError: true, isLoading: false, refetch } as unknown as ReturnType<typeof useAgentInbox>);
    render(<AgentInboxList canResolve />);
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível carregar");
    expect(screen.queryByText("Nenhum aviso em aberto")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetch).toHaveBeenCalledOnce();
  });
  it("falha de refetch conserva itens carregados com aviso de desatualização", () => {
    vi.mocked(useAgentInbox).mockReturnValue({ data: { items: [item], open_count: 1 }, isError: true, isLoading: false, refetch: vi.fn() } as unknown as ReturnType<typeof useAgentInbox>);
    render(<AgentInboxList canResolve />);
    expect(screen.getByText(item.title)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("pode estar desatualizada");
    expect(screen.getByRole("link", { name: "Abrir conversa" })).toBeVisible();
  });
  it("erro ao resolver fica visível e preserva o aviso aberto", () => {
    vi.mocked(useUpdateInboxItem).mockReturnValue({ mutate, isPending: false, isError: true } as unknown as ReturnType<typeof useUpdateInboxItem>);
    render(<AgentInboxList canResolve />);
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível atualizar este aviso");
    expect(screen.getByText(item.title)).toBeVisible();
    expect(screen.getByRole("button", { name: "Marcar resolvido" })).toBeEnabled();
  });
  it.each([401, 403])("refetch %i retira dados e ações autorizadas anteriormente", status => {
    vi.mocked(useAgentInbox).mockReturnValue({ data: { items: [item], open_count: 1 }, isError: true, error: new ApiError(status, "forbidden", undefined, "req"), isLoading: false, refetch: vi.fn() } as unknown as ReturnType<typeof useAgentInbox>);
    render(<AgentInboxList canResolve />);
    expect(screen.getByRole("alert")).toHaveTextContent("Seu acesso aos avisos não está disponível");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(item.title)).toBeNull();
    expect(screen.queryByRole("button", { name: "Marcar resolvido" })).toBeNull();
  });
  it("nova leitura bem-sucedida recupera lista e remove estado de falha", () => {
    vi.mocked(useAgentInbox).mockReturnValue({ data: undefined, isError: true, isLoading: false, refetch: vi.fn() } as unknown as ReturnType<typeof useAgentInbox>);
    const view = render(<AgentInboxList canResolve />);
    expect(screen.getByRole("alert")).toBeVisible();
    dados(); view.rerender(<AgentInboxList canResolve />);
    expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByRole("link")).toBeVisible();
  });
});
