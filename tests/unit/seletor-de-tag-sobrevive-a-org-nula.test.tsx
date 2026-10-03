/**
 * O SELETOR DE ETIQUETA SOBREVIVE AO VOCABULÁRIO VOLTANDO A `undefined` (#1336),
 * COM DUBLÊS QUE RESPEITAM O `orgId` DOS HOOKS.
 *
 * O gatilho só existe enquanto `mostrarSeletorDeTag` for verdadeiro, e as DUAS
 * pernas dessa condição passaram a depender do vocabulário lembrado
 * (`vocabularioDoSeletor` + `vocabularioConhecido`), não do vocabulário em voo.
 *
 * Os dois hooks de vocabulário têm `enabled: !!orgId` e `queryKey` com o orgId
 * dentro. Os dublês abaixo reproduzem essa semântica: sem orgId, `data` é
 * `undefined`, o mesmo que o react-query devolve para consulta desabilitada ou
 * para chave nova ainda sem dado. Aqui a org nula é só o jeito de levar os DOIS
 * hooks a `undefined`. Em produção, `activeOrg` nulo troca a `key` do
 * `<Providers>` (hooks/auth/AuthProvider.tsx) e remonta a árvore, e o seletor
 * some junto com ela; a oscilação que este arquivo guarda é o vocabulário indo
 * a `undefined` SEM a org mudar (#1336, frente (a), gatilho ainda sem nome).
 *
 * O ganho sobre o irmão `inbox-filtro-de-tag-nao-desmonta`, que mocka os hooks
 * SEM olhar o `orgId`: o caso 1 reprova se o componente deixar de passar a org
 * aos hooks, e o caso 3 guarda a metade `ultimoVocabulario.length > 0` de
 * `vocabularioConhecido` — sem ela, a etiqueta órfã de um filtro aplicado some
 * do menu durante a oscilação, e não há como desmarcá-la.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ActiveOrg } from "@/lib/auth/types";

const activeOrgRef: { current: ActiveOrg | null } = { current: null };
const tagsRef: { current: string[] } = { current: [] };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => ({ data: [] }) };
});
/** Sem orgId (`enabled: !!orgId`) o hook devolve `data: undefined`. */
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: (orgId: string | null) => ({
    data: orgId ? tagsRef.current : undefined,
  }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: (orgId: string | null) => ({
    data: orgId ? tagsRef.current : undefined,
  }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { unassigned: 1 } }),
}));

const GATILHO = "Filtrar por tag";
/** O gatilho deixou de ser um `Select` (#1274): é botão com `aria-label`. */
const gatilho = () => screen.queryByLabelText(GATILHO);
const base: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };

beforeEach(() => {
  // Radix em jsdom: captura de ponteiro e rolagem até o item não existem aqui.
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  activeOrgRef.current = {
    orgId: "org-1",
    name: "Org",
    role: "manager",
    visibility_mode: "all",
  };
  tagsRef.current = ["urgente", "vip"];
});
afterEach(cleanup);

describe("seletor de etiqueta x vocabulário voltando a undefined (dublês que respeitam orgId)", () => {
  it("com org resolvida, o seletor está na tela", () => {
    render(<InboxFilters value={base} onChange={() => {}} />);
    expect(gatilho()).not.toBeNull();
  });

  it("vocabulário indefinido (org nula no dublê): o seletor permanece", () => {
    const { rerender } = render(<InboxFilters value={base} onChange={() => {}} />);
    expect(gatilho()).not.toBeNull();

    activeOrgRef.current = null;
    rerender(<InboxFilters value={{ ...base }} onChange={() => {}} />);

    expect(gatilho()).not.toBeNull();
  });

  it("com filtro de etiqueta ÓRFÃ aplicado e vocabulário indefinido, a órfã continua no menu (dá para desfazer)", async () => {
    // "apagada" está fora do último vocabulário (["urgente", "vip"]): o seletor
    // fica pela primeira perna de qualquer jeito, mas a opção órfã só entra no
    // menu enquanto o vocabulário é "conhecido". Com o vocabulário em
    // `undefined`, quem o mantém conhecido é o `ultimoVocabulario`.
    const comFiltro: InboxFiltersValue = { ...base, tag: "apagada" };
    const { rerender } = render(<InboxFilters value={comFiltro} onChange={() => {}} />);

    activeOrgRef.current = null;
    rerender(<InboxFilters value={{ ...comFiltro }} onChange={() => {}} />);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: GATILHO }));
    expect(screen.getByRole("menuitemcheckbox", { name: /apagada/ })).toBeInTheDocument();
  });
});
