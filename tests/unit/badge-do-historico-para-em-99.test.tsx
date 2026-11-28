/**
 * #4451 — a aba do histórico diz quando o número PAROU no teto.
 *
 * A rota conta no máximo cem linhas das pastas de histórico ("Fechadas" e
 * "Arquivadas"): abaixo do teto o número é exato (inclusive zero, que some do
 * badge), no teto ele é "pelo menos cem" — e a tela tem de dizer isso com "+",
 * não estampar um número com cara de total.
 *
 * A troca seria uma mentira nova se a tela ignorasse `truncadas`: o badge de uma
 * pasta com 8 mil conversas mostraria "99" seco. Aqui se mede a única coisa que
 * a tela precisa fazer — marcar SÓ as abas que a rota declarou truncadas, e não
 * inventar marcação para quem não declarou nada (cache gravado antes do deploy).
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
  closed: 99,
  archived: 12,
  truncadas: ["closed"] as const,
};

function montar(contagens: Record<string, unknown> | undefined) {
  countsRef.current = { org: ORG, contagens };
  return render(<InboxFilters value={VALUE} onChange={() => {}} />);
}

/** O texto do gatilho da aba, como o operador lê. */
const aba = (nome: RegExp) => screen.getByRole("tab", { name: nome }).textContent ?? "";

afterEach(cleanup);

describe("#4451 — badge das pastas de histórico", () => {
  it("a aba truncada mostra 99+ e explica o corte", async () => {
    montar(CONTAGENS);
    // `depoisDeMontar` atrasa o badge um render (hidratação); findBy espera.
    expect(await screen.findByText("99+")).toBeTruthy();
    expect(aba(/Fechadas/)).toContain("99+");
    // O `title` diz POR QUE o número para: um "+" solto não explica nada.
    const explicacoes = screen.getAllByTitle(/histórico inteiro/);
    expect(explicacoes).toHaveLength(1);
    expect(explicacoes[0]?.textContent).toBe("99+");
  });

  it("a aba que NÃO bateu no teto mostra o número exato, sem `+`", async () => {
    montar(CONTAGENS);
    expect(await screen.findByText("12")).toBeTruthy();
    expect(aba(/Arquivadas/)).toContain("12");
    expect(aba(/Arquivadas/)).not.toContain("+");
    expect(aba(/Arquivadas/)).not.toContain("aprox.");
  });

  it("as abas ACIONÁVEIS não ganham `+` nem aviso: ali o número é trabalho a fazer", async () => {
    montar(CONTAGENS);
    expect(await screen.findByText("9")).toBeTruthy();
    for (const nome of [/Fila/, /Todas/, /Minhas/, /Automático/]) {
      const texto = aba(nome);
      expect(texto, `${nome} não deveria estar marcada como truncada`).not.toContain("+");
      expect(texto, `${nome} não deveria ter aviso nenhum`).not.toContain("aprox.");
    }
  });

  it("cache antigo, sem o campo `truncadas`, não inventa `+`", async () => {
    // A tela lê o cache antes da primeira resposta nova. Sem o campo, ela não
    // sabe que houve corte — e calar é melhor que marcar por adivinhação.
    montar({ fila: 4, unassigned: 4, automatico: 1, mine: 2, all: 9, closed: 71, archived: 29 });
    expect(await screen.findByText("71")).toBeTruthy();
    expect(aba(/Fechadas/)).toContain("71");
    expect(aba(/Fechadas/)).not.toContain("+");
  });
});
