import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AvisoDeFontesIncompletas } from "@/app/app/ai/evolution/_client";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

/**
 * O PAINEL DE EVOLUÇÃO DIZ QUANDO UM NÚMERO É RECORTE OU FALHA (#5016).
 *
 * A rota lê cada fonte com o teto do PostgREST (1.000 linhas). Antes, bater o
 * teto ou falhar a leitura só ia para o log: a tela mostrava o recorte, ou o
 * zero, com cara de número exato. Agora a rota devolve `fontes_incompletas` e a
 * tela nomeia o bloco afetado — pelo nome que a pessoa vê na tela, nunca o da
 * tabela.
 */
function pinta(fontes: Array<{ fonte: string; motivo: "cortada" | "falhou" }>, locale = "pt-BR") {
  return render(
    <IdiomaProvider locale={locale}>
      <AvisoDeFontesIncompletas fontes={fontes} />
    </IdiomaProvider>,
  );
}

describe("AvisoDeFontesIncompletas", () => {
  it("leitura cortada e leitura que falhou: cada uma no seu aviso, pelo nome do bloco", () => {
    pinta([
      { fonte: "ai_router_decisions", motivo: "cortada" },
      { fonte: "llm_calls", motivo: "falhou" },
    ]);

    const cortadas = screen.getByTestId("evolution-fontes-cortadas");
    expect(cortadas.textContent).toContain("mais registros do que o painel consegue ler");
    expect(cortadas.textContent).toContain("Conversas encaminhadas");
    expect(cortadas.textContent).not.toContain("ai_router_decisions");

    const falharam = screen.getByTestId("evolution-fontes-falharam");
    expect(falharam.textContent).toContain("Não foi possível ler agora");
    expect(falharam.textContent).toContain("Custo da IA no período");
    expect(falharam.textContent).not.toContain("Conversas encaminhadas");
  });

  it("três tabelas do mesmo número aparecem como um bloco só", () => {
    pinta([
      { fonte: "messages", motivo: "falhou" },
      { fonte: "agent_inbox_items", motivo: "falhou" },
      { fonte: "event_log", motivo: "falhou" },
    ]);

    const texto = screen.getByTestId("evolution-fontes-falharam").textContent ?? "";
    expect(texto.split("Casos que precisaram de uma pessoa")).toHaveLength(2);
  });

  it("nada cortado nem falho: nenhum aviso", () => {
    const { container } = pinta([]);
    expect(container.textContent).toBe("");
  });

  it("em espanhol, o aviso e os nomes dos blocos saem em espanhol", () => {
    pinta(
      [
        { fonte: "ai_router_decisions", motivo: "cortada" },
        { fonte: "llm_calls", motivo: "falhou" },
      ],
      "es",
    );

    expect(screen.getByTestId("evolution-fontes-cortadas").textContent).not.toContain(
      "mais registros do que o painel consegue ler",
    );
    expect(screen.getByTestId("evolution-fontes-falharam").textContent).toContain("Costo de la IA en el período");
  });
});
