import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { LinhaPainelGoogle } from "@/lib/plataformas-de-anuncio/google/painel";
import { PainelGoogleAds } from "./PainelGoogleAds";

afterEach(cleanup);

const linha: LinhaPainelGoogle = {
  dia: "2026-10-08", conta: "1111111111", campanha: "Campanha Alpha", campanhaId: "20",
  grupo: "Grupo A", grupoId: "8", anuncio: "Exemplo", anuncioId: "9", palavraChave: "exemplo",
  moeda: "BRL", negocios: 2, ganhos: 1, perdidos: 0, valorGanhoCentavos: 5000,
};

it("filtra os negócios da conta escolhida e mantém os nomes de campanha ao trocar o idioma", () => {
  render(<IdiomaProvider locale="es"><PainelGoogleAds hoje="2026-10-09" linhas={[
    linha, { ...linha, conta: "2222222222", campanha: "Campanha Beta" },
  ]} /></IdiomaProvider>);
  const tabela = within(screen.getByRole("table"));
  expect(tabela.getByText("Campanha Alpha")).toBeTruthy();
  expect(tabela.getByText("Campanha Beta")).toBeTruthy();
  const selecionarConta = screen.getAllByRole("combobox").find(c => within(c).queryByRole("option", { name: /111/ }));
  expect(selecionarConta).toBeDefined();
  fireEvent.change(selecionarConta!, { target: { value: "2222222222" } });
  expect(tabela.queryByText("Campanha Alpha")).toBeNull();
  expect(tabela.getByText("Campanha Beta")).toBeTruthy();
  expect(screen.getByRole("option", { name: "Todas las cuentas" })).toBeTruthy();
});
