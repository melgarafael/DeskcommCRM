/**
 * O PAINEL DE VENDAS — a tela.
 *
 *  1. os quatro cartões mostram o que a rota mandou, formatado;
 *  2. sem venda fechada, ticket e conversão dizem "—", nunca 0;
 *  3. o atalho troca o período, e a lista de vendas abaixo recebe o MESMO período;
 *  4. o que ficou fora é dito (sem valor, outra moeda);
 *  5. a primeira renderização usa o período que veio do servidor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/reports/usePainelDeVendas", () => ({ usePainelDeVendas: vi.fn() }));
vi.mock("@/components/relatorios/rankings-de-negocios-ganhos", () => ({
  RankingsDeNegociosGanhos: vi.fn(() => null),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));

import { RankingsDeNegociosGanhos } from "@/components/relatorios/rankings-de-negocios-ganhos";
import { usePainelDeVendas, type RespostaDoPainelDeVendas } from "@/hooks/reports/usePainelDeVendas";

import { PainelDeVendas } from "./painel-de-vendas";

const TZ = "America/Sao_Paulo";
const NOVEMBRO = { de: "2026-11-01", ate: "2026-11-20" };

function resposta(patch: Partial<RespostaDoPainelDeVendas> = {}): RespostaDoPainelDeVendas {
  return {
    janela: { de: NOVEMBRO.de, ate: NOVEMBRO.ate, tz: TZ, from: "", to: "" },
    moeda: "BRL",
    vendas: 34,
    vendido_centavos: 5_570_120,
    vendas_com_valor: 34,
    vendas_sem_valor: 0,
    ticket_medio_centavos: 163_827,
    perdidos: 158,
    conversao: 34 / 192,
    granularidade: "dia",
    serie: [{ chave: "2026-11-01", vendas: 34, centavos: 5_570_120 }],
    excluidos: { outra_moeda: 0 },
    truncado: false,
    ...patch,
  };
}

function responder(payload: RespostaDoPainelDeVendas) {
  vi.mocked(usePainelDeVendas).mockReturnValue({
    data: { data: payload },
    isLoading: false,
    isError: false,
    isFetching: false,
  } as never);
}

const texto = (testId: string) => screen.getByTestId(testId).textContent?.replace(/\s/g, " ") ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("PainelDeVendas", () => {
  it("os quatro cartões mostram o que a rota mandou, formatado", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    expect(texto("cartao-vendas")).toContain("34");
    expect(texto("cartao-valor")).toMatch(/R\$.55\.701,20/);
    expect(texto("cartao-ticket")).toMatch(/R\$.1\.638,27/);
    expect(texto("cartao-conversao")).toContain("17,7%");
    expect(texto("cartao-conversao")).toContain("158 perdidos");
  });

  it("sem venda fechada, ticket e conversão dizem '—', e o gráfico diz que não houve venda", () => {
    responder(resposta({ vendas: 0, vendido_centavos: 0, vendas_com_valor: 0, perdidos: 0, ticket_medio_centavos: null, conversao: null, serie: [] }));
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    expect(texto("cartao-ticket")).toContain("—");
    expect(texto("cartao-conversao")).toContain("—");
    expect(screen.getByTestId("sem-vendas")).toBeTruthy();
  });

  it("a primeira renderização usa o período do servidor, e o atalho dele aparece marcado", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    expect(vi.mocked(usePainelDeVendas)).toHaveBeenCalledWith(NOVEMBRO);
    expect(screen.getByTestId("atalho-mes").getAttribute("aria-pressed")).toBe("true");
  });

  it("o atalho troca o período, e a lista de vendas recebe o MESMO período", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    fireEvent.click(screen.getByTestId("atalho-mes_passado"));

    const outubro = { de: "2026-10-01", ate: "2026-10-31" };
    expect(vi.mocked(usePainelDeVendas)).toHaveBeenLastCalledWith(outubro);
    expect(vi.mocked(RankingsDeNegociosGanhos).mock.lastCall?.[0]).toEqual(outubro);
  });

  it("o que ficou fora é dito: venda sem valor e venda em outra moeda", () => {
    responder(resposta({ vendas_sem_valor: 2, excluidos: { outra_moeda: 1 } }));
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    const avisos = texto("avisos-do-painel");
    expect(avisos).toContain("sem valor preenchido");
    expect(avisos).toContain("outra moeda");
  });
});
