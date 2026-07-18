/**
 * G4-02 — Inbox com escopo (acceptance 1 e 4). Prova que a visão 'Todas' é
 * ocultada para `agent` em modo own* e visível para manager/admin/viewer, e que
 * as contagens por visão são renderizadas a partir do hook RLS-scoped
 * (useConversationCounts → /api/v1/conversations/counts, client user-scoped).
 *
 * A garantia REAL de escopo (agent forçando ?filter=all não vaza) é da RLS —
 * provada em tests/invariants/gov-5b-inbox-scope-counts.test.ts (contagem sob a
 * role agent = escopo, não total da org). Aqui é a superfície de UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { InboxFilters, visibleInboxTabs, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type { ActiveOrg } from "@/lib/auth/types";

const activeOrgRef: { current: ActiveOrg | null } = { current: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { unassigned: 3, mine: 2, all: 5 } }),
}));

const VALUE: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };

function setOrg(role: ActiveOrg["role"], visibility_mode: ActiveOrg["visibility_mode"]) {
  activeOrgRef.current = { orgId: "org-1", name: "Org", role, visibility_mode };
}

beforeEach(() => setOrg("agent", "own_and_unassigned"));
afterEach(cleanup);

describe("visibleInboxTabs (lógica pura de visões)", () => {
  it("agent em own_and_unassigned NÃO vê 'all'", () => {
    expect(visibleInboxTabs("agent", "own_and_unassigned")).not.toContain("all");
  });
  it("agent em 'own' NÃO vê 'all'", () => {
    expect(visibleInboxTabs("agent", "own")).not.toContain("all");
  });
  it("agent em 'all' VÊ 'all'", () => {
    expect(visibleInboxTabs("agent", "all")).toContain("all");
  });
  it("manager sempre vê 'all' (org-wide read)", () => {
    expect(visibleInboxTabs("manager", "own")).toContain("all");
  });
  it("viewer sempre vê 'all' (org-wide read)", () => {
    expect(visibleInboxTabs("viewer", "own")).toContain("all");
  });
  it("admin sempre vê 'all'", () => {
    expect(visibleInboxTabs("admin", "own")).toContain("all");
  });
  it("as 3 visões nomeadas existem (Minhas/Fila/Todas) para manager", () => {
    const tabs = visibleInboxTabs("manager", "own_and_unassigned");
    expect(tabs).toEqual(expect.arrayContaining(["mine", "unassigned", "all"]));
  });
});

describe("InboxFilters render — 3 visões + escopo", () => {
  it("agent em modo own*: mostra Minhas e Fila, esconde Todas", () => {
    setOrg("agent", "own_and_unassigned");
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /Minhas/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Fila/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Todas/ })).not.toBeInTheDocument();
  });

  it("manager: mostra Todas", () => {
    setOrg("manager", "own_and_unassigned");
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /Todas/ })).toBeInTheDocument();
  });

  it("contagens por visão são renderizadas (Fila=3, Minhas=2)", () => {
    setOrg("manager", "all");
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /Fila/ })).toHaveTextContent("3");
    expect(screen.getByRole("tab", { name: /Minhas/ })).toHaveTextContent("2");
    expect(screen.getByRole("tab", { name: /Todas/ })).toHaveTextContent("5");
  });
});
