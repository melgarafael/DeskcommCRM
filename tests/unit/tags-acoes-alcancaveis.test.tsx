/**
 * AS AÇÕES DAS ETIQUETAS ALCANÇÁVEIS NO CELULAR (ADR-0006, F4).
 *
 * O `Card` do painel tem `overflow-hidden`, e a `<table>` crua de seis colunas
 * passava da borda a 390px: Renomear, Juntar e Excluir eram cortados, sem barra
 * de rolagem. O conserto tem duas metades, e as duas são vigiadas aqui pelo
 * contrato das classes (o jsdom não aplica media query):
 *
 *   1. a tabela mora num invólucro `overflow-x-auto` DENTRO do Card — o que não
 *      couber rola em vez de sumir;
 *   2. abaixo de `md` saem as três colunas de contagem (Leads, Conversas e
 *      Regras), cabeçalho e célula juntos, para a tabela caber sem rolar.
 *
 * A geometria (o «Excluir» com `right <= 390`) é de
 * `tests/e2e/equipe-no-celular.spec.ts`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LinhaDeVocabulario } from "@/lib/schemas/tags";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PainelDeTags } from "@/app/app/settings/tags/_painel";

const VIP: LinhaDeVocabulario = {
  tag: "vip",
  uso_em_contatos: 3,
  uso_em_leads: 2,
  uso_em_conversas: 1,
  em_regras: 2,
  cor: null,
  descricao: null,
  no_vocabulario: true,
};

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PainelDeTags tags={[VIP]} idioma="pt-BR" />
    </QueryClientProvider>,
  );
}

describe("painel de etiquetas no celular", () => {
  it("a tabela rola dentro de um invólucro em vez de ser cortada pelo Card", () => {
    montar();
    const tabela = screen.getByRole("table");
    expect(tabela.parentElement).toHaveClass("overflow-x-auto");
    // O invólucro fica DENTRO do Card que corta, não fora dele.
    expect(tabela.parentElement?.parentElement).toHaveClass("overflow-hidden");
  });

  it("Leads, Conversas e Regras saem abaixo de md, cabeçalho e célula", () => {
    montar();
    for (const nome of ["Leads", "Conversas", "Regras de agente"]) {
      expect(screen.getByRole("columnheader", { name: nome })).toHaveClass("max-md:hidden");
    }
    const celulas = screen.getAllByRole("cell");
    // Etiqueta, Contatos e Ações ficam; as três do meio somem no celular.
    expect(celulas.map((c) => c.classList.contains("max-md:hidden"))).toEqual([
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(screen.getByRole("button", { name: "Excluir" })).toBeInTheDocument();
  });
});
