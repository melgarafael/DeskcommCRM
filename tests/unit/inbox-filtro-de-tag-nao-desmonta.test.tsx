/**
 * O SELETOR DE ETIQUETA NÃO PODE SUMIR DEBAIXO DO MENU ABERTO.
 *
 * `mostrarSeletorDeTag` decidia a EXISTÊNCIA do `<Select>` a partir de duas
 * queries em voo (`useConversationTagVocabulary` e `useContactTagVocabulary`,
 * ambas com `orgId` na chave e `enabled: !!orgId`). Um único render em que o
 * vocabulário volte a indefinido — chave nova, refetch, organização piscando —
 * não escondia apenas o controle: DESMONTAVA o Select, e o menu que o operador
 * tinha acabado de abrir fechava sozinho, com o gatilho de volta em "Todas as
 * tags". Pela tela é o filtro fechando na cara de quem ia escolher; no CI era o
 * `tests/e2e/filtro-por-marcador-pela-tela.spec.ts` intermitente, com o clique
 * na opção estourando ~380 ms depois de ela ter passado na asserção.
 *
 * O controle negativo é o quadro: `components/kanban/FilterBar.tsx` mantém o
 * gatilho de etiqueta SEMPRE montado (`disabled` quando não há opção) e nunca
 * teve o defeito, no mesmo spec e com o mesmo screenshot entre abrir e clicar.
 *
 * Os dois últimos casos são a não-regressão do que a condicional protegia: quem
 * nunca teve etiqueta continua sem o seletor, e o filtro órfão continua com a
 * sua válvula.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";
import type { ActiveOrg } from "@/lib/auth/types";

const activeOrgRef: { current: ActiveOrg | null } = { current: null };
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => ({ data: [] as ChannelSession[] }) };
});
/** `undefined` = vocabulário em voo (ou chave nova) — não é "zero etiquetas". */
const tagsRef: { current: string[] | undefined } = { current: undefined };
const tagsDoContatoRef: { current: string[] | undefined } = { current: undefined };
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: tagsRef.current }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: tagsDoContatoRef.current }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { fila: 3, mine: 2, all: 5 } }),
}));

const VALUE: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };
const GATILHO = "Filtrar por tag";

/**
 * ⚠️ O GATILHO DEIXOU DE SER UM `Select` (#1274) — e com ele mudou o PAPEL que a
 * tela de reading usa.
 *
 * O `Select` do Radix é `role="combobox"` e as opções dele são `role="option"`.
 * O `DropdownMenu` é `role="menu"` com `role="menuitemcheckbox"`, porque é
 * multi-seleção: o item MARCA e NÃO fecha, que é o defeito que o `Select`
 * tinha (a segunda escolha exigiria reabrir o menu).
 *
 * O que este arquivo continua vigando é o defeito, não o elemento: com o menu
 * ABERTO, uma oscilação do vocabulário não pode DESMONTAR o gatilho. Por isso
 * a busca é por NOME ACESSÍVEL (`Filtrar por tag`), que o botão continua tendo
 * — o rótulo não mudou, e mudar o rótulo quebraria quem procura o controle
 * (e a tradução no dicionário).
 */
const gatilho = (comMenuAberto = false) =>
  screen.queryByRole("button", { name: GATILHO, ...(comMenuAberto ? { hidden: true } : {}) });

beforeEach(() => {
  // Radix Select em jsdom: o gatilho usa captura de ponteiro e o conteúdo rola
  // até o item — nenhum dos dois existe aqui.
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  activeOrgRef.current = { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" };
  tagsRef.current = ["retorno"];
  tagsDoContatoRef.current = ["vip"];
});
afterEach(cleanup);

async function abreOMenu() {
  // `delay: null` porque o padrão do user-event espera de verdade entre os
  // eventos de ponteiro, e sob a suíte inteira em paralelo essa espera estoura
  // os 15 s do vitest — o arquivo passa sozinho e cai no conjunto, que é o
  // vermelho que não ensina nada.
  const user = userEvent.setup({ delay: null });
  const tela = render(<InboxFilters value={VALUE} onChange={() => {}} />);
  await user.click(screen.getByRole("button", { name: GATILHO }));
  expect(screen.getByRole("menuitemcheckbox", { name: /vip/ })).toBeInTheDocument();
  expect(screen.getByRole("menuitemcheckbox", { name: /retorno/ })).toBeInTheDocument();
  return tela;
}

describe("o menu de etiqueta aberto sobrevive à oscilação do vocabulário", () => {
  it("vocabulário voltando a INDEFINIDO não derruba o menu", async () => {
    const { rerender } = await abreOMenu();

    tagsRef.current = undefined;
    tagsDoContatoRef.current = undefined;
    rerender(<InboxFilters value={VALUE} onChange={() => {}} />);

    // Com o menu aberto o Radix marca o resto da árvore com `aria-hidden`, e é
    // por `hidden: true` que o gatilho é alcançável — o que se afirma aqui é que
    // ele não DESMONTOU, não que esteja exposto à leitura de tela.
    // Com o menu aberto o Radix marca o resto da árvore com `aria-hidden`, e é
    // por isso que se procura o gatilho com `hidden: true`: o que se afirma aqui
    // é que ele não DESMONTOU, e não que esteja exposto à leitura de tela.
    expect(gatilho(true)).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /vip/ })).toBeInTheDocument();
  });

  it("vocabulário voltando VAZIO por um render não derruba o menu", async () => {
    const { rerender } = await abreOMenu();

    tagsRef.current = [];
    tagsDoContatoRef.current = [];
    rerender(<InboxFilters value={VALUE} onChange={() => {}} />);

    // Com o menu aberto o Radix marca o resto da árvore com `aria-hidden`, e é
    // por `hidden: true` que o gatilho é alcançável — o que se afirma aqui é que
    // ele não DESMONTOU, não que esteja exposto à leitura de tela.
    // Com o menu aberto o Radix marca o resto da árvore com `aria-hidden`, e é
    // por isso que se procura o gatilho com `hidden: true`: o que se afirma aqui
    // é que ele não DESMONTOU, e não que esteja exposto à leitura de tela.
    expect(gatilho(true)).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /vip/ })).toBeInTheDocument();
  });
});

describe("não-regressão: o que a condicional protegia", () => {
  it("organização que nunca teve etiqueta não ganha um seletor morto", () => {
    tagsRef.current = [];
    tagsDoContatoRef.current = [];
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(gatilho()).not.toBeInTheDocument();
  });

  it("vocabulário em voo, sem nada conhecido ainda: gatilho em carregamento", () => {
    // #1336 mudou o que este caso guarda. Antes, "ainda não sei" era tratado
    // como "não tenho nada" e o gatilho NÃO nascia — era a piscada: o controle
    // aparecia quando o dado chegava. Agora o estado (a) é dito na tela desde o
    // primeiro render (e o menu diz que está carregando). O que continua
    // proibido é inventar opção — ver `inbox-filtro-de-tag-tres-estados`.
    tagsRef.current = undefined;
    tagsDoContatoRef.current = undefined;
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(gatilho()).toBeInTheDocument();
  });

  it("filtro órfão mantém a válvula: o seletor aparece com a etiqueta que sumiu do vocabulário", () => {
    tagsRef.current = ["retorno"];
    tagsDoContatoRef.current = [];
    render(<InboxFilters value={{ ...VALUE, tag: "apagada" }} onChange={() => {}} />);
    expect(gatilho()).toBeInTheDocument();
  });

  it("filtro órfão de DUAS etiquetas também mantém a válvula (#1274)", () => {
    // Com VÁRIAS etiquetas, "está no vocabulário" deixa de ser uma pergunta de
    // sim/não: basta UMA das escolhidas ter sumido para o operador precisar da
    // válvula. Sem este caso, uma combinação com uma etiqueta apagada ficaria sem
    // forma de ser desfeita — o pior dos dois: filtro ativo sem como tirá-lo.
    tagsRef.current = ["retorno"];
    tagsDoContatoRef.current = [];
    render(
      <InboxFilters value={{ ...VALUE, tag: ["retorno", "apagada"] }} onChange={() => {}} />,
    );
    expect(gatilho()).toBeInTheDocument();
  });
});

describe("o modo E/OU marca só o modo ativo (#1274)", () => {
  // O ✓ manual usava a MESMA condição (`tagMode === "ou"`) nos dois itens: com OU
  // os dois apareciam marcados, com E nenhum. O rádio marca um só e expõe
  // `aria-checked`, que é o que este caso mede.
  async function abreComDuas(tagMode?: "ou") {
    const user = userEvent.setup({ delay: null });
    render(
      <InboxFilters value={{ ...VALUE, tag: ["vip", "retorno"], tagMode }} onChange={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: GATILHO }));
    return {
      e: screen.getByRole("menuitemradio", { name: "Todas (E)" }),
      ou: screen.getByRole("menuitemradio", { name: "Qualquer uma (OU)" }),
    };
  }

  it("com OU ativo, só o OU está marcado", async () => {
    const { e, ou } = await abreComDuas("ou");
    expect(ou).toHaveAttribute("aria-checked", "true");
    expect(e).toHaveAttribute("aria-checked", "false");
  });

  it("sem modo (E, o padrão), só o E está marcado", async () => {
    const { e, ou } = await abreComDuas();
    expect(e).toHaveAttribute("aria-checked", "true");
    expect(ou).toHaveAttribute("aria-checked", "false");
  });
});
