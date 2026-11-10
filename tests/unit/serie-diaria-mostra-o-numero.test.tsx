// O NÚMERO DE CADA DIA DA SÉRIE DE ATIVIDADES APARECE ESCRITO NO CELULAR (ADR-0006, F4).
//
// A série diária de `/app/activities` é uma fileira de barras. Quanto aconteceu
// em cada dia morava só no `title` da barra — e `title` só aparece passando o
// MOUSE. No dedo não há hover, e a altura da barra sozinha não diz se foram 3 ou
// 30. O conserto escreve o número embaixo do dia e o esconde (`sr-only`) apenas
// onde há hover: no computador a tela fica como era, e o leitor de tela lê o
// número nos dois.
//
// Tirar o número, ou escondê-lo também no toque (`sr-only` puro), deixa vermelho.
//
// Na mesma tela, a linha do tempo: o link do negócio tem 44px de altura no
// celular (`max-md:min-h-11`), e o motivo, que perdeu o `truncate` no celular,
// quebra palavra longa (`max-md:wrap-anywhere`) em vez de alargar a tela.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RelatorioComJanela } from "@/hooks/reports/useActivityReport";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    className,
    children,
  }: {
    href: string;
    className?: string;
    children: React.ReactNode;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { ActivityReportClient } from "@/app/app/activities/_components/ActivityReportClient";
import { apiClient } from "@/lib/api/client";

const RELATORIO: RelatorioComJanela = {
  window: { from: "2026-10-20T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" },
  total: 17,
  resumo: { pessoas: 10, agentes: 5, automatico: 2 },
  atores: [],
  tipos: [],
  dias: [
    { data: "2026-10-20", rotulo: "20/10", quantidade: 4 },
    { data: "2026-10-21", rotulo: "21/10", quantidade: 0 },
    { data: "2026-10-22", rotulo: "22/10", quantidade: 13 },
  ],
  atividades: [],
  truncado: false,
  vocabulario: { lead: "Lead", deal: "Negócio", won: "Ganho", lost: "Perdido" },
};

describe("a série diária de Relatórios", () => {
  it("cada dia mostra a quantidade como texto, escondida só onde há hover", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: RELATORIO });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ActivityReportClient />
      </QueryClientProvider>,
    );

    const serie = await screen.findByTestId("serie-diaria");
    const barras = Array.from(serie.querySelectorAll<HTMLElement>("[data-dia]"));
    expect(barras).toHaveLength(3);

    const lidos = barras.map((barra) => {
      const coluna = barra.parentElement!;
      const numero = Array.from(coluna.querySelectorAll("span")).find(
        (s) => s.textContent === barra.dataset.quantidade,
      );
      return {
        dia: barra.dataset.dia,
        texto: numero?.textContent ?? null,
        classes: (numero?.getAttribute("class") ?? "").split(/\s+/),
      };
    });

    // O número do dia, inclusive o ZERO (dia parado também é resposta).
    expect(lidos.map((l) => [l.dia, l.texto])).toEqual([
      ["2026-10-20", "4"],
      ["2026-10-21", "0"],
      ["2026-10-22", "13"],
    ]);
    for (const l of lidos) {
      // Escondido só com hover: no toque ele aparece.
      expect(l.classes, l.dia).toContain("[@media(hover:hover)]:sr-only");
      expect(l.classes, l.dia).not.toContain("sr-only");
      expect(l.classes, l.dia).not.toContain("hidden");
    }
  });
});

describe("a linha do tempo de Atividades no celular", () => {
  it("o link do negócio tem 44px de altura e o motivo quebra palavra longa, só abaixo de md", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: {
        ...RELATORIO,
        atividades: [
          {
            id: "a1",
            type: "lead.lost",
            rotulo: "Perdido",
            quando: "2026-10-22T12:00:00.000Z",
            atorNome: "Ana",
            atorForma: "filled",
            motivo: "https://exemplo.com/um-link-sem-espaco-nenhum-que-passaria-da-tela",
            negocioId: "11111111-2222-3333-4444-555555555555",
            negocioTitulo: "Pedido da Ana",
            contatoId: null,
            contatoNome: null,
          },
        ],
      } satisfies RelatorioComJanela,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ActivityReportClient />
      </QueryClientProvider>,
    );

    const lista = await screen.findByTestId("lista-de-atividades");
    const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

    const link = lista.querySelector('a[href="/app/leads/11111111-2222-3333-4444-555555555555"]');
    expect(link?.textContent).toBe("Pedido da Ana");
    expect(classes(link)).toEqual(
      expect.arrayContaining(["max-md:inline-flex", "max-md:min-h-11", "max-md:items-center"]),
    );
    expect(classes(link).filter((c) => /min-h/.test(c) && !c.startsWith("max-md:"))).toEqual([]);

    const motivo = Array.from(lista.querySelectorAll("span")).find((s) =>
      s.textContent?.startsWith("https://exemplo.com/"),
    );
    expect(classes(motivo ?? null)).toEqual(
      expect.arrayContaining(["max-md:wrap-anywhere", "md:truncate"]),
    );
    expect(classes(motivo ?? null)).not.toContain("truncate");
  });
});
