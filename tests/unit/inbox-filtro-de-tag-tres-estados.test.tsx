/**
 * OS TRÊS ESTADOS DO VOCABULÁRIO DE ETIQUETA (#1336).
 *
 * O seletor do Inbox tratava `undefined` e `[]` como a mesma coisa: "não há o
 * que oferecer". São coisas diferentes, e a diferença é a issue inteira:
 *
 *   (a) AINDA NÃO SEI — a organização não chegou (`activeOrg` nulo) ou as duas
 *       consultas ainda estão em voo. `data` é `undefined`.
 *   (b) SEI, E ESTÁ VAZIO — a organização não tem etiqueta nenhuma. `data` é `[]`.
 *   (c) SEI, E TEM ITENS — o seletor de sempre.
 *
 * No estado (a) o gatilho tem de continuar na tela (dizendo que está
 * carregando); no (b), só quando há filtro aplicado (é a válvula para
 * desfazer); no (c), sempre. O que não pode, em NENHUM deles, é a etiqueta
 * aplicada ficar sem controle na tela — a lista presa num subconjunto, às vezes
 * vazio, e nada para desfazer.
 *
 * O caminho que faltava: a PRIMEIRA renderização com `?tag=` na URL (deep-link
 * do relatório Por etiqueta, `components/inbox/InboxLayout.tsx:311-321`) ou
 * logo depois de uma remontagem. Ali o vocabulário nunca foi conhecido, então
 * não havia "último vocabulário" para segurar o controle: `mostrarSeletorDeTag`
 * era `false` e o filtro aplicado não tinha como ser desfeito.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ActiveOrg } from "@/lib/auth/types";

const activeOrgRef: { current: ActiveOrg | null } = { current: null };
/** `undefined` = consulta em voo (ou desabilitada por `enabled: !!orgId`). */
const tagsRef: { current: string[] | undefined } = { current: undefined };
const tagsDoContatoRef: { current: string[] | undefined } = { current: undefined };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => ({ data: [] }) };
});
/** Dublês que RESPEITAM `enabled: !!orgId`, como os hooks de verdade. */
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: (orgId: string | null) => ({
    data: orgId ? tagsRef.current : undefined,
  }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: (orgId: string | null) => ({
    data: orgId ? tagsDoContatoRef.current : undefined,
  }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { fila: 1 } }),
}));

const GATILHO = "Filtrar por tag";
const gatilho = () => screen.queryByLabelText(GATILHO);
const base: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };

beforeEach(() => {
  // Radix em jsdom: captura de ponteiro e rolagem até o item não existem aqui.
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  activeOrgRef.current = null;
  tagsRef.current = undefined;
  tagsDoContatoRef.current = undefined;
});
afterEach(cleanup);

async function abreOMenu() {
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("button", { name: GATILHO }));
  return user;
}

describe("(a) ainda não sei — org nula / consultas em voo", () => {
  it("com filtro aplicado: o gatilho está na tela, mostra a etiqueta e limpa", async () => {
    const onChange = vi.fn();
    render(<InboxFilters value={{ ...base, tag: "vip" }} onChange={onChange} />);

    // O gatilho existe E diz qual filtro está valendo — não é um botão mudo.
    const botao = gatilho();
    expect(botao).not.toBeNull();
    expect(botao!.textContent).toContain("vip");

    const user = await abreOMenu();
    // Enquanto não sei, o menu diz que está carregando em vez de fingir lista.
    expect(screen.getByText("Carregando etiquetas…")).toBeInTheDocument();
    // E a etiqueta aplicada continua desmarcável no próprio menu.
    const opcao = screen.getByRole("menuitemcheckbox", { name: /vip/ });
    expect(opcao).toHaveAttribute("aria-checked", "true");
    await user.click(opcao);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tag: undefined, tagMode: undefined }),
    );
  });

  it('com filtro aplicado: o item "Todas as tags" também desfaz o filtro', async () => {
    const onChange = vi.fn();
    render(<InboxFilters value={{ ...base, tag: "vip" }} onChange={onChange} />);
    const user = await abreOMenu();
    await user.click(screen.getByRole("menuitem", { name: "Todas as tags" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tag: undefined, tagMode: undefined }),
    );
  });

  it("sem filtro: a barra não quebra e o gatilho anuncia o carregamento", async () => {
    render(<InboxFilters value={base} onChange={() => {}} />);
    // A busca do topo continua na tela — a barra inteira não depende do vocabulário.
    expect(screen.getByLabelText("Buscar conversas")).toBeInTheDocument();
    expect(gatilho()).not.toBeNull();

    await abreOMenu();
    expect(screen.getByText("Carregando etiquetas…")).toBeInTheDocument();
    expect(screen.queryAllByRole("menuitemcheckbox")).toHaveLength(0);
  });

  it("org resolvida mas as duas consultas ainda em voo: mesmo estado, mesmo gatilho", () => {
    activeOrgRef.current = {
      orgId: "org-1",
      name: "Org",
      role: "manager",
      visibility_mode: "all",
    };
    render(<InboxFilters value={{ ...base, tag: "vip" }} onChange={() => {}} />);
    expect(gatilho()).not.toBeNull();
  });
});

describe("(b) sei, e está vazio", () => {
  it("sem filtro: continua sem seletor, como hoje", () => {
    activeOrgRef.current = {
      orgId: "org-1",
      name: "Org",
      role: "manager",
      visibility_mode: "all",
    };
    tagsRef.current = [];
    tagsDoContatoRef.current = [];
    render(<InboxFilters value={base} onChange={() => {}} />);
    expect(gatilho()).toBeNull();
  });

  it("com filtro aplicado: o gatilho fica, com a etiqueta visível e desfazível", async () => {
    activeOrgRef.current = {
      orgId: "org-1",
      name: "Org",
      role: "manager",
      visibility_mode: "all",
    };
    tagsRef.current = [];
    tagsDoContatoRef.current = [];
    const onChange = vi.fn();
    render(<InboxFilters value={{ ...base, tag: "apagada" }} onChange={onChange} />);

    expect(gatilho()!.textContent).toContain("apagada");
    const user = await abreOMenu();
    // Sem "Carregando": o vocabulário é conhecido (e vazio) — a etiqueta é órfã.
    expect(screen.queryByText("Carregando etiquetas…")).toBeNull();
    await user.click(screen.getByRole("menuitemcheckbox", { name: /apagada/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tag: undefined }));
  });
});

describe("(c) sei, e tem itens", () => {
  it("o seletor aparece com as opções das duas caixas", async () => {
    activeOrgRef.current = {
      orgId: "org-1",
      name: "Org",
      role: "manager",
      visibility_mode: "all",
    };
    tagsRef.current = ["retorno"];
    tagsDoContatoRef.current = ["vip"];
    render(<InboxFilters value={base} onChange={() => {}} />);

    expect(gatilho()).not.toBeNull();
    await abreOMenu();
    expect(screen.queryByText("Carregando etiquetas…")).toBeNull();
    expect(screen.getByRole("menuitemcheckbox", { name: /retorno/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /vip/ })).toBeInTheDocument();
  });
});

describe("o menu aberto sobrevive a re-render do pai", () => {
  it("re-render com value/onChange novos NÃO fecha o menu", async () => {
    activeOrgRef.current = {
      orgId: "org-1",
      name: "Org",
      role: "manager",
      visibility_mode: "all",
    };
    tagsRef.current = ["vip"];
    tagsDoContatoRef.current = [];
    const { rerender } = render(<InboxFilters value={base} onChange={() => {}} />);
    await abreOMenu();
    expect(screen.getByRole("menuitemcheckbox", { name: /vip/ })).toBeInTheDocument();

    // Um re-render do pai: objeto novo de filtros e callback novo, como
    // `InboxLayout` faz a cada mudança de estado.
    rerender(<InboxFilters value={{ ...base }} onChange={() => {}} />);

    expect(screen.getByRole("menuitemcheckbox", { name: /vip/ })).toBeInTheDocument();
  });

  it("o filtro virando vazio com o menu aberto NÃO arranca o menu da tela", async () => {
    activeOrgRef.current = {
      orgId: "org-1",
      name: "Org",
      role: "manager",
      visibility_mode: "all",
    };
    tagsRef.current = ["vip"];
    tagsDoContatoRef.current = [];
    const { rerender } = render(<InboxFilters value={base} onChange={() => {}} />);
    await abreOMenu();

    // A organização ficou sem etiqueta nenhuma com o menu aberto (a última foi
    // apagada). Sem o filtro aplicado, o estado (b) esconde o gatilho — mas não
    // pode destruir, debaixo do dedo, um menu que está aberto.
    tagsRef.current = [];
    tagsDoContatoRef.current = [];
    rerender(<InboxFilters value={{ ...base }} onChange={() => {}} />);

    expect(screen.getByRole("menuitem", { name: "Todas as tags" })).toBeInTheDocument();
  });
});
