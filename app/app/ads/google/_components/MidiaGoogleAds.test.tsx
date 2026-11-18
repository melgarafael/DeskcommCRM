import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { LinhaPainelGoogle } from "@/lib/plataformas-de-anuncio/google/painel";
import { MidiaGoogleAds, type ResumoMidiaGoogle } from "./MidiaGoogleAds";

afterEach(cleanup);

const conta = "1111111111";
const fuso = "America/Sao_Paulo";
const linha: LinhaPainelGoogle = {
  dia: "2026-11-15", conta, campanha: "Pesquisa", campanhaId: "7", grupo: null,
  grupoId: null, anuncio: null, anuncioId: null, palavraChave: null, moeda: "BRL",
  negocios: 3, ganhos: 1, perdidos: 0, valorGanhoCentavos: 1000,
};
const campanhas = ["7", "8", "9"].map((id) => ({
  id, nome: "Pesquisa", status: "ENABLED", moeda: "EUR", fuso,
  impressoes: 100, cliques: 5, custo: 30, conversoes: 1,
}));
const carregar = async (): Promise<ResumoMidiaGoogle> => ({ ok: true, contaId: conta, campanhas });

async function colunas(campanha: string) {
  const linha = await screen.findByRole("row", { name: new RegExp("ID " + campanha + " ") });
  const [, ganhos, custoPorGanho] = within(linha).getAllByRole("cell");
  return [ganhos?.textContent, custoPorGanho?.textContent?.replace(/\s+/g, " ")];
}

it("calcula o custo por ganho só com IDs e datas correspondentes, separando zero observado de dado ausente", async () => {
  const linhas = [
    linha, { ...linha, dia: "2026-11-14" },
    { ...linha, conta: "2222222222", ganhos: 50 },
    { ...linha, dia: "2025-01-01", ganhos: 5 },
    { ...linha, campanhaId: null, ganhos: 5 },
    { ...linha, campanhaId: "8", ganhos: 0 },
  ];
  render(<MidiaGoogleAds hoje="2026-11-15" carregar={carregar} atribuicao={{ linhas, fuso }} />);
  expect(await colunas("7")).toEqual(["2", "€ 15,00"]);
  expect(await colunas("8")).toEqual(["0", "—"]);
  expect(await colunas("9")).toEqual(["—", "—"]);
});

it("preserva as métricas do Google quando o fuso do CRM não corresponde", async () => {
  render(<MidiaGoogleAds hoje="2026-11-15" carregar={carregar} atribuicao={{ linhas: [linha], fuso: "UTC" }} />);
  expect(await colunas("7")).toEqual(["—", "—"]);
});
