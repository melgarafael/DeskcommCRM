import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({
    data: [{ id: "1", title: "Saudação", body: "Oi {{primeiro_nome}}", shortcut: "oi", owner_user_id: "u1" }],
    isLoading: false,
  }),
}));

import { TemplatesClient } from "@/app/app/templates/_components/TemplatesClient";

function wrap(ui: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

describe("TemplatesClient", () => {
  it("lista templates e abre o form de novo", () => {
    render(wrap(<TemplatesClient canShare={true} />));
    expect(screen.getByText("Saudação")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /novo template/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
