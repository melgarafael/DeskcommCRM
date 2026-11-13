/**
 * O "TESTAR AGENTE" É UMA CONVERSA (#4424).
 *
 * Hoje cada disparo testa UMA mensagem: o painel faz `setResult(null)` e a
 * requisição leva só `{ sample_message }`. Quem configura o agente não consegue
 * ver objeção, mudança de assunto nem volta ao preço, porque a segunda
 * mensagem chega ao motor sem a primeira.
 *
 * Este arquivo cobra o comportamento que a fatia 1 entrega:
 *
 *   1. o segundo POST leva os turnos anteriores (cliente e IA) no corpo;
 *   2. a tela mostra os turnos em sequência — o primeiro não some quando o
 *      segundo chega —, com as ferramentas que a IA usou em cada um;
 *   3. "Recomeçar conversa" limpa o rascunho e o painel, e o turno seguinte
 *      volta a chegar sozinho ao motor.
 *
 * O que NÃO é medido aqui: o motor, o custo e o banco. `apiClient` é dublê — o
 * alvo é o que a tela MANDA e o que ela MOSTRA.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const AGENTE = "44444444-4444-4444-8444-444444444444";
const VERSAO = {
  id: "55555555-5555-4555-8555-555555555555",
  version_number: 3,
  status: "published",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  channel_session_id: null,
} as never;

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import {
  TestPanel,
  historicoDaConversa,
} from "@/app/app/ai/agents/[id]/_components/TestPanel";

const AGENTE_ROW = { id: AGENTE, name: "Sofia", published_version_id: null } as never;

function resposta(params: {
  runId: string;
  texto: string;
  ferramenta: string;
  proposta?: string;
}) {
  return {
    data: {
      run_id: params.runId,
      status: "ok",
      final_text: params.texto,
      latency_ms: 1234,
      candidates: [],
      tool_calls: params.proposta ? [{ tool: params.proposta, arguments: { etapa: "qualificado" } }] : [],
      proposals: params.proposta
        ? [{ tool: params.proposta, arguments: { etapa: "qualificado" } }]
        : [],
      ferramentas: [{ nome: params.ferramenta, estado: "ok", erro: null, duracao_ms: 42 }],
    },
  };
}

function abrir() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TestPanel agent={AGENTE_ROW} draft={null} published={VERSAO} />
    </QueryClientProvider>,
  );
}

function campoDaMensagem() {
  return screen.getByLabelText(/mensagem do cliente/i);
}

async function enviar(texto: string, rotulo: RegExp = /executar teste/i) {
  fireEvent.change(campoDaMensagem(), { target: { value: texto } });
  fireEvent.click(screen.getByRole("button", { name: rotulo }));
}

describe("Testar agente — a conversa continua entre os turnos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("o segundo turno leva o primeiro no corpo e a tela não perde o que já foi dito", async () => {
    api.post
      .mockResolvedValueOnce(
        resposta({
          runId: "run-1",
          texto: "O clareamento custa R$ 600.",
          ferramenta: "search_knowledge",
        }),
      )
      .mockResolvedValueOnce(
        resposta({
          runId: "run-2",
          texto: "São três sessões, uma por mês.",
          ferramenta: "crm_search_products",
          proposta: "save_lead_note",
        }),
      );

    abrir();
    await enviar("quanto custa o clareamento?");
    expect(await screen.findByText("O clareamento custa R$ 600.")).toBeInTheDocument();
    // A ferramenta que a IA usou no turno 1 aparece junto da resposta.
    expect(screen.getByText(/search_knowledge/)).toBeInTheDocument();

    await enviar("e quantas sessões são?", /enviar mensagem/i);
    expect(await screen.findByText("São três sessões, uma por mês.")).toBeInTheDocument();

    // 1) O payload do segundo disparo leva a conversa — não só a mensagem nova.
    const [, corpo] = api.post.mock.calls[1] as [string, Record<string, unknown>];
    expect(corpo.sample_message).toBe("e quantas sessões são?");
    expect(corpo.history).toEqual([
      { direction: "inbound", body: "quanto custa o clareamento?" },
      { direction: "outbound", body: "O clareamento custa R$ 600." },
    ]);

    // 2) A tela mantém os dois turnos, cada um com as suas ferramentas.
    expect(screen.getByText("quanto custa o clareamento?")).toBeInTheDocument();
    expect(screen.getByText("O clareamento custa R$ 600.")).toBeInTheDocument();
    expect(screen.getByTestId("teste-turno-1")).toBeInTheDocument();
    expect(screen.getByTestId("teste-turno-2")).toBeInTheDocument();
    expect(screen.getByText(/crm_search_products/)).toBeInTheDocument();
    // Ação proposta aparece marcada como não executada, pelo nome — no selo e,
    // com os argumentos, nos detalhes do turno.
    expect(screen.getAllByText("save_lead_note").length).toBeGreaterThan(0);
  });

  it("Recomeçar conversa zera o rascunho e o painel; o turno seguinte vai sem histórico", async () => {
    api.post
      .mockResolvedValueOnce(
        resposta({ runId: "run-1", texto: "Custa R$ 600.", ferramenta: "search_knowledge" }),
      )
      .mockResolvedValueOnce(resposta({ runId: "run-2", texto: "Oi!", ferramenta: "search_knowledge" }));

    abrir();
    await enviar("quanto custa?");
    expect(await screen.findByText("Custa R$ 600.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /recomeçar conversa/i }));

    expect(screen.queryByText("quanto custa?")).toBeNull();
    expect(screen.queryByText("Custa R$ 600.")).toBeNull();
    expect(screen.getByText("Nenhum teste executado ainda.")).toBeInTheDocument();

    // O rótulo volta a ser o do primeiro disparo e o corpo volta a não ter history.
    await enviar("oi de novo");
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    const [, corpo] = api.post.mock.calls[1] as [string, Record<string, unknown>];
    expect(corpo.sample_message).toBe("oi de novo");
    expect(corpo).not.toHaveProperty("history");
  });
});

describe("historicoDaConversa — os limites que a rota impõe", () => {
  it("recorta do fim: no máximo 30 mensagens, mantendo a conversa mais recente", () => {
    const turnos = Array.from({ length: 20 }, (_, i) => ({
      pergunta: `pergunta ${i}`,
      resultado: { final_text: `resposta ${i}` } as never,
    }));

    const historico = historicoDaConversa(turnos);

    expect(historico).toHaveLength(30);
    // 20 turnos = 40 mensagens; ficam os 15 turnos mais recentes.
    expect(historico[0]).toEqual({ direction: "inbound", body: "pergunta 5" });
    expect(historico.at(-1)).toEqual({ direction: "outbound", body: "resposta 19" });
  });

  it("não manda resposta vazia e trunca a mensagem que passar do teto por mensagem", () => {
    const historico = historicoDaConversa([
      { pergunta: "oi", resultado: { final_text: "   " } as never },
      { pergunta: "x".repeat(5000), resultado: { final_text: "ok" } as never },
    ]);

    expect(historico).toEqual([
      { direction: "inbound", body: "oi" },
      { direction: "inbound", body: "x".repeat(4000) },
      { direction: "outbound", body: "ok" },
    ]);
  });
});
