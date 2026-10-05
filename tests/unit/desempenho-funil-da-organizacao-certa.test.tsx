/**
 * DESEMPENHO › FUNIL: a organização ativa entra na CHAVE do cache (#2313).
 *
 * O card "Funil · N abertos" de Análise › Desempenho (`/app/metrics`) pede
 * `/api/v1/metrics/attendants`, rota que resolve o escopo no cookie
 * `active_org` — a MESMA URL devolve o funil de quem estiver ativa. Com a
 * chave sem a organização (`["metrics","attendants",owner]`), a entrada
 * gravada para a organização B continuava sendo servida para a A: a issue
 * relata o card com as etapas da organização anterior (0 abertos) mesmo com o
 * seletor já na nova, e só um Ctrl+F5 resolvia.
 *
 * O caso decide a TROCA, não a renderização:
 *
 *  1. controle — com a organização B ativa, o card mostra o funil da B;
 *  2. troca — seletor e cookie passam para A; o card tem de mostrar 79
 *     abertos da A e NADA da B. Sem a organização na chave, a chave não muda,
 *     os 30 s de `staleTime` seguram a resposta antiga e o card continua na B
 *     (é este o vermelho que a mudança nova derruba).
 *
 * Os três painéis irmãos (Atrito, Perdas, Previsão) são mockados nulos: o que
 * este arquivo mede é o card do funil, e eles têm chave de cache própria.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cenario = vi.hoisted(() => {
  const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const janela = { from: "2026-09-05T00:00:00.000Z", to: "2026-10-05T00:00:00.000Z" };
  const paginas = {
    // A: 79 leads abertos (o que o autor da issue conferiu no banco)
    [ORG_A]: {
      data: {
        window: janela,
        owner_user_id: null,
        funnel: [{ stage_id: "a1", stage_name: "Qualificação · org A", position: 1, count: 79 }],
        attendants: [],
      },
      meta: {},
    },
    // B: etapas da outra organização, sem nenhum lead aberto
    [ORG_B]: {
      data: {
        window: janela,
        owner_user_id: null,
        funnel: [{ stage_id: "b1", stage_name: "Novo · org B", position: 1, count: 0 }],
        attendants: [],
      },
      meta: {},
    },
  };
  const estado = { orgNoSeletor: ORG_B, orgNoCookie: ORG_B };
  const get = vi.fn(async (url: string) => {
    if (!url.startsWith("/api/v1/metrics/attendants")) {
      throw new Error(`URL fora do escopo deste teste: ${url}`);
    }
    return paginas[estado.orgNoCookie as keyof typeof paginas];
  });
  return { ORG_A, ORG_B, estado, get };
});

vi.mock("@/lib/api/client", () => ({ apiClient: { get: cenario.get } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: cenario.estado.orgNoSeletor }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/team/useTeamMembers", () => ({
  useTeamMembers: () => ({ data: undefined, isLoading: false, isError: false }),
}));
vi.mock("@/app/app/metrics/_components/AtritoPanel", () => ({ AtritoPanel: () => null }));
vi.mock("@/app/app/metrics/_components/PerdasPanel", () => ({ PerdasPanel: () => null }));
vi.mock("@/app/app/metrics/_components/PrevisaoPanel", () => ({ PrevisaoPanel: () => null }));

import { MetricsClient } from "@/app/app/metrics/_components/MetricsClient";

let cliente: QueryClient;

function Tela() {
  return (
    <QueryClientProvider client={cliente}>
      <MetricsClient canCompare={false} currentUserId="usuario-1" />
    </QueryClientProvider>
  );
}

const buscar = (regex: RegExp) => screen.findByText(regex, undefined, { timeout: 4000 });

beforeEach(() => {
  cenario.get.mockClear();
  cenario.estado.orgNoSeletor = cenario.ORG_B;
  cenario.estado.orgNoCookie = cenario.ORG_B;
  cliente = new QueryClient();
});

afterEach(() => {
  cleanup();
  cliente.clear();
});

describe("Desempenho › card Funil (#2313)", () => {
  it("controle: com a organização B ativa, o card mostra o funil da B", async () => {
    render(<Tela />);
    expect(await buscar(/· 0 abertos/)).toBeTruthy();
    expect(screen.getByText("Novo · org B")).toBeTruthy();
    expect(screen.queryByText("Qualificação · org A")).toBeNull();
  });

  it("troca de organização: o card não serve o funil da organização anterior", async () => {
    const { rerender } = render(<Tela />);
    expect(await buscar(/· 0 abertos/)).toBeTruthy();
    expect(screen.getByText("Novo · org B")).toBeTruthy();

    // A troca: o seletor do topo já aponta a A e o cookie da sessão também —
    // é o estado em que o autor da issue abriu a tela e viu o funil da B.
    cenario.estado.orgNoSeletor = cenario.ORG_A;
    cenario.estado.orgNoCookie = cenario.ORG_A;
    rerender(<Tela />);

    expect(await buscar(/· 79 abertos/)).toBeTruthy();
    expect(screen.getByText("Qualificação · org A")).toBeTruthy();
    expect(screen.queryByText("Novo · org B")).toBeNull();
  });
});
