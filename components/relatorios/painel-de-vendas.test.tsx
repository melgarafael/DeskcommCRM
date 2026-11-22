/**
 * O PAINEL DE VENDAS — a tela.
 *
 *  1. os quatro cartões mostram o que a rota mandou, formatado; a conversão diz
 *     os NEGÓCIOS ganhos e perdidos (não as vendas);
 *  2. sem venda fechada, ticket e conversão dizem "—", nunca 0;
 *  3. o atalho troca o período; a primeira renderização usa o do servidor;
 *  4. o que ficou fora é dito (sem valor, outra moeda);
 *  5. o recorte (funil e tag) vai à rota, e as opções vêm da MESMA resposta;
 *  6. rankings e lista saem da resposta do painel — com a venda registrada
 *     marcada como tal, e o clique na tag do ranking recortando a tela.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/reports/usePainelDeVendas", () => ({ usePainelDeVendas: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));

import { usePainelDeVendas, type RespostaDoPainelDeVendas } from "@/hooks/reports/usePainelDeVendas";

import { PainelDeVendas } from "./painel-de-vendas";

const TZ = "America/Sao_Paulo";
const NOVEMBRO = { de: "2026-11-01", ate: "2026-11-20" };
const FUNIL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function resposta(patch: Partial<RespostaDoPainelDeVendas> = {}): RespostaDoPainelDeVendas {
  return {
    janela: { de: NOVEMBRO.de, ate: NOVEMBRO.ate, tz: TZ, from: "", to: "" },
    moeda: "BRL",
    vendas: 34,
    vendido_centavos: 5_570_120,
    vendas_com_valor: 34,
    vendas_sem_valor: 0,
    ticket_medio_centavos: 163_827,
    negocios_ganhos: 30,
    perdidos: 158,
    conversao: 30 / 188,
    granularidade: "dia",
    serie: [{ chave: "2026-11-01", vendas: 34, centavos: 5_570_120 }],
    origens: { registradas: 4, ganhos_sem_registro: 30 },
    excluidos: { outra_moeda: 0 },
    opcoes: { pipeline_ids: [FUNIL_A], tags: ["atacado", "varejo"] },
    rankings: {
      tags: [{ chave: "atacado", centavos: 18_000, vendas: 1 }],
      clientes: [{ chave: "c1", centavos: 18_000, vendas: 1 }],
      funis: [{ chave: FUNIL_A, centavos: 18_000, vendas: 1 }],
    },
    lista: [
      {
        id: "r1",
        origem: "registrada",
        lead_id: "l1",
        contact_id: "c1",
        pipeline_id: FUNIL_A,
        titulo: "Dãm Dãm Baby",
        tags: ["atacado"],
        centavos: 18_000,
        dia: "2026-11-20",
      },
    ],
    vendas_no_recorte: 34,
    contatos: { c1: { display_name: "Dãm Dãm Baby - Financeiro", name: null, phone_number: null } },
    nomes_dos_funis: { [FUNIL_A]: "Pedidos" },
    truncado: false,
    ...patch,
  };
}

function responder(payload: RespostaDoPainelDeVendas, isPlaceholderData = false) {
  vi.mocked(usePainelDeVendas).mockReturnValue({
    data: { data: payload },
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData,
  } as never);
}

const texto = (testId: string) => screen.getByTestId(testId).textContent?.replace(/\s/g, " ") ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("PainelDeVendas — cartões e período", () => {
  it("os quatro cartões mostram o que a rota mandou; a conversão fala dos NEGÓCIOS", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    expect(texto("cartao-vendas")).toContain("34");
    expect(texto("cartao-valor")).toMatch(/R\$.55\.701,20/);
    expect(texto("cartao-ticket")).toMatch(/R\$.1\.638,27/);
    expect(texto("cartao-conversao")).toContain("16%");
    expect(texto("cartao-conversao")).toContain("30 ganhos");
    expect(texto("cartao-conversao")).toContain("158 perdidos");
  });

  it("sem venda fechada, ticket e conversão dizem '—', e o gráfico diz que não houve venda", () => {
    responder(
      resposta({ vendas: 0, vendido_centavos: 0, vendas_com_valor: 0, negocios_ganhos: 0, perdidos: 0, ticket_medio_centavos: null, conversao: null, serie: [], lista: [], vendas_no_recorte: 0 }),
    );
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    expect(texto("cartao-ticket")).toContain("—");
    expect(texto("cartao-conversao")).toContain("—");
    expect(screen.getByTestId("sem-vendas")).toBeTruthy();
    expect(screen.queryByTestId("lista-do-painel")).toBeNull();
  });

  it("a primeira renderização usa o período do servidor; o atalho troca o período", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    expect(vi.mocked(usePainelDeVendas)).toHaveBeenCalledWith({ ...NOVEMBRO, pipelineId: "", tag: "" });
    expect(screen.getByTestId("atalho-mes").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTestId("atalho-mes_passado"));
    expect(vi.mocked(usePainelDeVendas)).toHaveBeenLastCalledWith({ de: "2026-10-01", ate: "2026-10-31", pipelineId: "", tag: "" });
  });

  it("o que ficou fora é dito: venda sem valor e venda em outra moeda", () => {
    responder(resposta({ vendas_sem_valor: 2, excluidos: { outra_moeda: 1 } }));
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    const avisos = texto("avisos-do-painel");
    expect(avisos).toContain("sem valor preenchido");
    expect(avisos).toContain("outra moeda");
  });
});

describe("PainelDeVendas — recorte, rankings e lista", () => {
  it("as opções de funil e tag vêm da resposta do painel, e o recorte vai à rota", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    const funil = screen.getByTestId("painel-funil") as HTMLSelectElement;
    expect([...funil.options].map((o) => o.textContent)).toEqual(["Todos os funis", "Pedidos"]);
    fireEvent.change(screen.getByTestId("painel-tag"), { target: { value: "atacado" } });

    expect(vi.mocked(usePainelDeVendas)).toHaveBeenLastCalledWith({ ...NOVEMBRO, pipelineId: "", tag: "atacado" });
    fireEvent.click(screen.getByTestId("painel-limpar"));
    expect(vi.mocked(usePainelDeVendas)).toHaveBeenLastCalledWith({ ...NOVEMBRO, pipelineId: "", tag: "" });
  });

  it("a lista mostra a venda registrada, com cliente, funil e a marca da origem", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    const lista = texto("lista-do-painel");
    expect(lista).toContain("Vendas (34)");
    expect(lista).toContain("Dãm Dãm Baby - Financeiro");
    expect(lista).toContain("Pedidos");
    expect(lista).toContain("venda registrada");
    expect(lista).toMatch(/R\$.180,00/);
    expect(screen.getByTestId("lista-do-painel").querySelector('[data-origem="registrada"]')).toBeTruthy();
  });

  it("clicar numa tag do ranking recorta a tela por ela", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);

    fireEvent.click(screen.getByTitle("Ver as vendas desta tag"));

    expect(vi.mocked(usePainelDeVendas)).toHaveBeenLastCalledWith({ ...NOVEMBRO, pipelineId: "", tag: "atacado" });
  });

  it("a tag que sumiu do período novo é zerada — mas não com a resposta antiga", () => {
    responder(resposta());
    render(<PainelDeVendas periodoInicial={NOVEMBRO} tz={TZ} />);
    fireEvent.change(screen.getByTestId("painel-tag"), { target: { value: "atacado" } });

    // Resposta ANTIGA (keepPreviousData) sem a tag: não zera.
    responder(resposta({ opcoes: { pipeline_ids: [FUNIL_A], tags: ["varejo"] } }), true);
    fireEvent.click(screen.getByTestId("atalho-mes_passado"));
    expect(vi.mocked(usePainelDeVendas).mock.lastCall?.[0]).toMatchObject({ tag: "atacado" });

    // Resposta do período ATUAL sem a tag: zera.
    responder(resposta({ opcoes: { pipeline_ids: [FUNIL_A], tags: ["varejo"] } }), false);
    fireEvent.click(screen.getByTestId("atalho-mes_passado"));
    expect(vi.mocked(usePainelDeVendas).mock.lastCall?.[0]).toMatchObject({ tag: "" });
  });
});
