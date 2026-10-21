import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { InboxFilters, type InboxFiltersValue } from "./InboxFilters";

const state = vi.hoisted(() => ({
  panel: true,
  role: "manager",
  visibility: "all",
  conversationTags: ["retorno"],
  contactTags: ["vip"],
}));
vi.mock("@/components/ui-themes/Provider", () => ({
  useUiTheme: () => ({
    package: {
      id: "test-controls",
      apiVersion: 1,
      title: "Test controls",
      version: "1.0.0",
      optionsVersion: 1,
      options: [],
      areas: state.panel
        ? {
            inbox: { contractVersion: 1, configuration: { allTabFirst: true }, regions: {} },
            "inbox-filters": {
              contractVersion: 1,
              configuration: { viewControl: "select", advancedControl: "panel" },
              regions: {},
              layout: {
                type: "stack",
                children: ["search", "views", "quick", "advanced", "selection"].map((name) => ({
                  type: "slot",
                  name,
                })),
              },
            },
          }
        : {},
    },
    values: {},
    requestedId: "test-controls",
    fallback: null,
  }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    activeOrg: { orgId: "org-test", role: state.role, visibility_mode: state.visibility },
  }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "Channel",
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: state.conversationTags }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: state.contactTags }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { fila: 3, all: 5, mine: 2, automatico: 1 } }),
}));
vi.mock("./SeletorDeAtendente", () => ({
  SeletorDeAtendente: () => <button>Filtrar por atendente</button>,
}));

const initial: InboxFiltersValue = { tab: "all", search: "", onlyUnread: false };
function Controlled({ onChange }: { onChange: (value: InboxFiltersValue) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <InboxFilters
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}
beforeEach(() => {
  state.panel = true;
  state.role = "manager";
  state.visibility = "all";
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("host-owned filter presentations", () => {
  it("keeps the native tabs and inline controls when no alternative was selected", () => {
    state.panel = false;
    render(<InboxFilters value={initial} onChange={() => {}} />);
    expect(screen.getAllByRole("tab")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Filtrar por tag" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Filtros" })).toBeNull();
  });
  it("keeps direct quick filters and the same multi-tag behavior in the panel", async () => {
    const user = userEvent.setup({ delay: null });
    const changed = vi.fn();
    render(<Controlled onChange={changed} />);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Conversas exibidas" })).toHaveTextContent(
      "Todas (5)",
    );
    await user.click(screen.getByRole("button", { name: "Não lidos" }));
    await user.click(screen.getByRole("button", { name: "Filtros" }));
    expect(screen.getByText("Filtrar por atendente", { selector: "span" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Filtrar por tag" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "vip" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "retorno" }));
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      tab: "all",
      onlyUnread: true,
      tag: ["vip", "retorno"],
    });
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      tab: "all",
      onlyUnread: true,
      tag: undefined,
      tagMode: undefined,
    });
  });
  it("offers only the views authorized by the native role and visibility rule", async () => {
    state.role = "agent";
    state.visibility = "assigned";
    const user = userEvent.setup({ delay: null });
    render(<InboxFilters value={{ ...initial, tab: "mine" }} onChange={() => {}} />);
    await user.click(screen.getByRole("combobox", { name: "Conversas exibidas" }));
    expect(screen.queryByRole("option", { name: /^Todas/ })).toBeNull();
    expect(screen.getByRole("option", { name: /^Minhas/ })).toBeVisible();
  });
});
