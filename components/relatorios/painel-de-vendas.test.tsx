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
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/reports/usePainelDeVendas", () => ({ usePainelDeVendas: vi.fn() }));
vi.mock("@/hooks/reports/useCommercialReport", () => ({ useCommercialReport: vi.fn() }));
vi.mock("@/components/relatorios/rankings-de-negocios-ganhos", () => ({
  RankingsDeNegociosGanhos: vi.fn(() => null),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));

import { RankingsDeNegociosGanhos } from "@/components/relatorios/rankings-de-negocios-ganhos";
import { useCommercialReport } from "@/hooks/reports/useCommercialReport";
import { usePainelDeVendas, type RespostaDoPainelDeVendas } from "@/hooks/reports/usePainelDeVendas";

const FUNIL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** As opções de funil e tag do período (a resposta do relatório comercial). */
function opcoes(isPlaceholderData = false, pipeline_ids = [FUNIL_A], tags = ["atacado", "varejo"]) {
  vi.mocked(useCommercialReport).mockReturnValue({
    data: { data: { opcoes: { pipeline_ids, tags }, nomes_dos_funis: { [FUNIL_A]: "Pedidos" } } },
    isPlaceholderData,
  } as never);
}

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
  opcoes();
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

    expect(vi.mocked(usePainelDeVendas)).toHaveBeenCalledWith({ ...NOVEMBRO, pipelineId: "", tag: "" });
    expect(screen.getByTestId("atalho-mes").getAttribute("aria-pressed")).toBe("true");
  });

  it("o atalho troca o período, e a lista de vendas recebe o MESMO período", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    fireEvent.click(screen.getByTestId("atalho-mes_passado"));

    const outubro = { de: "2026-10-01", ate: "2026-10-31" };
    expect(vi.mocked(usePainelDeVendas)).toHaveBeenLastCalledWith({ ...outubro, pipelineId: "", tag: "" });
    expect(vi.mocked(RankingsDeNegociosGanhos).mock.lastCall?.[0]).toMatchObject(outubro);
  });

  it("o que ficou fora é dito: venda sem valor e venda em outra moeda", () => {
    responder(resposta({ vendas_sem_valor: 2, excluidos: { outra_moeda: 1 } }));
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    const avisos = texto("avisos-do-painel");
    expect(avisos).toContain("sem valor preenchido");
    expect(avisos).toContain("outra moeda");
  });
});

describe("PainelDeVendas — o recorte por funil e tag", () => {
  it("escolher a tag recorta os cartões E a lista, que recebe o recorte e não desenha seletor próprio", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    fireEvent.change(screen.getByTestId("painel-tag"), { target: { value: "atacado" } });

    expect(vi.mocked(usePainelDeVendas)).toHaveBeenLastCalledWith({ ...NOVEMBRO, pipelineId: "", tag: "atacado" });
    const propsDaLista = vi.mocked(RankingsDeNegociosGanhos).mock.lastCall?.[0];
    expect(propsDaLista).toMatchObject({ ...NOVEMBRO, recorte: { pipelineId: "", tag: "atacado" } });
    expect(typeof propsDaLista?.aoMudarRecorte).toBe("function");
  });

  it("o funil é oferecido pelo nome, e 'Limpar filtros' volta a tudo", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    const funil = screen.getByTestId("painel-funil") as HTMLSelectElement;
    expect([...funil.options].map((o) => o.textContent)).toEqual(["Todos os funis", "Pedidos"]);
    fireEvent.change(funil, { target: { value: FUNIL_A } });
    fireEvent.click(screen.getByTestId("painel-limpar"));

    expect(vi.mocked(usePainelDeVendas)).toHaveBeenLastCalledWith({ ...NOVEMBRO, pipelineId: "", tag: "" });
  });

  it("o clique numa tag do ranking (aoMudarRecorte) também recorta os cartões", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    const aoMudar = vi.mocked(RankingsDeNegociosGanhos).mock.lastCall?.[0].aoMudarRecorte;
    act(() => aoMudar?.({ pipelineId: "", tag: "varejo" }));

    expect(vi.mocked(usePainelDeVendas)).toHaveBeenLastCalledWith({ ...NOVEMBRO, pipelineId: "", tag: "varejo" });
  });

  it("a tag que sumiu do período novo é zerada — mas não com a resposta antiga", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);
    fireEvent.change(screen.getByTestId("painel-tag"), { target: { value: "atacado" } });

    // Resposta ANTIGA sem a tag: não zera.
    opcoes(true, [FUNIL_A], ["varejo"]);
    fireEvent.click(screen.getByTestId("atalho-mes_passado"));
    expect(vi.mocked(usePainelDeVendas).mock.lastCall?.[0]).toMatchObject({ tag: "atacado" });

    // Resposta do período ATUAL sem a tag: zera.
    opcoes(false, [FUNIL_A], ["varejo"]);
    fireEvent.click(screen.getByTestId("atalho-mes_passado"));
    expect(vi.mocked(usePainelDeVendas).mock.lastCall?.[0]).toMatchObject({ tag: "" });
  });
});
