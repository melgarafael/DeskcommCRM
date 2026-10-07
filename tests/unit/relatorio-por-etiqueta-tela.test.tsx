import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ABA "POR ETIQUETA" DE RELATÓRIOS CONSUME A ROTA DO #1888 (#1891).
 *
 * A rota `GET /api/v1/reports/tags?de&ate&tz` já existia (merged no #1888) e
 * até esta PR ninguém a lia — o gestor não tinha onde ver a resposta. O que
 * este arquivo prende é exatamente a fiação nova:
 *
 *  · o PEDIDO carrega `de`, `ate` e `tz` — sem a janela a tela leria "hoje" e
 *    sem o fuso o corte seria UTC (três horas de conversa nascendo ou sumindo
 *    conforme o país de quem olha);
 *  · a TABELA desenha as linhas NA ORDEM em que a rota devolve (volume
 *    primeiro: a pergunta é "qual assunto ocupou mais");
 *  · cada etiqueta LINKA para a lista já filtrada por ela — relatório que só
 *    lista é decoratório, e o corpo da issue cobra o link;
 *  · `espera_media_segundos: null` vira "—", nunca 0: não medido não é
 *    resposta zero (a doutrina do `/metrics/atrito`);
 *  · período sem etiqueta em uso mostra o MOTIVO que a rota ditou, em vez de
 *    uma tabela de zeros fingindo relatório.
 */

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { Relatorios } from "@/app/app/activities/_components/Relatorios";
import { apiClient } from "@/lib/api/client";

const VIP = {
  etiqueta: "vip",
  conversas: 12,
  abertas: 4,
  resolvidas: 8,
  espera_media_segundos: 720,
  fatia: 75,
};
const DUVIDA = {
  etiqueta: "duvida",
  conversas: 4,
  abertas: 4,
  resolvidas: 0,
  espera_media_segundos: null,
  fatia: 25,
};

function responder(relatorio: object) {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/reports/tags")) return { data: relatorio };
    if (url.startsWith("/api/v1/reports/activities")) return { data: { data: { total: 0 } } };
    return { data: [] };
  });
}

function montar(abaInicial = "etiquetas") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Relatorios abaInicial={abaInicial} />
    </QueryClientProvider>,
  );
}

const COM_DADOS = {
  janela: { de: "2026-09-01", ate: "2026-09-07", tz: "America/Sao_Paulo" },
  linhas: [VIP, DUVIDA],
  total_etiquetagens: 16,
  sem_dados: false,
  motivo: null,
  truncado: false,
};

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe("relatório por etiqueta na tela", () => {
  it("abre na aba, pede a rota com janela e fuso, e desenha cada linha com o link da etiqueta", async () => {
    responder(COM_DADOS);
    montar();

    // As DUAS abas existem no menu da tela — a nova não é um link solto.
    expect(screen.getByRole("tab", { name: "Atividades" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Por etiqueta" })).toBeTruthy();

    await screen.findByTestId("tabela-por-etiqueta");

    // O pedido: mesma rota do #1888, com de/ate/tz declarados.
    const pedidos = vi
      .mocked(apiClient.get)
      .mock.calls.map((c) => String(c[0]))
      .filter((u) => u.startsWith("/api/v1/reports/tags"));
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatch(
      /^\/api\/v1\/reports\/tags\?de=\d{4}-\d{2}-\d{2}&ate=\d{4}-\d{2}-\d{2}&tz=.+$/,
    );

    // Volume primeiro: a ordem é a da rota, não a do alfabeto.
    const linhas = screen.getAllByTestId("linha-de-etiqueta");
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toHaveTextContent("vip");
    expect(linhas[1]).toHaveTextContent("duvida");

    // O "e daí" da linha: da etiqueta para a lista de conversas filtrada — na
    // aba Todas. Sem `filter=` o Inbox abre na Fila, que esconde as resolvidas
    // e as que têm dono: a linha "vip, 8 resolvidas" levaria a uma lista vazia.
    const links = screen.getAllByTestId("link-de-etiqueta");
    expect(links[0]).toHaveAttribute("href", "/app/inbox?filter=all&tag=vip");
    expect(links[1]).toHaveAttribute("href", "/app/inbox?filter=all&tag=duvida");

    // Espera legível, e `null` (não medido) é travessão — nunca zero.
    expect(linhas[0]).toHaveTextContent("12 min");
    expect(linhas[1]).toHaveTextContent("—");
  });

  it("período sem conversa etiquetada mostra o motivo da rota, e não uma tabela de zeros", async () => {
    responder({
      ...COM_DADOS,
      linhas: [],
      total_etiquetagens: 0,
      sem_dados: true,
      motivo: "nenhuma_conversa_com_etiqueta_no_periodo",
    });
    montar();

    expect(await screen.findByText("Nenhuma conversa com etiqueta neste período")).toBeTruthy();
    expect(screen.queryByTestId("tabela-por-etiqueta")).toBeNull();
  });

  it("etiqueta em uso sem conversa no período é o outro motivo, e a tela diz os dois", async () => {
    responder({
      ...COM_DADOS,
      linhas: [],
      total_etiquetagens: 0,
      sem_dados: true,
      motivo: "nenhuma_etiqueta_em_uso",
    });
    montar();

    expect(await screen.findByText("Nenhuma etiqueta em uso")).toBeTruthy();
  });

  it("corte da rota avisa que os NÚMEROS contam só as conversas mais recentes", async () => {
    responder({ ...COM_DADOS, truncado: true });
    montar();

    // A tabela é agregada: não há "lista" que mostre só os recentes. O que o
    // corte faz é deixar de fora da CONTA as conversas mais antigas do período.
    expect(await screen.findByTestId("aviso-de-corte")).toHaveTextContent(
      "O período passou do limite de leitura: os números contam só as conversas mais recentes.",
    );
  });

  it("erro da rota não vaza número nenhum: a tela diz que falhou", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new Error("boom"));
    montar();

    expect(await screen.findByText("Erro ao carregar o relatório.")).toBeTruthy();
    expect(screen.queryByTestId("tabela-por-etiqueta")).toBeNull();
  });
});
