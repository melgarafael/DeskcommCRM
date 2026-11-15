/**
 * Doc 301 = B: o aviso da automação que segurou o que fala com o cliente (a IA
 * mexeu no modo assistido) traz o botão "Disparar agora" — só para quem é gestor,
 * e só enquanto o aviso está aberto.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const RUN = "33333333-3333-4333-8333-333333333333";
const ITEM = {
  id: "a1", kind: "other", severity: "warn", title: "Automação esperando aprovação para falar com o cliente", body: "corpo",
  ref_kind: "automation_rule_run", ref_id: RUN, status: "open", created_at: new Date().toISOString(),
  destination: { estado: "disponivel", rotulo: "Ver na atividade das automações", href: "/app/webhooks?aba=atividade" },
};
const h = vi.hoisted(() => ({ itens: [] as unknown[], disparar: vi.fn() }));
vi.mock("@/hooks/ai/useAgentInbox", () => ({
  useAgentInbox: () => ({ data: { items: h.itens, open_count: h.itens.length }, error: null, isLoading: false, isError: false, refetch: vi.fn(), isFetching: false, podeConsultar: true }),
  useUpdateInboxItem: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useResolveAllInboxItems: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useDispararAcoesParadas: () => ({ mutate: h.disparar, isPending: false, isError: false }),
}));

import { AgentInboxList } from "@/app/app/ai/inbox/_components/AgentInboxList";

afterEach(() => {
  cleanup();
  h.disparar.mockClear();
});

describe("Central — disparar o que a automação segurou no assistido", () => {
  it("gestor vê 'Disparar agora', e o clique dispara o run do aviso", () => {
    h.itens = [ITEM];
    render(<AgentInboxList canResolve podeDisparar />);
    fireEvent.click(screen.getByRole("button", { name: "Disparar agora" }));
    expect(h.disparar).toHaveBeenCalledWith(RUN);
  });

  it("quem não é gestor não vê o botão", () => {
    h.itens = [ITEM];
    render(<AgentInboxList canResolve />);
    expect(screen.queryByRole("button", { name: "Disparar agora" })).toBeNull();
  });

  it("aviso já resolvido (disparado ou descartado) não oferece o botão", () => {
    h.itens = [{ ...ITEM, status: "resolved" }];
    render(<AgentInboxList canResolve podeDisparar />);
    expect(screen.queryByRole("button", { name: "Disparar agora" })).toBeNull();
  });

  it("outro aviso 'other' não ganha o botão", () => {
    h.itens = [{ ...ITEM, ref_kind: "lead" }];
    render(<AgentInboxList canResolve podeDisparar />);
    expect(screen.queryByRole("button", { name: "Disparar agora" })).toBeNull();
  });
});
