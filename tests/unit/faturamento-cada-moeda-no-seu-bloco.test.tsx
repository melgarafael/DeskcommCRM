import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * NO FATURAMENTO, CADA MOEDA TEM O SEU BLOCO — NUNCA UMA SOMA ENTRE MOEDAS (#1531).
 *
 * A tela escrevia todo número do relatório em "BRL" fixo. Com R$ 150,00 e
 * 200,00 € no período, os cartões diziam "R$ 350,00": um valor que não existe
 * em moeda nenhuma, com cara de verdade. Desde a migration 0444 o relatório
 * devolve os mesmos totais separados em `por_moeda`, e a tela desenha um
 * bloco por moeda.
 *
 * Dois casos daqui são VERDES também na main, de propósito: com uma moeda só
 * em real (e no período vazio), a tela tem de continuar exatamente como era.
 * Os outros quatro são o defeito, e vermelham contra o código anterior.
 */

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { Faturamento } from "@/app/app/faturamento/_client";
import { apiClient } from "@/lib/api/client";

/** O `Intl` separa símbolo e número com espaço inseparável; o teste lê espaço. */
const semNbsp = (s: string) => s.replace(/[  ]/g, " ");

const ANA = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENTE = "cccccccc-0000-4000-8000-000000000001";

function totais(o: {
  entradas: number;
  saidas: number;
  comandas: number;
  faturado: number;
  forma: string;
  comissao: number;
}) {
  return {
    entradas_cents: o.entradas,
    saidas_cents: o.saidas,
    saldo_cents: o.entradas - o.saidas,
    comandas_finalizadas: o.comandas,
    comandas_estornadas: 0,
    faturado_cents: o.faturado,
    ticket_medio_cents: o.comandas ? o.faturado / o.comandas : 0,
    por_forma: o.comandas
      ? [{ nome: o.forma, quantidade: o.comandas, total_cents: o.faturado }]
      : [],
    por_profissional: o.comandas
      ? [{ attendant_user_id: ANA, itens: o.comandas, comissao_cents: o.comissao }]
      : [],
    por_servico: o.comandas
      ? [{ nome: "Corte", quantidade: o.comandas, total_cents: o.faturado }]
      : [],
    por_cliente: o.comandas
      ? [{ contact_id: CLIENTE, comandas: o.comandas, total_cents: o.faturado }]
      : [],
  };
}

const REAL = totais({
  entradas: 15000,
  saidas: 3000,
  comandas: 2,
  faturado: 15000,
  forma: "Pix",
  comissao: 1500,
});
const EURO = totais({
  entradas: 20000,
  saidas: 0,
  comandas: 1,
  faturado: 20000,
  forma: "Cartão",
  comissao: 2000,
});
const VAZIO = totais({ entradas: 0, saidas: 0, comandas: 0, faturado: 0, forma: "", comissao: 0 });

/** O topo como a 0356 (e a 0444) o devolvem: a soma de todas as moedas. */
const MISTURADO = {
  entradas_cents: 35000,
  saidas_cents: 3000,
  saldo_cents: 32000,
  comandas_finalizadas: 3,
  comandas_estornadas: 0,
  faturado_cents: 35000,
  ticket_medio_cents: 35000 / 3,
  por_forma: [
    { nome: "Cartão", quantidade: 1, total_cents: 20000 },
    { nome: "Pix", quantidade: 2, total_cents: 15000 },
  ],
  por_profissional: [{ attendant_user_id: ANA, itens: 3, comissao_cents: 3500 }],
  por_servico: [{ nome: "Corte", quantidade: 3, total_cents: 35000 }],
  por_cliente: [{ contact_id: CLIENTE, comandas: 3, total_cents: 35000 }],
};

function responder(relatorio: object) {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/reports/financeiro")) {
      return { data: { de: "2026-01-01", ate: "2026-01-31", ...relatorio } };
    }
    if (url.startsWith("/api/v1/team/assignable")) {
      return { data: [{ user_id: ANA, full_name: "Ana" }] };
    }
    if (url.startsWith("/api/v1/contacts")) {
      return { data: [{ id: CLIENTE, display_name: "Cliente Um", name: null }] };
    }
    return { data: [] };
  });
}

function montar(moedaDaOrg = "BRL") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Faturamento podeLancar={false} moedaDaOrg={moedaDaOrg} />
    </QueryClientProvider>,
  );
}

/** O valor do cartão com este título, dentro de `onde`. */
function cartao(onde: HTMLElement, titulo: string): string {
  const rotulo = within(onde).getByText(titulo);
  return semNbsp(rotulo.parentElement?.textContent ?? "").replace(titulo, "");
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe("faturamento com UMA moeda — a tela de antes", () => {
  it("em real, os valores saem em real e não há bloco nem título de moeda", async () => {
    responder({ ...REAL, por_moeda: { BRL: REAL } });
    montar();
    await screen.findByTestId("resumo-de-comandas");

    expect(cartao(document.body, "Entrou")).toBe("R$ 150,00");
    expect(cartao(document.body, "Saldo")).toBe("R$ 120,00");
    expect(cartao(document.body, "Ticket médio")).toBe("R$ 75,00");
    expect(semNbsp(screen.getByTestId("resumo-de-comandas").textContent ?? "")).toContain(
      "R$ 150,00 faturado",
    );
    expect(screen.queryByTestId("bloco-BRL")).toBeNull();
    expect(
      screen.queryByText("Moedas diferentes não se somam: cada uma tem o seu bloco."),
    ).toBeNull();
  });

  it("período vazio numa organização em real mostra R$ 0,00, como sempre", async () => {
    responder({ ...VAZIO, por_moeda: {} });
    montar("BRL");
    await screen.findByTestId("resumo-de-comandas");

    expect(cartao(document.body, "Entrou")).toBe("R$ 0,00");
    expect(cartao(document.body, "Ticket médio")).toBe("R$ 0,00");
  });

  it("só em euro, os valores saem em euro — e nenhum em real", async () => {
    responder({ ...EURO, por_moeda: { EUR: EURO } });
    montar("BRL");
    await screen.findByTestId("resumo-de-comandas");

    expect(cartao(document.body, "Entrou")).toBe("200,00 €");
    expect(cartao(document.body, "Ticket médio")).toBe("200,00 €");
    expect(semNbsp(document.body.textContent ?? "")).not.toContain("R$");
  });
});

describe("faturamento com DUAS moedas — um bloco para cada, nada somado", () => {
  it("real e euro ficam em blocos separados, e o R$ 350,00 inventado não aparece", async () => {
    responder({ ...MISTURADO, por_moeda: { BRL: REAL, EUR: EURO } });
    montar();
    const real = await screen.findByTestId("bloco-BRL");
    const euro = screen.getByTestId("bloco-EUR");

    expect(
      screen.getByText("Moedas diferentes não se somam: cada uma tem o seu bloco."),
    ).toBeTruthy();
    expect(cartao(real, "Entrou")).toBe("R$ 150,00");
    expect(cartao(real, "Ticket médio")).toBe("R$ 75,00");
    expect(cartao(euro, "Entrou")).toBe("200,00 €");
    expect(cartao(euro, "Ticket médio")).toBe("200,00 €");
    expect(semNbsp(within(euro).getByText("Ana").parentElement?.textContent ?? "")).toContain(
      "20,00 €",
    );

    const tudo = semNbsp(document.body.textContent ?? "");
    expect(tudo).not.toContain("350,00");
    expect(tudo).not.toContain("116,67");
  });

  it("a porcentagem de cada forma é sobre o faturado da própria moeda", async () => {
    responder({ ...MISTURADO, por_moeda: { BRL: REAL, EUR: EURO } });
    montar();
    const real = await screen.findByTestId("bloco-BRL");

    // Pix é todo o faturado em real. Sobre os 350 misturados, sairia 43%.
    const pix = within(real).getByText("Pix").closest("tr");
    expect(pix?.textContent).toContain("100%");
    expect(pix?.textContent).not.toContain("43%");
  });

  it("a moeda da organização vem primeiro; sem ela na lista, ordem alfabética", async () => {
    responder({ ...MISTURADO, por_moeda: { BRL: REAL, EUR: EURO } });
    const { unmount } = montar("EUR");
    await screen.findByTestId("bloco-EUR");
    const ordem = () =>
      [...document.querySelectorAll('[data-testid^="bloco-"]')].map((b) =>
        b.getAttribute("data-testid"),
      );
    expect(ordem()).toEqual(["bloco-EUR", "bloco-BRL"]);
    unmount();

    responder({ ...MISTURADO, por_moeda: { EUR: EURO, BRL: REAL } });
    montar("USD");
    await screen.findByTestId("bloco-BRL");
    expect(ordem()).toEqual(["bloco-BRL", "bloco-EUR"]);
  });
});
