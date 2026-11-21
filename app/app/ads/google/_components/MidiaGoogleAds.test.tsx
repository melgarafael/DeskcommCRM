import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LinhaPainelGoogle } from "@/lib/plataformas-de-anuncio/google/painel";
import { MidiaGoogleAds, type ResumoMidiaGoogle } from "./MidiaGoogleAds";

afterEach(cleanup);

const conta = "1111111111";
const primeira = { customerId: conta, label: "Conta A", propria: true, loginCustomerId: "9999999999" };
const segunda = { customerId: "2222222222", label: "Conta B", propria: true, loginCustomerId: null };
const props = { contas: [primeira], podeGerenciar: false, remover: async () => ({ ok: true as const }), hoje: "2026-11-15" };
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
  render(<MidiaGoogleAds {...props} carregar={carregar} atribuicao={{ linhas, fuso }} />);
  expect(await colunas("7")).toEqual(["2", "€ 15,00"]);
  expect(await colunas("8")).toEqual(["0", "—"]);
  expect(await colunas("9")).toEqual(["—", "—"]);
});

it("preserva as métricas do Google quando o fuso do CRM não corresponde", async () => {
  render(<MidiaGoogleAds {...props} carregar={carregar} atribuicao={{ linhas: [linha], fuso: "UTC" }} />);
  expect(await colunas("7")).toEqual(["—", "—"]);
});

it("isola contas mesmo quando a leitura anterior termina por último", async () => {
  let concluirPrimeira!: (valor: ResumoMidiaGoogle) => void;
  const primeiraLeitura = new Promise<ResumoMidiaGoogle>((resolve) => { concluirPrimeira = resolve; });
  const ler = vi.fn(async (_periodo: { de: string; ate: string }, id?: string): Promise<ResumoMidiaGoogle> => {
    if (id === primeira.customerId) return primeiraLeitura;
    return { ok: true, contaId: segunda.customerId, campanhas: [{ ...campanhas[0]!, nome: "Campanha B", moeda: "USD" }] };
  });
  render(<MidiaGoogleAds {...props} contas={[primeira, segunda]} carregar={ler} atribuicao={{ linhas: [linha], fuso }} />);
  expect(ler).toHaveBeenCalledWith({ de: "2026-10-17", ate: props.hoje }, conta);
  expect(screen.queryByRole("button", { name: "Conectar conta de leitura" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Conta de anúncios" }), { target: { value: segunda.customerId } });
  await screen.findByText("Campanha B");
  expect(await colunas("7")).toEqual(["—", "—"]);
  await act(async () => { concluirPrimeira(await carregar()); });
  expect(screen.getByText("Campanha B")).toBeTruthy();
  expect(screen.queryByText("Pesquisa")).toBeNull();
  expect(screen.queryAllByText(/€/)).toHaveLength(0);
});

it("abre uma autorização específica de relatórios e preserva o fallback das conversões após a remoção", async () => {
  const remover = vi.fn(props.remover);
  const ler = vi.fn(carregar);
  const admin = { ...props, carregar: ler, remover, podeGerenciar: true };
  const view = render(<MidiaGoogleAds {...admin} />);
  fireEvent.click(screen.getByRole("button", { name: "Reconectar para leitura" }));
  const form = screen.getByRole("form", { name: "Autorização de relatórios" }) as HTMLFormElement;
  expect(form.getAttribute("action")).toBe("/api/v1/plataformas-de-anuncio/google/connect");
  expect(Object.fromEntries(new FormData(form))).toEqual({
    purpose: "reporting", customer_id: conta, login_customer_id: "9999999999", label: "Conta A",
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  fireEvent.click(screen.getByRole("button", { name: "Remover acesso de leitura" }));
  expect(remover).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirmar remoção" }));
  await waitFor(() => expect(remover).toHaveBeenCalledWith(conta));
  view.rerender(<MidiaGoogleAds {...admin} contas={[{ ...primeira, propria: false }]} />);
  await waitFor(() => expect(ler).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("option", { name: "Conta de conversões · 111-111-1111" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Autorizar leitura desta conta" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remover acesso de leitura" })).toBeNull();
});

it("o Continuar no Google navega pela URL, porque o envio nativo do formulário é barrado pela CSP no redirect", () => {
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign } });
  try {
    render(<MidiaGoogleAds {...props} carregar={carregar} podeGerenciar />);
    fireEvent.click(screen.getByRole("button", { name: "Reconectar para leitura" }));
    const form = screen.getByRole("form", { name: "Autorização de relatórios" }) as HTMLFormElement;
    const evento = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(evento);
    // Sem o preventDefault, o navegador enviaria o formulário e a CSP cancelaria o redirect.
    expect(evento.defaultPrevented).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    const destino = new URL(String(assign.mock.calls[0]?.[0]), "http://localhost");
    expect(destino.pathname).toBe("/api/v1/plataformas-de-anuncio/google/connect");
    expect(Object.fromEntries(destino.searchParams)).toEqual({
      purpose: "reporting", customer_id: conta, login_customer_id: "9999999999", label: "Conta A",
    });
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: original });
  }
});

it("pede a primeira conta sem consultar o Google enquanto o cadastro está vazio", () => {
  const ler = vi.fn(carregar);
  render(<MidiaGoogleAds {...props} contas={[]} carregar={ler} podeGerenciar />);
  expect(ler).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Conectar conta de leitura" }));
  expect(screen.getByRole("textbox", { name: "ID da conta de anúncios" })).toHaveProperty("readOnly", false);
});
