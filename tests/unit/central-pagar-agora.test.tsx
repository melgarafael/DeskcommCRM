import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ITEM = {
  id: "a1", kind: "cobranca", severity: "warn", title: "Não identificamos o pagamento de 05/10", body: "corpo", ref_kind: null, ref_id: null,
  status: "open", created_at: new Date().toISOString(),
  destination: { estado: "disponivel", rotulo: "Abrir plano e cobrança", href: "/app/settings/billing" },
};
const h = vi.hoisted(() => ({ itens: [] as unknown[] }));
vi.mock("@/hooks/ai/useAgentInbox", () => ({
  useAgentInbox: () => ({ data: { items: h.itens, open_count: h.itens.length }, error: null, isLoading: false, isError: false, refetch: vi.fn(), isFetching: false }),
  useUpdateInboxItem: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useResolveAllInboxItems: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

import { AgentInboxList } from "@/app/app/ai/inbox/_components/AgentInboxList";

afterEach(cleanup);

describe("Central — o aviso da cobrança paga em um clique", () => {
  it("⭐ com link: 'Pagar agora' abre a fatura, ao lado de 'Abrir plano e cobrança'", () => {
    h.itens = [{ ...ITEM, link_de_pagamento: "https://invoice.stripe.com/i/x" }];
    render(<AgentInboxList canResolve />);
    expect(screen.getByRole("link", { name: "Pagar agora" }).getAttribute("href")).toBe("https://invoice.stripe.com/i/x");
    expect(screen.getByRole("link", { name: "Abrir plano e cobrança" })).toBeTruthy();
  });

  it("sem link: só o caminho para o plano", () => {
    h.itens = [ITEM];
    render(<AgentInboxList canResolve />);
    expect(screen.queryByRole("link", { name: "Pagar agora" })).toBeNull();
  });
});
