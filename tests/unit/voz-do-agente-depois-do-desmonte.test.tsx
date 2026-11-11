/**
 * O CARTÃO DE VOZ NÃO ESCREVE ESTADO DEPOIS DO DESMONTE (#4228).
 *
 * ─── O vermelho que não vem de teste quebrado ───────────────────────────────
 *
 * `carregar` pede `GET /api/v1/ai/voz` no `useEffect` de montagem e, na volta,
 * faz `setVozDaOrg`/`setVozes` e `setCarregando(false)` no `finally` — sem
 * nenhuma guarda de montagem. Quem sai da tela do agente (ou do editor) antes de
 * a rota responder deixa a resposta chegando num componente que não existe
 * mais. O React despacha a atualização de qualquer jeito, e `dispatchSetState`
 * lê `window.event` (react-dom, `resolveUpdatePriority`) para escolher a
 * prioridade:
 *
 *     ReferenceError: window is not defined
 *         at resolveUpdatePriority (react-dom-client.development.js)
 *         at dispatchSetState (...)
 *
 * No vitest o fim do arquivo desfaz o jsdom; a resposta que chega depois cai
 * nesse ambiente sem `window`, vira **Unhandled Rejection** e o processo sai 1
 * com TODOS os testes verdes — foi assim que `verify-parte (2)` do #4447 e o
 * `verify-parte (3)` do #4439 reprovaram.
 *
 * ─── Por que o teste remove o `window` ─────────────────────────────────────
 *
 * Esperar o teardown de verdade tornaria o caso refém do relógio do runner (o
 * mesmo fetch ora chega antes, ora depois). Aqui o estado do FIM do arquivo é
 * reproduzido no ponto em que importa: componente desmontado, global sem
 * `window`, resposta chegando. É o mesmo caminho de produção — navegar antes da
 * resposta —, só que com o ambiente no estado que o CI tinha.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VozDoAgente } from "@/app/app/ai/agents/[id]/_components/VozDoAgente";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const AGENTE = "44444444-4444-4444-8444-444444444444";

/** A resposta da rota fica pendente até o teste mandar — é a corrida do defeito. */
function respostaSobControle() {
  let responder!: (valor: unknown) => void;
  api.get.mockImplementation(
    () =>
      new Promise((resolver) => {
        responder = resolver;
      }),
  );
  return (valor: unknown) => responder(valor);
}

function montar() {
  return render(
    <IdiomaProvider locale="pt-BR">
      <VozDoAgente agentId={AGENTE} />
    </IdiomaProvider>,
  );
}

const janelaDoTeste = globalThis.window;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Se algum caso falhar no meio, o global volta ao lugar de qualquer forma.
  if (!("window" in globalThis) && janelaDoTeste) {
    Object.defineProperty(globalThis, "window", { value: janelaDoTeste, configurable: true, writable: true });
  }
});

describe("cartão 'Voz deste agente' depois do desmonte", () => {
  it("resposta que chega depois do desmonte não escreve estado num ambiente sem window", async () => {
    const responder = respostaSobControle();
    const { unmount } = montar();

    // A pessoa sai da tela antes de /api/v1/ai/voz responder.
    unmount();

    // O ambiente do fim do arquivo: jsdom desfeito, `window` não existe mais.
    delete (globalThis as { window?: unknown }).window;
    expect("window" in globalThis).toBe(false);

    try {
      responder({ data: { voiceId: "voz-da-org", vozesDisponiveis: ["voz-a", "voz-b"] } });
      // Um tique de macrotarefa: é o tempo de a promessa continuar e o React
      // tentar despachar. Sem a guarda, o ReferenceError sai daqui e o vitest
      // reprova o arquivo por rejeição não tratada.
      await new Promise((resolver) => setTimeout(resolver, 0));
    } finally {
      Object.defineProperty(globalThis, "window", { value: janelaDoTeste, configurable: true, writable: true });
    }

    expect(globalThis.window).toBe(janelaDoTeste);
  });

  it("a resposta que chega ANTES do desmonte continua preenchendo o cartão", async () => {
    const responder = respostaSobControle();
    const { unmount } = montar();

    responder({ data: { voiceId: "voz-da-org", vozesDisponiveis: ["voz-a"] } });
    await act(async () => {
      await new Promise((resolver) => setTimeout(resolver, 0));
    });

    // O caminho normal segue valendo: carregou, mostrou o seletor.
    expect(document.querySelector('[data-testid="voz-do-agente"]')).not.toBeNull();

    unmount();
  });
});
