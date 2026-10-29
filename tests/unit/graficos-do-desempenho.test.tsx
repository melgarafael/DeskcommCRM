// A EVOLUÇÃO DOS GANHOS NO DESEMPENHO SAI EM GRÁFICO E TABELA, NO MESMO CARD (#3024).
//
// A tela `/app/metrics` só tinha número e tabela. Esta fatia entrega a TENDÊNCIA:
// quantidade de ganhos por balde (dia/semana/mês) num gráfico de linha, com a
// tabela dos baldes logo abaixo — e sem mexer em nenhum número que já existia.
//
// O que este caso protege, e é o que a fatia promete:
//
//  - o gráfico E a tabela vivem no mesmo `Card` (não são dois blocos soltos);
//  - balde sem ganho aparece com zero, com a mesma contagem que a série traz;
//  - nenhuma frase nova escapa de `t()`.
//
// Remover o gráfico, ou tirar a tabela de dentro do `Card`, deixa vermelho.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SerieTemporal } from "@/hooks/metrics/useSerieTemporal";

// O idioma é trocável por caso: os casos do cartão no celular conferem que o
// rótulo de cada célula sai de `t()` também em espanhol.
let idioma: "pt-BR" | "es" = "pt-BR";
vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (s: string) => (idioma === "es" ? traduzir(s, "es") : s) };
});
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));

let serie: SerieTemporal;
vi.mock("@/hooks/metrics/useSerieTemporal", () => ({
  useSerieTemporal: () => ({ data: { data: serie }, isLoading: false, isError: false }),
}));

import { MetricsClient } from "@/app/app/metrics/_components/MetricsClient";
import { SeriePanel } from "@/app/app/metrics/_components/SeriePanel";
import { apiClient } from "@/lib/api/client";

function serieDeExemplo(): SerieTemporal {
  return {
    window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" },
    granularidade: "dia",
    baldes: [
      { balde: "2026-10-01", ganhos: 2 },
      { balde: "2026-10-02", ganhos: 0 },
      { balde: "2026-10-03", ganhos: 1 },
    ],
    total: 3,
    truncado: false,
  };
}

describe("a evolução dos ganhos no Desempenho", () => {
  it("⭐ gráfico e tabela no MESMO Card, e o balde parado aparece com zero", () => {
    serie = serieDeExemplo();
    render(<SeriePanel />);

    // O gráfico existe (o invólucro do recharts, no mesmo Card da tabela).
    const grafico = screen.getByTestId("ganhos-no-tempo");

    // A tabela dos baldes, com o dia PARADO (02) presente e zerado — não sumiu.
    // A célula mostra o rótulo no idioma da sessão (`02/10`), não a chave ISO.
    const linhaParada = screen.getByText("02/10").closest("tr");
    const celulas = Array.from(linhaParada?.querySelectorAll("td") ?? []).map(
      (td) => td.textContent ?? "",
    );
    expect(celulas).toEqual(["02/10", "0"]);

    // O mesmo `Card` para os dois: o ancestral comum é o próprio Cartão.
    const cartaoDoGrafico = grafico.closest("div.rounded-lg");
    const cartaoDaTabela = linhaParada?.closest("div.rounded-lg");
    expect(cartaoDoGrafico).not.toBeNull();
    expect(cartaoDaTabela).toBe(cartaoDoGrafico);
    // …e o Cartão é o da série, com o título e o total — não outro qualquer.
    expect(cartaoDoGrafico?.textContent).toContain("Ganhos por período");
    expect(cartaoDoGrafico?.textContent).toContain("3");
  });

  it("a tabela conta exatamente o que a série traz, sem recalcular", () => {
    serie = serieDeExemplo();
    render(<SeriePanel />);

    const linhas = Array.from(document.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""),
    );
    expect(linhas).toEqual([
      ["01/10", "2"],
      ["02/10", "0"],
      ["03/10", "1"],
    ]);
  });

  it("série cortada no teto de leitura avisa, e a inteira não", () => {
    serie = serieDeExemplo();
    const { unmount } = render(<SeriePanel />);
    expect(screen.queryByText("Série cortada no teto de leitura.")).toBeNull();
    unmount();

    serie = { ...serieDeExemplo(), truncado: true };
    render(<SeriePanel />);
    expect(screen.getByText("Série cortada no teto de leitura.")).toBeTruthy();
  });
});

// ─── O RANKING E "POR CANAL" VIRAM CARTÃO NO CELULAR (ADR-0006, F4) ──────────
//
// Abaixo de `md` o cabeçalho da tabela some (`max-md:hidden`) e cada linha vira
// um cartão. O nome da coluna passa a viajar na própria célula, pelo
// `data-rotulo`, que o CSS desenha antes do número. O jsdom não aplica media
// query, então o que se prende aqui é o CONTRATO: cada célula numérica carrega o
// mesmo texto do cabeçalho da sua coluna, traduzido — sem isso o cartão do
// celular mostraria "3 1 7" sem dizer o que é cada número.

function responderPainel() {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/metrics/attendants")) {
      return {
        data: {
          window: { from: "2026-09-23T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" },
          owner_user_id: null,
          excluded_tag: null,
          excluded_conversations: 0,
          funnel: [],
          attendants: [
            {
              user_id: "u-ana",
              won: 3,
              lost: 1,
              conversations_handled: 7,
              avg_first_response_seconds: 90,
              median_first_response_seconds: 60,
              name: "Ana Ranking",
              email: null,
            },
          ],
        },
      };
    }
    if (url.startsWith("/api/v1/metrics/channels")) {
      return {
        data: {
          window: { from: "2026-09-23T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" },
          owner_user_id: null,
          channels: [
            {
              channel_session_id: "canal-loja",
              channel_name: "Loja Centro",
              channel: "whatsapp",
              is_archived: false,
              conversations_handled: 5,
              avg_first_response_seconds: 30,
              sem_resposta: 2,
            },
          ],
        },
      };
    }
    throw new Error(`sem resposta de teste para ${url}`);
  });
}

function montarPainel() {
  serie = serieDeExemplo();
  responderPainel();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MetricsClient canCompare currentUserId="outra-pessoa" />
    </QueryClientProvider>,
  );
}

/** Os rótulos das células numéricas da linha, e os cabeçalhos das mesmas colunas. */
function rotulosEColunas(nomeDaLinha: string) {
  const linha = screen.getByText(nomeDaLinha).closest("tr")!;
  const tabela = linha.closest("table")!;
  const cabecalhos = Array.from(tabela.querySelectorAll("thead th")).map((th) => th.textContent);
  const celulas = Array.from(linha.querySelectorAll("td"));
  return {
    tabela,
    rotulos: celulas.slice(1).map((td) => td.getAttribute("data-rotulo")),
    colunas: cabecalhos.slice(1),
    celulas: celulas.slice(1),
  };
}

describe("o ranking e Por canal no celular", () => {
  it.each(["pt-BR", "es"] as const)(
    "cada célula numérica leva o nome da coluna no data-rotulo (%s)",
    async (lingua) => {
      idioma = lingua;
      try {
        montarPainel();
        await screen.findByText("Ana Ranking");
        await screen.findByText("Loja Centro");

        const ranking = rotulosEColunas("Ana Ranking");
        const canais = rotulosEColunas("Loja Centro");

        // O rótulo é o cabeçalho da coluna, palavra por palavra — e existe.
        expect(ranking.rotulos).toEqual(ranking.colunas);
        expect(ranking.rotulos).toHaveLength(4);
        expect(canais.rotulos).toEqual(canais.colunas);
        expect(canais.rotulos).toHaveLength(3);

        // E sai de `t()`: em espanhol é o texto do dicionário, não o português.
        const esperado =
          lingua === "es"
            ? {
                ranking: ["Ganados", "Perdidos", "Conversaciones", "1ª respuesta (promedio / mediana)"],
                canais: ["Conversaciones", "1ª respuesta (promedio)", "Sin respuesta"],
              }
            : {
                ranking: ["Ganhos", "Perdidos", "Conversas", "1ª resposta (média / mediana)"],
                canais: ["Conversas", "1ª resposta (média)", "Sem resposta"],
              };
        expect(ranking.rotulos).toEqual(esperado.ranking);
        expect(canais.rotulos).toEqual(esperado.canais);
      } finally {
        idioma = "pt-BR";
      }
    },
  );

  it("o cabeçalho some e a linha vira cartão SÓ abaixo de md (o computador fica igual)", async () => {
    montarPainel();
    await screen.findByText("Ana Ranking");
    await screen.findByText("Loja Centro");

    for (const nome of ["Ana Ranking", "Loja Centro"]) {
      const { tabela, celulas } = rotulosEColunas(nome);
      const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
      expect(classes(tabela.querySelector("thead")!), nome).toContain("max-md:hidden");
      expect(classes(tabela.querySelector("tbody tr")!), nome).toContain("max-md:grid");
      for (const td of celulas) {
        // O rótulo desenhado pelo CSS, e o alinhamento de número no computador.
        expect(classes(td)).toContain("max-md:before:content-[attr(data-rotulo)]");
        expect(classes(td)).toContain("text-right");
      }
      // Nenhuma classe de cartão vaza para o computador: tudo que o cartão
      // acrescenta mora atrás de `max-md:`.
      const doCartao = Array.from(tabela.querySelectorAll("*"))
        .concat(tabela)
        .flatMap(classes)
        .filter((c) => /^(block|hidden|grid|grid-cols-2|col-span-2)$/.test(c));
      expect(doCartao, nome).toEqual([]);
    }
    expect(within(document.body).queryByText("Erro ao carregar os canais.")).toBeNull();
  });
});
