import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BulkActionBar } from "@/components/kanban/BulkActionBar";

/**
 * Tag em lote só oferecia "nova tag" (#852, item 3 da divisão). No funil, com
 * cards selecionados, o menu "Tag…" não mostrava nenhuma tag que já existe nos
 * leads — cada pessoa digitava a sua variação.
 *
 * A lista vem da página (as tags dos leads do quadro, a mesma conta do
 * FilterBar): a ação em lote grava em `lead.tags`, então é essa a lista certa.
 */

const mutate = vi.fn();
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate, isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u-1" }),
  useActiveOrg: () => ({ orgId: "org-1", role: "agent" }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function renderBarra() {
  return render(
    <BulkActionBar
      selectedIds={["l-1", "l-2"]}
      stages={[]}
      pipelineId="p-1"
      tagsExistentes={["google", "indicação", "vip"]}
      onClear={vi.fn()}
    />,
  );
}

beforeEach(() => mutate.mockReset());

describe("BulkActionBar — tag em lote", () => {
  it("o menu mostra as tags existentes e clicar aplica a escolhida aos selecionados", async () => {
    renderBarra();
    await userEvent.click(screen.getByRole("button", { name: /tag/i }));

    const google = await screen.findByRole("menuitem", { name: "google" });
    expect(screen.getByRole("menuitem", { name: "vip" })).toBeTruthy();

    await userEvent.click(google);

    expect(mutate).toHaveBeenCalledWith(
      { action: "tag", lead_ids: ["l-1", "l-2"], params: { add: ["google"] } },
      expect.anything(),
    );
  });

  it("digitar filtra as tags existentes", async () => {
    renderBarra();
    await userEvent.click(screen.getByRole("button", { name: /tag/i }));
    await screen.findByRole("menuitem", { name: "vip" });

    await userEvent.type(screen.getByPlaceholderText("nova tag"), "goo");

    expect(screen.getByRole("menuitem", { name: "google" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "vip" })).toBeNull();
  });
});
