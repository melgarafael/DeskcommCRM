import { useEffect } from "react";

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

// ── Mocks só do caso do PONTO DE USO (a página do funil) ────────────────────
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/pipelines/p-1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  useBoard: () => ({
    data: {
      pipeline: { id: "p-1", vocabulary: null },
      stages: [],
      leads: [{ id: "l-1", tags: ["google", "vip"] }],
    },
    isLoading: false,
    error: null,
    pulses: [],
    realtimeStatus: "SUBSCRIBED",
    seguranca: { divergencias: 0, ultimaVerificacao: null },
  }),
}));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));
/**
 * O quadro é substituído por um dublê que SELECIONA um card: a barra em lote só
 * aparece com seleção, e arrastar card de verdade não é o que este caso mede.
 */
vi.mock("@/components/kanban/KanbanBoard", () => ({
  KanbanBoard: ({ onSelectionChange }: { onSelectionChange: (ids: string[]) => void }) => {
    useEffect(() => onSelectionChange(["l-1"]), [onSelectionChange]);
    return null;
  },
}));

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

    const campo = screen.getByPlaceholderText("nova tag") as HTMLInputElement;
    await userEvent.type(campo, "goo");

    // O QUE FOI DIGITADO, e não só o que sobrou na lista. Com ["google",
    // "indicação", "vip"], a tecla "g" sozinha já satisfaz as duas asserções
    // abaixo — "g", "go" e "goo" seriam indistinguíveis, e é por isso que este
    // caso não acusava o roubo de foco do typeahead do menu.
    expect(campo.value).toBe("goo");
    expect(screen.getByRole("menuitem", { name: "google" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "vip" })).toBeNull();
  });

  it("⭐ digitar uma tag NOVA que começa como uma existente aplica a digitada, não a do menu", async () => {
    // O caso que o menu do Radix quebrava. `verão` e `vip` começam com "v": o
    // typeahead do conteúdo levava o foco para o item "vip" na PRIMEIRA tecla, e
    // o Enter — que para um `MenuItem` é tecla de SELEÇÃO — aplicava "vip" a
    // todos os cards selecionados. Medido em jsdom antes do conserto: o campo
    // recebia "v" ao digitar "verão".
    renderBarra();
    await userEvent.click(screen.getByRole("button", { name: /tag/i }));
    await screen.findByRole("menuitem", { name: "vip" });

    const campo = screen.getByPlaceholderText("nova tag") as HTMLInputElement;
    await userEvent.type(campo, "verão");
    expect(campo.value).toBe("verão");

    await userEvent.type(campo, "{Enter}");
    expect(mutate).toHaveBeenCalledWith(
      { action: "tag", lead_ids: ["l-1", "l-2"], params: { add: ["verão"] } },
      expect.anything(),
    );
  });
});

/**
 * O PONTO DE USO — sem ele, apagar uma linha da página faz o recurso sumir do
 * produto com a suíte 100% verde.
 *
 * O único call site do repositório é `app/app/pipelines/[id]/_client.tsx`, e os
 * casos acima passam a lista na mão: tirar o `tagsExistentes={tagsDoQuadro}` da
 * página deixaria TODOS eles verdes, com o menu vazio na tela.
 *
 * A prop deixou de ser opcional com default `[]` na triagem — hoje apagar
 * aquela linha também reprova o `pnpm typecheck`. Os dois gates ficam: o tipo
 * pega a linha apagada, este caso pega a linha que passa a lista ERRADA (um
 * `[]` literal, a lista de outro quadro), que o tipo aceita sem reclamar.
 */
describe("a página do funil ENTREGA as tags do quadro à barra", () => {
  it("as tags dos leads do quadro chegam ao menu de tag em lote", async () => {
    const { PipelinePageClient } = await import("@/app/app/pipelines/[id]/_client");
    render(<PipelinePageClient pipelineId="p-1" initialName="Funil" />);

    await userEvent.click(await screen.findByRole("button", { name: /tag/i }));
    expect(await screen.findByRole("menuitem", { name: "google" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "vip" })).toBeTruthy();
  });
});
