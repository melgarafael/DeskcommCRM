/**
 * A ORDEM DAS ABAS DO INBOX — só a ordem muda (#2498).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * "Automático" ficava FORA da faixa, no fim dela, depois de "Arquivadas" — o
 * valor que o operador mais olha era o último, atrás de dois passados. A ordem
 * pedida pela issue é a do trabalho: primeiro o que o robô conduz, depois a
 * fila de quem precisa de gente, depois o histórico.
 *
 * ─── O que este arquivo trava ──────────────────────────────────────────────
 *
 * A ordem NOVA renderizada na tela, e nada além dela. Os controles ao redor
 * são o que torna a troca inofensiva, e cada um vira caso próprio porque cada
 * um teria um sintoma silencioso se sumisse:
 *
 *   - rótulos e `value` — um valor novo nasceria `?filter=` que a rota não lê;
 *   - permissões (`visibleInboxTabs`) — reordenar filtrando de novo esconderia
 *     "Todas" de quem tem direito a vê-la;
 *   - contadores — o badge lê `counts` por CHAVE (`fila`, `automatico`, …), e
 *     a ordem nova não muda quem conta o quê;
 *   - as sete na mesma quantidade — uma aba perdida na remontagem do array não
 *     quebra nada visível para quem já estava na primeira.
 */
import { readFileSync } from "node:fs";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboxFilters, visibleInboxTabs, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type { ActiveOrg } from "@/lib/auth/types";

const activeOrgRef: { current: ActiveOrg | null } = { current: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
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
// Uma contagem POR ABA, para o caso de contadores poder acusar uma troca de
// chave: `automatico` é a da "Automático", `fila` é a da "Fila".
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({
    data: { fila: 3, mine: 2, all: 5, automatico: 7, closed: 4, archived: 1, pessoal: 6 },
  }),
}));

const VALUE: InboxFiltersValue = { tab: "ai", search: "", onlyUnread: false };

/** O rótulo de cada aba, sem o contador que vem colado no `textContent`. */
function abasRenderizadas(): string[] {
  return screen
    .getAllByRole("tab")
    .map((el) => (el.textContent ?? "").replace(/\d+$/, "").trim());
}

beforeEach(() => {
  activeOrgRef.current = { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" };
});
afterEach(cleanup);

describe("as sete abas, na ordem pedida pela #2498", () => {
  it("Automático, Fila, Minhas, Todas, Fechadas, Arquivadas, Pessoal — nessa ordem", () => {
    // A sétima é da #4434 e fecha a faixa de propósito (é o único lugar da tela
    // que não é trabalho). As seis da #2498 continuam na MESMA ordem relativa:
    // a aba nova entrou no fim, não no meio.
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(abasRenderizadas()).toEqual([
      "Automático",
      "Fila",
      "Minhas",
      "Todas",
      "Fechadas",
      "Arquivadas",
      "Pessoal",
    ]);
  });

  it("os VALUES e os rótulos são os MESMOS de antes, mais a aba Pessoal no fim", () => {
    // Pares lidos da FONTE, e não da tela: `value` é o que a rota recebe
    // (`?filter=ai`) e nenhum deles é exposto como atributo no `TabsTrigger`.
    // Um par trocado de rótulo nasceria um filtro que a rota não lê, e um par
    // a mais nasceria uma aba que ninguém tem contador — por isso os 6, um por
    // um, na ordem nova.
    const fonte = readFileSync("components/inbox/InboxFilters.tsx", "utf8");
    const pares = [...fonte.matchAll(/\{\s*value:\s*"(\w+)",\s*label:\s*"([^"]+)"\s*\}/g)].map(
      ([, value, label]) => `${value}=${label}`,
    );
    expect(pares).toEqual([
      "ai=Automático",
      "unassigned=Fila",
      "mine=Minhas",
      "all=Todas",
      "closed=Fechadas",
      "archived=Arquivadas",
      "pessoal=Pessoal",
    ]);
  });

  it("cada aba continua com o SEU contador (nada trocou de chave)", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /^Automático/ })).toHaveTextContent("7");
    expect(screen.getByRole("tab", { name: /^Fila/ })).toHaveTextContent("3");
    expect(screen.getByRole("tab", { name: /^Minhas/ })).toHaveTextContent("2");
    expect(screen.getByRole("tab", { name: /^Todas/ })).toHaveTextContent("5");
    expect(screen.getByRole("tab", { name: /^Fechadas/ })).toHaveTextContent("4");
    expect(screen.getByRole("tab", { name: /^Arquivadas/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /^Pessoal/ })).toHaveTextContent("6");
  });
});

describe("só a ordem muda — as permissões continuam quem eram", () => {
  it("manager vê as sete, com 'Todas' no meio e 'Pessoal' no fim", () => {
    expect(visibleInboxTabs("manager", "all")).toEqual([
      "ai",
      "unassigned",
      "mine",
      "all",
      "closed",
      "archived",
      "pessoal",
    ]);
  });

  it("agent em modo own* segue SEM 'Todas' — e com as outras cinco na ordem nova", () => {
    // A regra de visão é filtrar, não reordenar: quem perde 'all' perde só ela,
    // e a ordem que sobra é a mesma que todo mundo vê.
    expect(visibleInboxTabs("agent", "own")).toEqual([
      "ai",
      "unassigned",
      "mine",
      "closed",
      "archived",
    ]);
  });

  it("agent com visibility 'all' tem as seis, 'Todas' na posição dela", () => {
    expect(visibleInboxTabs("agent", "all")).toEqual([
      "ai",
      "unassigned",
      "mine",
      "all",
      "closed",
      "archived",
    ]);
  });

  it("a aba ativa continua podendo ser QUALQUER uma das sete", () => {
    // A faixa é navegável por seta (`moveTab` anda pelo array): uma ordem nova
    // que embaralhasse os índices devolveria o operador à vizinha errada.
    render(<InboxFilters value={{ ...VALUE, tab: "closed" }} onChange={() => {}} />);
    const ativa = screen.getByRole("tab", { selected: true });
    expect(ativa.textContent ?? "").toMatch(/^Fechadas/);
  });
});
