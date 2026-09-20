import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceHome } from "@/app/app/_components/WorkspaceHome";
const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  auth: {
    user: { id: "u1", is_platform_admin: false },
    activeOrg: { orgId: "org1", name: "Empresa", role: "admin" },
  },
}));
vi.mock("@/app/app/_workspace-action", () => ({ askWorkspace: mocks.ask }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => mocks.auth }));
beforeEach(() => {
  mocks.auth.activeOrg.orgId = "org1";
  mocks.ask.mockReset();
});
function send() {
  fireEvent.change(screen.getByLabelText("O que você quer saber sobre seu CRM?"), {
    target: { value: "Resumo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Enviar pergunta" }));
}
describe("espaço conversacional", () => {
  it("sugestão preenche a pergunta sem executar chamada", () => {
    render(<WorkspaceHome />);
    fireEvent.click(screen.getByRole("button", { name: "Resuma as conversas recentes" }));
    expect(screen.getByLabelText("Onde consultar")).toHaveValue("conversations");
    expect(mocks.ask).not.toHaveBeenCalled();
  });
  it("apresenta fontes reais e mantém histórico para continuidade", async () => {
    mocks.ask.mockResolvedValue({
      ok: true,
      answer: "Ana pediu retorno.",
      sources: [
        { id: "c1", title: "Ana", kind: "Conversa", href: "/app/inbox?id=c1", text: "Retorno" },
      ],
      notice: "Recorte recente",
    });
    render(<WorkspaceHome />);
    send();
    await screen.findByText("Ana pediu retorno.");
    expect(screen.getByRole("link", { name: /Conversa.*Ana/ })).toHaveAttribute(
      "href",
      "/app/inbox?id=c1",
    );
    send();
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(2));
    expect(mocks.ask.mock.calls[1]?.[0].history).toHaveLength(2);
  });
  it("não perde pergunta na falha nem apresenta sucesso fictício", async () => {
    mocks.ask.mockRejectedValue(new Error("offline"));
    render(<WorkspaceHome />);
    send();
    await screen.findByRole("alert");
    expect(screen.getByLabelText("O que você quer saber sobre seu CRM?")).toHaveValue("Resumo");
    expect(screen.queryByLabelText("Conversa com seu CRM")).toBeNull();
  });
  it("não leva conversa de uma organização para outra", async () => {
    mocks.ask.mockResolvedValue({
      ok: true,
      answer: "Informação privada",
      sources: [],
      notice: "",
    });
    const view = render(<WorkspaceHome />);
    send();
    await screen.findByText("Informação privada");
    mocks.auth.activeOrg.orgId = "org2";
    view.rerender(<WorkspaceHome />);
    expect(screen.queryByText("Informação privada")).toBeNull();
    send();
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(2));
    expect(mocks.ask.mock.calls[1]?.[0].history).toEqual([]);
  });
});
