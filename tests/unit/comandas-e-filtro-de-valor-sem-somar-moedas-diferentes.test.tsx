// COMANDAS E FILTRO DE VALOR NÃO SOMAM (NEM COMPARAM) CENTAVOS DE MOEDAS
// DIFERENTES (#1531).
//
// A issue lista sete lugares onde `_cents` de moedas diferentes é tratado como
// se fosse o mesmo número. Dois já entraram na main (#1829 no total da coluna
// do funil, #1839 no relatório de faturamento) e os testes deles continuam aqui
// no repositório, verdes. Este arquivo cobre o RESTO do levantamento: a lista
// de atendimentos sem comanda e o filtro de valor do funil.
//
// REGRA DA ISSUE: agrupar por moeda e mostrar lado a lado. Nunca converter,
// nunca somar entre moedas. Um total de "R$ 5.000,00 + € 5.000,00" é a resposta
// certa; "R$ 10.000,00" é um número que não existe em moeda nenhuma.
//
// Os dois casos ⭐ são VERMELHOS contra o código de antes da mudança. Os dois
// `controle` são verdes dos dois lados: é a prova de que, com uma moeda só, a
// tela e o filtro continuam exatamente como são hoje.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { AtendimentosSemComanda, type Pendente } from "@/app/app/comandas/_pendentes";
import { applyFilters } from "@/lib/kanban/filters";
import type { Lead } from "@/lib/types/leads";

/** O `Intl` separa símbolo e número com espaço inseparável; o teste lê espaço. */
const semNbsp = (s: string) => s.replace(/[  ]/g, " ");

function pendente(over: Partial<Pendente>): Pendente {
  return {
    appointment_id: "11111111-1111-4111-8111-111111111111",
    title: "Atendimento",
    starts_at: "2026-09-01T10:00:00Z",
    contact_id: null,
    service_name: "Corte",
    suggested_price_cents: null,
    ...over,
  };
}

function montar(pendentes: Pendente[], moeda = "BRL") {
  return render(
    <AtendimentosSemComanda
      pendentes={pendentes}
      formas={[{ id: "f1", name: "Pix", account_id: "acc1" }]}
      podeLancar
      pendenteDeEnvio={false}
      moeda={moeda}
      onFaturar={() => {}}
    />,
  );
}

function marcar(...ids: string[]) {
  for (const id of ids) fireEvent.click(screen.getByTestId(`pendente-${id}`));
}

const botaoFaturar = () => screen.getByTestId("faturar-lote");

function lead(over: Partial<Lead>): Lead {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pipeline_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    stage_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: "Negócio",
    description: null,
    contact_id: null,
    value_cents: 0,
    currency: "BRL",
    owner_user_id: null,
    owner_agent_id: null,
    owner_kind: null,
    status: "open",
    tags: [],
    position_in_stage: 1000,
    created_at: "2026-09-01T12:00:00Z",
    updated_at: "2026-09-01T12:00:00Z",
    ...over,
  } as unknown as Lead;
}

describe("atendimentos sem comanda — o total por moeda", () => {
  it("⭐ duas moedas saem lado a lado, sem número inventado", () => {
    montar([
      pendente({ appointment_id: "a1", suggested_price_cents: 500_000 }),
      pendente({
        appointment_id: "a2",
        suggested_price_cents: 500_000,
        currency: "EUR",
      }),
    ]);
    marcar("a1", "a2");

    // A grafia de cada parcela é a do `formatCents` compartilhado (EUR em
    // pt-PT: "5000,00 €") — o MESMO formatador do total da coluna que o #1829
    // corrigiu. O que este caso trava é a ESTRUTURA: duas moedas lado a lado.
    const texto = semNbsp(botaoFaturar().textContent ?? "");
    expect(texto).toContain("R$ 5.000,00 + 5000,00 €");
    // O defeito: a soma dos dois centavos escrita em real.
    expect(texto).not.toContain("R$ 10.000,00");
    // E a linha em euro também não pode vestir real.
    expect(screen.getByText((t) => semNbsp(t) === "5000,00 €")).toBeTruthy();
  });

  it("controle — com uma moeda só, o total continua como hoje", () => {
    montar([
      pendente({ appointment_id: "b1", suggested_price_cents: 500_000 }),
      pendente({ appointment_id: "b2", suggested_price_cents: 500_000 }),
    ]);
    marcar("b1", "b2");

    const texto = semNbsp(botaoFaturar().textContent ?? "");
    expect(texto).toContain("R$ 10.000,00");
    expect(texto).not.toContain("+");
  });
});

describe("filtro de valor do funil — só compara dentro da moeda do limite", () => {
  it("⭐ não compara centavos de moeda diferente do limite", () => {
    const leads = [
      lead({ id: "brl", currency: "BRL", value_cents: 500_000 }),
      lead({ id: "eur", currency: "EUR", value_cents: 500_000 }),
      // Sem moeda declarada (dado anterior à coluna) o valor nasceu na moeda
      // da organização — e é nela que o limite foi escrito.
      lead({ id: "sem-moeda", currency: null, value_cents: 500_000 }),
    ];

    const fora = applyFilters(leads, {
      valueCentsMin: 100_000,
      valueCurrency: "BRL",
    });

    expect(fora.map((l) => l.id)).toEqual(["brl", "sem-moeda"]);
  });

  it("controle — numa organização de uma moeda só o filtro continua igual", () => {
    const leads = [
      lead({ id: "alto", currency: "BRL", value_cents: 500_000 }),
      lead({ id: "baixo", currency: "BRL", value_cents: 50_000 }),
      lead({ id: "velho", currency: null, value_cents: 200_000 }),
    ];

    const dentro = applyFilters(leads, {
      valueCentsMin: 100_000,
      valueCentsMax: 1_000_000,
      valueCurrency: "BRL",
    });

    expect(dentro.map((l) => l.id)).toEqual(["alto", "velho"]);
  });
});

describe("organização em outra moeda — a linha sem moeda veste a da organização", () => {
  it("o pendente sem currency sai na moeda da organização, nunca em real", () => {
    montar([pendente({ appointment_id: "e1", suggested_price_cents: 500_000 })], "EUR");
    marcar("e1");
    const texto = semNbsp(botaoFaturar().textContent ?? "");
    expect(texto).toContain("5000,00 €");
    expect(texto).not.toContain("R$");
    expect(screen.getAllByText((t) => semNbsp(t) === "5000,00 €").length).toBeGreaterThan(0);
  });
});
