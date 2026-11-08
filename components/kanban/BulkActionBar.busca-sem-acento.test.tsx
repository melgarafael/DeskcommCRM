import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BulkActionBar } from "./BulkActionBar";

/**
 * A BUSCA DE ETIQUETA EXISTENTE NA AÇÃO EM LOTE IGNORA ACENTO (#4166).
 *
 * Com cards selecionados, o menu "Tag…" lista as etiquetas do quadro. A
 * etiqueta se chama "Promoção"; quem digitava `promocao` não a via na lista e
 * criava uma SEGUNDA etiqueta, quase igual — que é o defeito da issue.
 *
 * A régua é `termoSemAcento` (`lib/inbox/termo-de-busca`), a mesma da busca do
 * Inbox: os dois lados passam por ela.
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

const ETIQUETAS = ["Promoção", "vip"];

function montar() {
  render(
    <BulkActionBar
      selectedIds={["l-1"]}
      stages={[{ id: "s1", name: "Novo" }] as never}
      pipelineId="p-1"
      tagsExistentes={ETIQUETAS}
      onClear={vi.fn()}
    />,
  );
}

describe("busca de etiqueta existente na barra em lote", () => {
  it("acha a etiqueta acentuada digitando sem acento (#4166)", async () => {
    const user = userEvent.setup();
    montar();

    await user.click(screen.getByRole("button", { name: /tag/i }));
    const campo = screen.getByPlaceholderText("nova tag");
    await user.type(campo, "promocao");

    expect(campo).toHaveValue("promocao");
    expect(screen.getByRole("menuitem", { name: "Promoção" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "vip" })).toBeNull();
  });

  it("controle negativo: termo que não casa não inventa etiqueta", async () => {
    const user = userEvent.setup();
    montar();

    await user.click(screen.getByRole("button", { name: /tag/i }));
    await screen.findByRole("menuitem", { name: "Promoção" });
    await user.type(screen.getByPlaceholderText("nova tag"), "zzz");

    expect(screen.queryByRole("menuitem", { name: "Promoção" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "vip" })).toBeNull();
  });
});
