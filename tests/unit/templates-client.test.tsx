import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({
    data: [
      { id: "1", title: "Meu Pessoal", body: "Oi {{primeiro_nome}}", shortcut: "oi", owner_user_id: "u1" },
      { id: "2", title: "Política da Equipe", body: "Política de troca", shortcut: null, owner_user_id: null },
      { id: "3", title: "Pessoal do Outro", body: "Segredo do colega", shortcut: null, owner_user_id: "u2" },
    ],
    isLoading: false,
  }),
}));

import { TemplatesClient } from "@/app/app/templates/_components/TemplatesClient";

function wrap(ui: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

describe("TemplatesClient", () => {
  it("lista templates e abre o form de novo", () => {
    render(wrap(<TemplatesClient canShare={true} currentUserId="u1" />));
    expect(screen.getByText("Meu Pessoal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /novo template/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("agent (não-manager) só vê ações no próprio pessoal, não no compartilhado nem no de outro", () => {
    render(wrap(<TemplatesClient canShare={false} currentUserId="u1" />));
    // 3 templates listados, mas só 1 editável → 1 par de ações editar/excluir.
    expect(screen.getByText("Meu Pessoal")).toBeInTheDocument();
    expect(screen.getByText("Política da Equipe")).toBeInTheDocument();
    expect(screen.getByText("Pessoal do Outro")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Editar template" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Excluir template" })).toHaveLength(1);
  });

  it("manager vê ações no próprio E no compartilhado, mas não no pessoal de outro", () => {
    render(wrap(<TemplatesClient canShare={true} currentUserId="u1" />));
    // próprio (u1) + compartilhado (null) editáveis; pessoal de u2 não → 2 pares.
    expect(screen.getAllByRole("button", { name: "Editar template" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Excluir template" })).toHaveLength(2);
  });
});
