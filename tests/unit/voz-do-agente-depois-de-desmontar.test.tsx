/**
 * A VOZ DO AGENTE NÃO MEXE EM ESTADO DEPOIS QUE A TELA SAIU.
 *
 * ─── O que derrubou o `verify` da release 1.108.0 ───────────────────────────
 *
 * Job 130682891002 (run 43066540997, verify-parte 3): 523 arquivos e 5749 casos
 * verdes, e mesmo assim `Errors 1 error` —
 *
 *     Unhandled Rejection: ReferenceError: window is not defined
 *      ❯ resolveUpdatePriority react-dom-client.development.js:1498
 *      ❯ dispatchSetState …
 *      ❯ app/app/ai/agents/[id]/_components/VozDoAgente.tsx:71:7
 *     This error originated in "tests/unit/publicar-acende-depois-de-salvar-o-rascunho.test.tsx"
 *
 * O cartão busca `GET /api/v1/ai/voz` num efeito sem cancelamento. Quando a
 * resposta chega depois que a árvore desmontou e o jsdom foi derrubado, o
 * `setCarregando(false)` do `finally` chega ao React sem `window`, lança, e a
 * promessa do efeito (descartada com `void`) vira rejeição não tratada. Todo
 * teste que monta o `AgentForm` em edição monta este cartão — o vermelho era de
 * quem perdesse a corrida, não de um arquivo.
 *
 * ─── A sonda ────────────────────────────────────────────────────────────────
 *
 * Reproduz a ordem do CI: desmonta com o GET pendente, tira o `window` (o que o
 * teardown do ambiente faz), resolve o GET e conta as rejeições não tratadas.
 * Sem o cancelamento, o setState pós-desmontagem lança exatamente o erro do log.
 */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const rede = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: rede }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { VozDoAgente } from "@/app/app/ai/agents/[id]/_components/VozDoAgente";

function adiada<T>() {
  let resolver!: (v: T) => void;
  let rejeitar!: (e: unknown) => void;
  const promessa = new Promise<T>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

const janela = globalThis.window;
afterEach(() => {
  Reflect.set(globalThis, "window", janela);
});

async function respostaDepoisDeDesmontar(chegar: (g: ReturnType<typeof adiada<unknown>>) => void) {
  const get = adiada<unknown>();
  rede.get.mockReturnValueOnce(get.promessa);
  const rejeicoes: unknown[] = [];
  const coletar = (motivo: unknown) => rejeicoes.push(motivo);
  process.on("unhandledRejection", coletar);
  try {
    const { unmount } = render(<VozDoAgente agentId="44444444-4444-4444-8444-444444444444" />);
    expect(rede.get).toHaveBeenCalledWith("/api/v1/ai/voz");
    unmount();
    Reflect.deleteProperty(globalThis, "window");
    chegar(get);
    // Duas voltas de macrotarefa: o `finally` roda e o Node emite a rejeição.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off("unhandledRejection", coletar);
  }
  return rejeicoes;
}

describe("VozDoAgente depois de desmontar (verify da 1.108.0)", () => {
  it("resposta de sucesso que chega depois da desmontagem não vira rejeição não tratada", async () => {
    const rejeicoes = await respostaDepoisDeDesmontar((g) =>
      g.resolver({ data: { voiceId: "voz-org", vozesDisponiveis: ["voz-org", "outra"] } }),
    );
    expect(rejeicoes.map(String)).toEqual([]);
  });

  it("falha que chega depois da desmontagem também não", async () => {
    const rejeicoes = await respostaDepoisDeDesmontar((g) => g.rejeitar(new Error("rede caiu")));
    expect(rejeicoes.map(String)).toEqual([]);
  });
});
