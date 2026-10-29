/**
 * O ENCAMINHAMENTO NÃO DUPLICA NO SEGUNDO CLIQUE, E O TOAST DIZ A VERDADE.
 *
 * ─── O que se mediu na tela, e o que este teste trava ───────────────────────
 *
 * Dois defeitos do MESMO hook, vistos operando de verdade:
 *
 *  1. **Duplo clique encaminhava duas vezes.** O mesmo POST voltava 201 duas
 *     vezes, com 10 ms de diferença, e nasciam duas linhas com o mesmo
 *     `forwarded_from_message_id` (e duas bolhas no destino). A causa é a chave
 *     de idempotência: `apiClient.post` SORTEIA uma chave nova quando nenhuma
 *     vem (`lib/api/client.ts`), então o `comIdempotencia` da rota nunca via a
 *     repetição. O `disabled={isPending}` da tela não cobre isso — o estado de
 *     pendência só pinta o botão DEPOIS do segundo clique.
 *
 *  2. **O toast dizia "Mensagem encaminhada." quando o envio falhou.** Sem canal
 *     conectado, toda resposta do forward voltou 201 com `status: "failed"` e
 *     `error_code: "waha_error"` — e a tela dava sucesso verde e fechava o
 *     diálogo. Não é do ambiente de quem testou: canal caído, sessão expirada
 *     ou número banido produzem a mesma resposta.
 *
 * O caminho é o REAL: o hook de produção, com `apiClient` mockado só no fio
 * (o que sairia na rede está nas chaves e nos argumentos das chamadas).
 *
 * A sabotagem que o caso do duplo clique pega: tirar a chave estável do hook
 * (voltar a chamar `post` sem `idempotencyKey`) deixa o 1º caso VERMELHO. A que
 * o caso da falha pega: devolver o toast de sucesso para `status: "failed"`
 * deixa o 5º VERMELHO.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useEncaminharMensagem } from "@/hooks/inbox/useEncaminharMensagem";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { post } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

const MSG = "22222222-2222-4222-8222-222222222222";
const DESTINO_A = "44444444-4444-4444-8444-444444444444";
const DESTINO_B = "55555555-5555-4555-8555-555555555555";

const qc = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** A chave que a N-ésima chamada levou no `Idempotency-Key`. */
function chaveDa(n: number): string {
  return (post.mock.calls[n]?.[2] as { idempotencyKey?: string } | undefined)?.idempotencyKey ?? "";
}

const vars = { id: MSG, conversationIdDestino: DESTINO_A };

beforeEach(() => {
  post.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("encaminhar: a chave de idempotência é estável POR INTENÇÃO", () => {
  it("o segundo clique de um duplo clique não vira um segundo POST", async () => {
    let responder!: (valor: unknown) => void;
    post.mockImplementation(() => new Promise((resolve) => (responder = resolve)));

    const { result } = renderHook(() => useEncaminharMensagem(), { wrapper });

    await act(async () => {
      result.current.mutate(vars);
      result.current.mutate(vars);
      await Promise.resolve();
    });

    // UM POST, e ele levou chave: é a mesma intenção (mensagem + destino).
    expect(post).toHaveBeenCalledTimes(1);
    expect(chaveDa(0)).toBeTruthy();

    await act(async () => {
      responder({ data: { status: "sent" } });
    });

    // A barreira é da intenção EM VOO, não um cadeado: concluído o primeiro, um
    // encaminhamento deliberado (mesma mensagem, mesmo destino) sai de novo.
    post.mockResolvedValue({ data: { status: "sent" } });
    await act(async () => {
      result.current.mutate(vars);
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("repetir a MESMA intenção depois de uma falha reusa a chave (retentativa idempotente)", async () => {
    post.mockRejectedValueOnce(new Error("rede caiu"));
    const { result } = renderHook(() => useEncaminharMensagem(), { wrapper });

    await act(async () => {
      result.current.mutate(vars);
    });
    post.mockResolvedValueOnce({ data: { status: "sent" } });
    await act(async () => {
      result.current.mutate(vars);
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(chaveDa(0)).toBeTruthy();
    // A primeira tentativa pode ter CHEGADO ao servidor: repetir com a mesma
    // chave é o que faz o `comIdempotencia` da rota reconhecer a repetição.
    expect(chaveDa(1)).toBe(chaveDa(0));
  });

  it("trocar o DESTINO depois de uma falha NÃO reusa a chave (seria conflito no servidor)", async () => {
    post.mockRejectedValueOnce(new Error("rede caiu"));
    const { result } = renderHook(() => useEncaminharMensagem(), { wrapper });

    await act(async () => {
      result.current.mutate(vars);
    });
    post.mockResolvedValueOnce({ data: { status: "sent" } });
    await act(async () => {
      result.current.mutate({ id: MSG, conversationIdDestino: DESTINO_B });
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(chaveDa(1)).not.toBe(""); 
    expect(chaveDa(1)).not.toBe(chaveDa(0));
  });

  it("diálogo fechado zera a intenção: a mesma dupla ganha chave nova", async () => {
    post.mockResolvedValue({ data: { status: "sent" } });
    const { result } = renderHook(() => useEncaminharMensagem(), { wrapper });

    await act(async () => {
      result.current.mutate(vars);
    });
    await act(async () => {
      result.current.limparIntencao();
    });
    await act(async () => {
      result.current.mutate(vars);
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(chaveDa(1)).not.toBe(chaveDa(0));
  });
});

describe("encaminhar: o toast diz a verdade sobre o desfecho", () => {
  it("envio FALHOU (201 com status failed): toast de erro com o motivo, sem toast verde", async () => {
    post.mockResolvedValueOnce({
      data: { status: "failed", error_code: "waha_error", error_message: null },
    });
    const { result } = renderHook(() => useEncaminharMensagem(), { wrapper });

    await act(async () => {
      result.current.mutate(vars);
    });

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0]).toBe(
      "Não foi possível encaminhar: Não conseguimos falar com o serviço de WhatsApp. Confira se ele está no ar.",
    );
  });

  // Revisão deliberada do #2835 ("o motivo gravado pelo envio vence o código do
  // adaptador"): o texto gravado pode ser o cru do transporte, com endereço
  // interno. Agora a frase NOSSA do código vence o texto gravado — e a de canal
  // excluído, na conversa, não fala de automação. O texto gravado só aparece
  // quando nenhuma frase conhece o código (ver `lib/inbox/motivo-da-falha.ts`).
  it("a frase nossa do código vence o texto gravado, sem falar de automação", async () => {
    post.mockResolvedValueOnce({
      data: {
        status: "failed", error_code: "channel_archived",
        error_message: "texto que o envio gravou",
      },
    });
    const { result } = renderHook(() => useEncaminharMensagem(), { wrapper });

    await act(async () => {
      result.current.mutate(vars);
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0]).toBe(
      "Não foi possível encaminhar: Este número foi excluído da Central de Conexões.",
    );
    expect(toastError.mock.calls[0]![0]).not.toContain("automação");
  });

  // O texto livre do TRANSPORTE pode trazer o endereço interno do serviço: com
  // frase própria no código, vale a frase; sem ela, a genérica.
  it.each([
    ["waha_error", "Não foi possível encaminhar: Não conseguimos falar com o serviço de WhatsApp. Confira se ele está no ar."],
    ["codigo_sem_frase", "Não foi possível encaminhar: Não foi possível enviar esta mensagem."],
  ])("o texto cru do canal não chega ao toast (%s)", async (error_code, esperado) => {
    post.mockResolvedValueOnce({
      data: {
        status: "failed", error_code,
        error_message: "fetch failed http://servico-interno:3000/api/sendText",
      },
    });
    const { result } = renderHook(() => useEncaminharMensagem(), { wrapper });

    await act(async () => {
      result.current.mutate(vars);
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0]).toBe(esperado);
  });

  it("envio ENTREGUE: toast de sucesso, sem toast de erro", async () => {
    post.mockResolvedValueOnce({ data: { status: "sent" } });
    const { result } = renderHook(() => useEncaminharMensagem(), { wrapper });

    await act(async () => {
      result.current.mutate(vars);
    });

    expect(toastSuccess).toHaveBeenCalledWith("Mensagem encaminhada.");
    expect(toastError).not.toHaveBeenCalled();
  });
});
