/**
 * #4325 — a aba diz quando o número é APROXIMADO.
 *
 * A rota passou a contar "Fechadas" e "Arquivadas" pelo planejador do PostgREST
 * (`count: 'planned'`): custo previsível, número estimado. A troca seria uma
 * mentira nova se a tela continuasse estampando o valor com cara de exatidão —
 * o badge de uma pasta de histórico mostraria "3487" e ninguém saberia que o
 * número pode estar longe.
 *
 * Aqui se mede a única coisa que a tela precisa fazer: marcar o badge que a
 * rota declarou aproximado (`aproximadas`) e NÃO marcar os outros. As abas em
 * que alguém age continuam exatas, e um cache gravado antes deste deploy (sem
 * o campo) não ganha sufixo nenhum — a tela não inventa aviso.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type { ActiveOrg } from "@/lib/auth/types";

const countsRef: { current: Record<string, unknown> | undefined } = { current: undefined };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: countsRef.current?.org ?? null }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: countsRef.current?.contagens }),
}));

const ORG: ActiveOrg = { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" };
const VALUE: InboxFiltersValue = { tab: "all", search: "", onlyUnread: false };

const CONTAGENS = {
  fila: 4,
  unassigned: 4,
  automatico: 1,
  mine: 2,
  all: 9,
  closed: 71,
  archived: 29,
  aproximadas: ["closed", "archived"] as const,
};

function montar(contagens: Record<string, unknown> | undefined) {
  countsRef.current = { org: ORG, contagens };
  return render(<InboxFilters value={VALUE} onChange={() => {}} />);
}

/** O texto do gatilho da aba, como o operador lê. */
const aba = (nome: RegExp) => screen.getByRole("tab", { name: nome }).textContent ?? "";

afterEach(cleanup);

describe("#4325 — badge aproximado", () => {
  it("Fechadas e Arquivadas avisam que o número é aproximado", async () => {
    montar(CONTAGENS);
    // `depoisDeMontar` atrasa o badge um render (hidratação); findBy espera.
    expect(await screen.findByText("71")).toBeTruthy();
    expect(aba(/Fechadas/)).toContain("71");
    expect(aba(/Fechadas/)).toContain("aprox.");
    expect(aba(/Arquivadas/)).toContain("29");
    expect(aba(/Arquivadas/)).toContain("aprox.");
  });

  it("as abas ACIONÁVEIS não ganham o aviso: elas continuam exatas", async () => {
    montar(CONTAGENS);
    expect(await screen.findByText("9")).toBeTruthy();
    for (const nome of [/Fila/, /Todas/, /Minhas/, /Automático/]) {
      const texto = aba(nome);
      expect(texto, `${nome} não deveria estar marcada como aproximada`).not.toContain("aprox.");
    }
  });

  it("cache antigo, sem o campo `aproximadas`, não inventa aviso", async () => {
    // A tela lê o cache antes da primeira resposta nova. Sem o campo, ela não
    // sabe que houve estimativa — e calar é melhor que marcar por adivinhação.
    montar({ fila: 4, unassigned: 4, automatico: 1, mine: 2, all: 9, closed: 71, archived: 29 });
    expect(await screen.findByText("71")).toBeTruthy();
    expect(aba(/Fechadas/)).not.toContain("aprox.");
  });

  it("o aviso explica o motivo, não só um símbolo solto", async () => {
    montar(CONTAGENS);
    expect(await screen.findByText("71")).toBeTruthy();
    // O `title` é a explicação: a aba avisa que o número vem do histórico
    // inteiro, em vez de um "≈" sem tradução. São duas abas estimadas, e só duas.
    const explicacoes = screen.getAllByTitle(/histórico inteiro/);
    expect(explicacoes).toHaveLength(2);
    for (const explicacao of explicacoes) expect(explicacao.textContent).toContain("aprox.");
  });
});
