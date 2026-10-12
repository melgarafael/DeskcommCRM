/**
 * CATRACA — as 6 abas da Inbox não podem voltar a ser cortadas na coluna (#2745).
 *
 * ## O defeito, medido
 *
 * A faixa de abas do Inbox é `overflow-x-auto` com gatilhos `shrink-0` e
 * `whitespace-nowrap`: rótulo não encolhe, então quando as seis não cabem na
 * coluna a faixa ROLA — e quem está na ponta direita fica atrás da seta. Em
 * browser real, com o CSS do produto compilado e a fonte verdadeira, medido
 * contra a largura da coluna (`tests/sonda-abas-inbox-1280.test.tsx`):
 *
 *   coluna 272px (padrão da faixa `xl`, janela de 1280) → rolava 191px
 *   coluna 380px → rolava  83px  ("Fechadas" cortada)
 *   coluna 450px → rolava  13px  ("Arquivadas" atrás da seta)
 *
 * 272px é o padrão do Inbox em 1280px de janela (`LIMITES_LISTA` e
 * `largurasPadrao`, em `lib/inbox/larguras-do-inbox.ts`: a coluna da lista é
 * arrastável entre 240 e 520). Ou seja: na resolução comum, três das seis
 * abas só existiam para quem rolava a faixa no escuro.
 *
 * ## Por que este teste é o que é (e o que ele NÃO é)
 *
 * Este teste olha CLASSE, não pixel — e isso é limitação declarada, não
 * descuido: largura de rótulo e quebra de flex são cálculo de layout, e o
 * jsdom não tem engine de layout. Medir largura aqui devolveria zero em tudo
 * e passaria feliz: verde por ausência de motor, o pior falso verde que
 * existe. A medição de verdade é a sonda acima, que roda em Chromium e afere
 * as seis larguras da faixa de arraste.
 *
 * Esta catraca existe porque aquela sonda NÃO roda no CI (precisa de browser e
 * compila o Tailwind inteiro), e a regressão específica — alguém tirar
 * `flex-wrap` da faixa "para voltar ao visual de uma linha só" — é textual e
 * barata de pegar. O segundo bloco vigia o outro lado do mesmo defeito: a
 * saída fácil seria encurtar rótulo ou tirar aba, e "Automático" é contrato
 * (comentário em `InboxFilters.tsx`) — a largura não se paga mudando o
 * significado do filtro.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  InboxFilters,
  visibleInboxTabs,
  type InboxFiltersValue,
} from "@/components/inbox/InboxFilters";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    activeOrg: { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" },
  }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  channelLabel: (c: { display_name: string }) => c.display_name,
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
// Contagens de 2 dígitos, como numa instalação viva: elas ALARGAM a aba, e é
// com elas que o corte foi medido.
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({
    data: { fila: 47, automatico: 12, mine: 8, all: 130, closed: 25, archived: 9 },
  }),
}));

const VALUE: InboxFiltersValue = { tab: "ai", search: "", onlyUnread: false };

afterEach(cleanup);

function faixa(): HTMLElement {
  const list = screen.getByRole("tablist");
  expect(list, "a faixa de abas não renderizou").toBeTruthy();
  return list;
}

describe("faixa da Inbox — quebra em vez de esconder aba (#2745)", () => {
  it("a faixa tem `flex-wrap` — sem ele ela ROLA e a ponta direita fica atrás da seta", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    // A regressão que esta catraca existe para pegar: `flex-wrap` removido
    // devolve o corte medido — 191px de rolagem na coluna de 272px, com
    // "Fechadas" cortada e "Arquivadas" escondida.
    expect(
      faixa().className.split(/\s+/),
      "`flex-wrap` sumiu da faixa: as abas voltam a rolar para fora da coluna em 1280px (#2745)",
    ).toContain("flex-wrap");
  });

  it("`gap-x-1` acompanha — é o que deixa 272px em 2 linhas em vez de 3", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    // Sem a folga de 4px, a coluna de 272px (o PADRÃO em 1280) quebra em 3
    // linhas / 106px; com ela, 2 linhas / 68px. Medido na sonda.
    expect(
      faixa().className.split(/\s+/),
      "`gap-x-1` sumiu: a faixa padrão em 1280px ganha uma terceira linha de abas (#2745)",
    ).toContain("gap-x-1");
  });

  it("as SEIS abas estão na faixa, com os rótulos inteiros", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    // Guarda de vacuidade do caso acima e defesa do outro lado do defeito:
    // a saída fácil para \"não cabe\" é encurtar rótulo ou tirar aba, e aí a
    // catraca de classe continua verde com a tela errada.
    const abas = screen.getAllByRole("tab");
    expect(abas).toHaveLength(6);
    for (const rotulo of ["Automático", "Fila", "Minhas", "Todas", "Fechadas", "Arquivadas"]) {
      expect(
        screen.getByRole("tab", { name: new RegExp(rotulo) }),
        `a aba "${rotulo}" não está na faixa`,
      ).toBeInTheDocument();
    }
  });

  it("quebrar a linha não muda o FILTRO: clicar em Arquivadas manda tab=archived", () => {
    const onChange = vi.fn();
    render(<InboxFilters value={VALUE} onChange={onChange} />);
    // A quebra é de layout; o valor continua o MESMO contrato de antes.
    // O Radix `TabsTrigger` aciona no `mousedown`, não no `click`.
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Arquivadas/ }));
    expect(onChange).toHaveBeenCalledWith({ ...VALUE, tab: "archived" });
  });

  it("a ordem e os valores das abas não mudaram (#2498)", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    // `visibleInboxTabs` é a fonte da ORDEM do trabalho; a largura não se paga
    // reordenando nem renomeando.
    expect(visibleInboxTabs("manager", "all")).toEqual([
      "ai",
      "unassigned",
      "mine",
      "all",
      "closed",
      "archived",
    ]);
    expect(screen.getAllByRole("tab").map((a) => a.textContent?.replace(/\s+/g, ""))).toEqual([
      "Automático12",
      "Fila47",
      "Minhas8",
      "Todas130",
      "Fechadas25",
      "Arquivadas9",
    ]);
  });
});
