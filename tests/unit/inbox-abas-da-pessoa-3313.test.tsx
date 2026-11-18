/**
 * AS ABAS DA INBOX DE CADA PESSOA, NA TELA (#3313, item 2).
 *
 * A issue pede reordenar e ocultar as abas, por pessoa, sem sumir caminho: a
 * aba oculta continua num menu "Mais". O que este arquivo mede, pela tela:
 *
 *   - sem preferência, a faixa é EXATAMENTE a de hoje (quem nunca abriu o
 *     diálogo não vê nada mudar além da porta para organizar);
 *   - com preferência, a faixa segue a ordem da pessoa e as ocultas vão para o
 *     menu, de onde continuam abrindo;
 *   - a aba aberta que está oculta aparece no botão do menu, marcada;
 *   - preferência não é permissão: "Todas" e "Pessoal" seguem o papel;
 *   - o diálogo grava a ordem e as ocultas, e a faixa acompanha o que o
 *     servidor gravou; a última aba visível não pode sair; Cancelar não grava.
 *
 * As regras puras (normalização, faixa nunca vazia) estão em
 * `lib/inbox/abas-da-inbox.test.ts`; a gravação no metadata da pessoa, em
 * `app/actions/inbox/abasDaInbox.test.ts`.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import { normalizarAbas, type AbaDaPessoa } from "@/lib/inbox/abas-da-inbox";
import type { ActiveOrg } from "@/lib/auth/types";

const h = vi.hoisted(() => ({
  activeOrg: null as ActiveOrg | null,
  salvar: vi.fn(),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: h.activeOrg }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "canal",
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({
    data: { fila: 3, mine: 2, all: 5, automatico: 7, closed: 4, archived: 1, pessoal: 6 },
  }),
}));
vi.mock("@/app/actions/inbox/abasDaInbox", () => ({ salvarAbasDaInbox: h.salvar }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const VALUE: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };

/** O rótulo de cada aba da faixa, sem o contador colado no `textContent`. */
function faixa(): string[] {
  return screen
    .getAllByRole("tab")
    .map((el) => (el.textContent ?? "").replace(/\d+$/, "").trim());
}

const menu = () => screen.getByTestId("menu-das-abas");

/** Fila, Minhas e Automático primeiro; Todas e Arquivadas no menu. */
const DA_AGENCIA: AbaDaPessoa[] = normalizarAbas([
  { id: "unassigned", visivel: true },
  { id: "mine", visivel: true },
  { id: "ai", visivel: true },
  { id: "all", visivel: false },
  { id: "archived", visivel: false },
]);

beforeEach(() => {
  h.activeOrg = { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" };
  h.salvar.mockReset();
  h.salvar.mockImplementation(async (abas: AbaDaPessoa[]) => ({ ok: true, abas: normalizarAbas(abas) }));
});
afterEach(cleanup);

describe("sem preferência, a faixa é a de hoje", () => {
  it("as sete abas, na ordem padrão, e o menu só com a porta para organizar", async () => {
    const user = userEvent.setup({ delay: null });
    render(<InboxFilters value={VALUE} onChange={() => {}} />);

    expect(faixa()).toEqual(["Automático", "Fila", "Minhas", "Todas", "Fechadas", "Arquivadas", "Pessoal"]);
    expect(menu()).toHaveAccessibleName("Personalizar abas");

    await user.click(menu());
    expect(screen.queryByText("Abas ocultas")).toBeNull();
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(screen.getByRole("menuitem", { name: "Personalizar abas…" })).toBeInTheDocument();
  });
});

describe("com preferência, a faixa é a da pessoa", () => {
  it("a ordem é a escolhida, e as ocultas saem da faixa", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} abasIniciais={DA_AGENCIA} />);

    expect(faixa()).toEqual(["Fila", "Minhas", "Automático", "Fechadas", "Pessoal"]);
    expect(menu()).toHaveTextContent("Mais");
    // No celular a barra de baixo já tem um botão "Mais" (a navegação): este
    // tem nome próprio, que começa pelo que está escrito nele.
    expect(menu()).toHaveAccessibleName("Mais abas");
  });

  it("as ocultas continuam abrindo pelo menu, com o contador de cada uma", async () => {
    const user = userEvent.setup({ delay: null });
    const onChange = vi.fn();
    render(<InboxFilters value={VALUE} onChange={onChange} abasIniciais={DA_AGENCIA} />);

    await user.click(menu());
    const ocultas = screen.getAllByRole("menuitemradio");
    expect(ocultas.map((el) => (el.textContent ?? "").replace(/\d+$/, "").trim())).toEqual(["Todas", "Arquivadas"]);
    expect(ocultas[1]).toHaveTextContent("1");

    await user.click(screen.getByRole("menuitemradio", { name: /Arquivadas/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tab: "archived" }));
  });

  it("a aba aberta que está oculta aparece no botão, marcada como a ativa", () => {
    render(
      <InboxFilters value={{ ...VALUE, tab: "archived" }} onChange={() => {}} abasIniciais={DA_AGENCIA} />,
    );

    expect(menu()).toHaveTextContent("Arquivadas");
    expect(menu()).toHaveTextContent("1");
    expect(menu()).toHaveAttribute("data-state-aba", "active");
    expect(menu()).toHaveAccessibleName("Arquivadas 1 · Mais abas");
    // Nenhuma aba da faixa finge estar aberta.
    expect(screen.getAllByRole("tab").filter((el) => el.getAttribute("aria-selected") === "true")).toHaveLength(0);
  });
});

describe("preferência não é permissão", () => {
  it("atendente sem 'Todas' não a recebe da preferência, nem na faixa nem no menu", async () => {
    const user = userEvent.setup({ delay: null });
    h.activeOrg = { orgId: "org-1", name: "Org", role: "agent", visibility_mode: "own" };
    const pref = normalizarAbas([
      { id: "all", visivel: true },
      { id: "pessoal", visivel: false },
      { id: "closed", visivel: false },
    ]);
    render(<InboxFilters value={VALUE} onChange={() => {}} abasIniciais={pref} />);

    expect(faixa()).not.toContain("Todas");
    expect(faixa()).not.toContain("Pessoal");

    await user.click(menu());
    const ocultas = screen.getAllByRole("menuitemradio").map((el) => (el.textContent ?? "").replace(/\d+$/, "").trim());
    expect(ocultas).toEqual(["Fechadas"]);
  });
});

describe("o diálogo organiza e grava", () => {
  async function abrirDialogo(user: ReturnType<typeof userEvent.setup>) {
    await user.click(menu());
    await user.click(screen.getByRole("menuitem", { name: "Personalizar abas…" }));
    return screen.getByRole("dialog", { name: "Personalizar abas" });
  }

  it("subir uma aba e ocultar outra: grava a lista inteira e a faixa acompanha", async () => {
    const user = userEvent.setup({ delay: null });
    render(<InboxFilters value={VALUE} onChange={() => {}} />);

    const dialogo = await abrirDialogo(user);
    await user.click(within(dialogo).getByRole("button", { name: "Mover para cima · Fila" }));
    await user.click(within(dialogo).getByRole("switch", { name: "Mostrar aba · Arquivadas" }));
    await user.click(within(dialogo).getByRole("button", { name: "Salvar" }));

    expect(h.salvar).toHaveBeenCalledTimes(1);
    const enviado = h.salvar.mock.calls[0]![0] as AbaDaPessoa[];
    expect(enviado.map((a) => a.id)).toEqual(["unassigned", "ai", "mine", "all", "closed", "archived", "pessoal"]);
    expect(enviado.find((a) => a.id === "archived")).toEqual({ id: "archived", visivel: false });

    expect(faixa()).toEqual(["Fila", "Automático", "Minhas", "Todas", "Fechadas", "Pessoal"]);
    expect(menu()).toHaveTextContent("Mais");
  });

  it("o diálogo do atendente mostra só as abas dele e devolve as outras intactas", async () => {
    const user = userEvent.setup({ delay: null });
    h.activeOrg = { orgId: "org-1", name: "Org", role: "agent", visibility_mode: "own" };
    const pref = normalizarAbas([{ id: "all", visivel: false }]);
    render(<InboxFilters value={VALUE} onChange={() => {}} abasIniciais={pref} />);

    const dialogo = await abrirDialogo(user);
    expect(within(dialogo).queryByText("Todas")).toBeNull();
    expect(within(dialogo).queryByText("Pessoal")).toBeNull();
    await user.click(within(dialogo).getByRole("button", { name: "Salvar" }));

    const enviado = h.salvar.mock.calls[0]![0] as AbaDaPessoa[];
    expect(enviado.find((a) => a.id === "all")).toEqual({ id: "all", visivel: false });
  });

  it("a última aba visível não pode ser ocultada", async () => {
    const user = userEvent.setup({ delay: null });
    const soMinhas = normalizarAbas(
      ["mine", "ai", "unassigned", "all", "closed", "archived", "pessoal"].map((id) => ({ id, visivel: id === "mine" })),
    );
    render(<InboxFilters value={VALUE} onChange={() => {}} abasIniciais={soMinhas} />);

    const dialogo = await abrirDialogo(user);
    const travada = within(dialogo).getByRole("switch", { name: "Mostrar aba · Minhas" });
    expect(travada).toBeDisabled();
    // O porquê da trava chega ao leitor de tela, não só "indisponível".
    expect(travada).toHaveAccessibleDescription("Pelo menos uma aba precisa ficar visível.");
    const livre = within(dialogo).getByRole("switch", { name: "Mostrar aba · Fila" });
    expect(livre).toBeEnabled();
    expect(livre).not.toHaveAccessibleDescription();
  });

  it("Cancelar não grava nem muda a faixa", async () => {
    const user = userEvent.setup({ delay: null });
    render(<InboxFilters value={VALUE} onChange={() => {}} />);

    const dialogo = await abrirDialogo(user);
    await user.click(within(dialogo).getByRole("switch", { name: "Mostrar aba · Fila" }));
    await user.click(within(dialogo).getByRole("button", { name: "Cancelar" }));

    expect(h.salvar).not.toHaveBeenCalled();
    expect(faixa()).toContain("Fila");
  });

  it("recusa do servidor avisa, deixa o diálogo aberto e não muda a faixa", async () => {
    const user = userEvent.setup({ delay: null });
    h.salvar.mockResolvedValue({ ok: false, erro: "falha" });
    render(<InboxFilters value={VALUE} onChange={() => {}} />);

    const dialogo = await abrirDialogo(user);
    await user.click(within(dialogo).getByRole("switch", { name: "Mostrar aba · Fila" }));
    await user.click(within(dialogo).getByRole("button", { name: "Salvar" }));

    expect(h.salvar).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Não foi possível salvar as abas. Tente novamente.");
    // O diálogo fica para a pessoa tentar de novo, com a escolha dela intacta.
    expect(screen.getByRole("dialog", { name: "Personalizar abas" })).toBeInTheDocument();
    expect(within(dialogo).getByRole("switch", { name: "Mostrar aba · Fila" })).not.toBeChecked();

    await user.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    expect(faixa()).toContain("Fila");
  });
});
