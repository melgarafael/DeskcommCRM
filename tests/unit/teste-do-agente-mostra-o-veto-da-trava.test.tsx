/**
 * #4592 — O VETO DA TRAVA APARECE NA TELA DO TESTE, COM O CÓDIGO.
 *
 * O defeito medido: quando uma verificação de envio barrava a resposta, o
 * código da trava (`case_promise_without_case`, por exemplo) só existia em
 * `impediments` na resposta da API. No painel sobrava a frase do veto — e quem
 * testa não distinguia "o agente errou a frase" de "a trava cortou uma frase que
 * o agente escreveu de propósito". Essa confusão levava a ajustar prompt por
 * causa de um veto do código.
 *
 * O que este arquivo prova: um turno com `impediments` desenha o bloco de veto
 * no CARD daquele turno, com o código da trava em destaque e a frase que separa
 * o erro do agente do corte da trava.
 *
 * O que NÃO é medido aqui: o motor (a marcação do caso simulado em
 * `lib/agent-engine/agent/preview.ts` tem teste próprio, em `preview.test.ts`)
 * nem a rota. `apiClient` é dublê — o alvo é o que a tela MOSTRA.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
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

import { TestPanel } from "@/app/app/ai/agents/[id]/_components/TestPanel";

const AGENTE_ROW = { id: AGENTE, name: "Sofia", published_version_id: null } as never;

const MENSAGEM_DO_VETO =
  "Você prometeu envolver um humano mas não abriu um caso. Chame a tool open_human_case " +
  "(descrevendo o que precisa) OU reformule a mensagem sem prometer humano.";

function abrir() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TestPanel agent={AGENTE_ROW} draft={null} published={VERSAO} />
    </QueryClientProvider>,
  );
}

describe("Testar agente — o veto da trava tem nome na tela (#4592)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mostra o código da trava e separa 'o agente errou' de 'a trava cortou'", async () => {
    api.post.mockResolvedValueOnce({
      data: {
        run_id: "run-veto",
        status: "blocked",
        final_text: "",
        latency_ms: 900,
        candidates: [],
        proposals: [{ tool: "open_human_case", arguments: { title: "t", summary: "s", blocker: "b" } }],
        ferramentas: [{ nome: "open_human_case", estado: "ok", erro: null, duracao_ms: 3 }],
        impediments: [{ code: "case_promise_without_case", message: MENSAGEM_DO_VETO }],
        warnings: [],
        restrictions: [],
      },
    });

    abrir();
    fireEvent.change(screen.getByLabelText(/mensagem do cliente/i), {
      target: { value: "meu voo foi cancelado, e agora?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /executar teste/i }));

    const bloco = await screen.findByTestId("teste-vetos-1");
    expect(bloco).toBeInTheDocument();
    // O código da trava é o que permite procurar a regra no código/API.
    expect(bloco.textContent).toContain("case_promise_without_case");
    // A explicação que separa o veto do erro do agente.
    expect(bloco.textContent).toContain("Vetado pela trava antes de enviar");
    expect(bloco.textContent).toContain("o texto não chegaria ao cliente");
    // A frase de ensino continua visível: é ela que diz o que fazer.
    expect(bloco.textContent).toContain("open_human_case");
    // E aparece UMA vez, no card do turno — a lista do resumo não a repete.
    const naTela = (document.body.textContent ?? "").split(MENSAGEM_DO_VETO).length - 1;
    expect(naTela).toBe(1);
  });
});
