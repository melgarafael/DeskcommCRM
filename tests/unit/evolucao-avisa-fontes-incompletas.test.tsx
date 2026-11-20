import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { EvolutionPayload, FonteIncompleta } from "@/lib/ai/evolution/aggregate";
import { aggregateEvolution } from "@/lib/ai/evolution/aggregate";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

/**
 * O PAINEL DE EVOLUÇÃO DIZ QUANDO UM NÚMERO É RECORTE OU FALHA (#5016).
 *
 * A rota lê cada fonte com o teto do PostgREST (1.000 linhas). Antes, bater o
 * teto ou falhar a leitura só ia para o log: a tela mostrava o recorte, ou o
 * zero, com cara de número exato. Agora a rota devolve `fontes_incompletas` e a
 * tela nomeia os blocos afetados — pelo nome que a pessoa vê na tela, nunca o da
 * tabela.
 *
 * Os casos rodam a PÁGINA (`EvolutionClient`) com o hook de dados trocado pelo
 * payload: tirar a faixa da página reprova, não só o componente isolado.
 */
const resposta = vi.hoisted(() => ({ atual: null as unknown }));
vi.mock("@/hooks/ai/useEvolution", () => ({
  useEvolution: () => ({ data: resposta.atual, error: null }),
}));

// Gráfico fora do jsdom: o que se mede aqui são os textos.
vi.mock("recharts", async (importOriginal) => {
  const real = await importOriginal<typeof import("recharts")>();
  return { ...real, ResponsiveContainer: () => null };
});

import { EvolutionClient } from "@/app/app/ai/evolution/_client";

const RANGE = { from: "2026-07-01", to: "2026-07-03" };

function payload(fontes: FonteIncompleta[], extra: { inbound?: number } = {}): EvolutionPayload {
  return aggregateEvolution({
    range: { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-03T00:00:00Z") },
    memoryEntries: [],
    proposalsApplied: [],
    skillInstalls: [],
    skillActivations: [],
    routerDecisions: [{ created_at: "2026-07-02T10:00:00.000Z", outcome: "classified", intent_name: "x", router_id: "r1" }],
    knowledgeSearches: [],
    stageTransitions: [],
    costCents: 0,
    inboundCount: extra.inbound ?? 10,
    handoffCount: 0,
    pipelines: [{ name: "Vendas", hints: ["new", "contacted", "qualifying", "qualified", "negotiating", "won", "lost"] }],
    fontesIncompletas: fontes,
  } as Parameters<typeof aggregateEvolution>[0]);
}

function pinta(fontes: FonteIncompleta[], opcoes: { locale?: string; inbound?: number } = {}) {
  resposta.atual = payload(fontes, opcoes);
  return render(
    <IdiomaProvider locale={opcoes.locale ?? "pt-BR"}>
      <EvolutionClient defaultRange={RANGE} />
    </IdiomaProvider>,
  );
}

beforeEach(() => {
  resposta.atual = null;
});

describe("Painel de Evolução — aviso de fontes incompletas (#5016)", () => {
  it("leitura cortada e leitura que falhou: cada uma no seu aviso, com todos os blocos afetados", () => {
    pinta([
      { fonte: "ai_router_decisions", motivo: "cortada" },
      { fonte: "llm_calls", motivo: "falhou" },
    ]);

    const cortadas = screen.getByTestId("evolution-fontes-cortadas");
    expect(cortadas.textContent).toContain("mais registros do que o painel consegue ler");
    // A tabela alimenta três blocos da tela: os três são nomeados.
    for (const bloco of ["Conversas encaminhadas", "Assuntos mais procurados", "O que está travando"]) {
      expect(cortadas.textContent).toContain(bloco);
    }
    expect(cortadas.textContent).toMatch(/encurte o período/i);
    // Logo abaixo do período analisado, antes dos blocos.
    const periodo = screen.getByText("Período analisado");
    const primeiroBloco = screen.getByTestId("bloco-aprendeu");
    expect(periodo.compareDocumentPosition(cortadas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cortadas.compareDocumentPosition(primeiroBloco) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cortadas.textContent).not.toContain("ai_router_decisions");

    const falharam = screen.getByTestId("evolution-fontes-falharam");
    expect(falharam.textContent).toContain("podem aparecer zerados ou incompletos");
    expect(falharam.textContent).toContain("Custo da IA no período");
    expect(falharam.textContent).not.toContain("Conversas encaminhadas");
  });

  it("três tabelas do mesmo número aparecem como um bloco só", () => {
    pinta([
      { fonte: "agent_inbox_items", motivo: "falhou" },
      { fonte: "event_log", motivo: "falhou" },
    ]);

    const texto = screen.getByTestId("evolution-fontes-falharam").textContent ?? "";
    expect(texto.split("Casos que precisaram de uma pessoa")).toHaveLength(2);
  });

  it("funil cortado não manda encurtar as datas — ele não depende delas", () => {
    pinta([{ fonte: "crm_stages", motivo: "cortada" }]);

    expect(screen.getByTestId("evolution-fontes-cortadas").textContent).not.toMatch(/encurte/i);
  });

  it("nada cortado nem falho: nenhum aviso, e a boa notícia continua", () => {
    pinta([]);

    expect(screen.queryByTestId("evolution-fontes-cortadas")).toBeNull();
    expect(screen.queryByTestId("evolution-fontes-falharam")).toBeNull();
    expect(screen.getByTestId("gaps-vazio")).toBeTruthy();
  });

  it("fonte das lacunas cortada: 'O que está travando' não diz que nada trava", () => {
    pinta([{ fonte: "ai_router_decisions", motivo: "cortada" }]);

    const bloco = screen.getByTestId("bloco-travando");
    expect(within(bloco).queryByTestId("gaps-vazio")).toBeNull();
    expect(within(bloco).getByTestId("gaps-incompleto").textContent).toContain("Não dá para dizer que nada está travando");
  });

  it("uma contagem da taxa de ajuda que falhou: o card não mostra número", () => {
    pinta([{ fonte: "agent_inbox_items", motivo: "falhou" }]);

    const resultado = screen.getByTestId("bloco-resultado").textContent ?? "";
    expect(resultado).toContain("Indisponível agora");
  });

  it("contagem de mensagens que falhou não vira 'não houve atendimento'", () => {
    pinta([{ fonte: "messages", motivo: "falhou" }], { inbound: 0 });

    expect(screen.getByTestId("bloco-resultado").textContent).not.toContain("Não houve atendimento neste período");
  });

  it("em espanhol, o aviso e os nomes dos blocos saem em espanhol", () => {
    pinta(
      [
        { fonte: "ai_router_decisions", motivo: "cortada" },
        { fonte: "llm_calls", motivo: "falhou" },
      ],
      { locale: "es" },
    );

    const cortadas = screen.getByTestId("evolution-fontes-cortadas").textContent ?? "";
    expect(cortadas).toContain("Este período tiene más registros");
    expect(cortadas).toContain("Conversaciones derivadas");
    expect(cortadas).toContain("Temas más buscados");
    expect(screen.getByTestId("evolution-fontes-falharam").textContent).toContain("Costo de la IA en el período");
  });
});
