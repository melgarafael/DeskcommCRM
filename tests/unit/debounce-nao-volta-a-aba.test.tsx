import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveOrg } from "@/lib/auth/types";

/**
 * O DEBOUNCE DA BUSCA NÃO PODE DESFAZER A TROCA DE ABA.
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 * O efeito do debounce dependia só de `[searchInput]`, com `eslint-disable` —
 * então o timer agendado capturava o `value` DAQUELE render, `tab` incluído.
 * Digitar e trocar de aba em menos de 250 ms fazia o timer disparar com a aba
 * VELHA, e o operador era devolvido à aba anterior sem ter pedido.
 *
 * É o tipo de defeito que some em teste manual: quem sabe que ele existe digita
 * devagar. Quem não sabe troca de aba logo depois de digitar, que é o natural.
 */

const activeOrgRef: { current: ActiveOrg | null } = {
  current: { orgId: "org-1", name: "Org", role: "admin", visibility_mode: "all" },
};

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "canal",
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { unassigned: 3, mine: 2, all: 5, closed: 1 } }),
}));

const { InboxFilters } = await import("@/components/inbox/InboxFilters");
type Valor = import("@/components/inbox/InboxFilters").InboxFiltersValue;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("o debounce da busca não desfaz a troca de aba", () => {
  it("⭐ digitar e trocar de aba em <250 ms preserva a ABA NOVA", () => {
    let atual: Valor = { tab: "unassigned", search: "", onlyUnread: false };
    const onChange = vi.fn((next: Valor) => {
      atual = next;
    });

    const { rerender } = render(<InboxFilters value={atual} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Buscar conversas/i), {
      target: { value: "ana" },
    });

    // o operador troca de aba ANTES de o debounce fechar
    act(() => {
      onChange({ ...atual, tab: "all" });
    });
    rerender(<InboxFilters value={atual} onChange={onChange} />);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(atual.tab, "a aba nova foi desfeita pelo timer do debounce").toBe("all");
  });

  it("CONTROLE: a busca digitada CHEGA — o conserto não pode calar o debounce", () => {
    // Sem este caso, "nunca propagar nada" passaria no de cima.
    let atual: Valor = { tab: "unassigned", search: "", onlyUnread: false };
    const onChange = vi.fn((next: Valor) => {
      atual = next;
    });

    const { rerender } = render(<InboxFilters value={atual} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Buscar conversas/i), {
      target: { value: "ana" },
    });
    rerender(<InboxFilters value={atual} onChange={onChange} />);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(atual.search).toBe("ana");
  });

  it("CONTROLE: sem digitar nada, o debounce não dispara mudança nenhuma", () => {
    // Guarda de vacuidade: um efeito que propagasse a cada render manteria os dois
    // casos de cima verdes e encheria a lista de requisições iguais.
    const onChange = vi.fn();
    const valor: Valor = { tab: "unassigned", search: "", onlyUnread: false };
    render(<InboxFilters value={valor} onChange={onChange} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
