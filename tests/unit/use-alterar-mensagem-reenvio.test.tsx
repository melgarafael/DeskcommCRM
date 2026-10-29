import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const post = vi.fn();
const showApiError = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { post: (...args: unknown[]) => post(...args) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: (e: unknown) => showApiError(e) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
const toastErro = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastErro(...a), success: vi.fn() } }));

import { useAlterarMensagem } from "@/hooks/inbox/useAlterarMensagem";

const conversa = "44444444-4444-4444-8444-444444444444";

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidar = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useAlterarMensagem(conversa), { wrapper });
  return { hook, invalidar };
}

async function reenviar(hook: ReturnType<typeof setup>["hook"]) {
  await act(async () => {
    await hook.result.current.reenviar.mutateAsync({ id: "m1", confirmado: false }).catch(() => undefined);
  });
}

afterEach(() => { post.mockReset(); showApiError.mockReset(); toastErro.mockReset(); });

describe("reenvio pela bolha: depois de uma recusa a bolha mostra o estado real", () => {
  it("recusa do servidor recarrega o fio (a bolha decidiu com o relógio do aparelho)", async () => {
    post.mockRejectedValueOnce(new ApiError(403, "reenvio_indisponivel", undefined, "r", "Esta mensagem não pode ser reenviada."));
    const { hook, invalidar } = setup();
    await reenviar(hook);
    expect(invalidar).toHaveBeenCalledWith({ queryKey: ["messages", conversa] });
    expect(showApiError).toHaveBeenCalledTimes(1);
  });

  it("'confirme antes' não vira toast de erro: quem responde é a confirmação da bolha", async () => {
    post.mockRejectedValueOnce(new ApiError(409, "confirmacao_necessaria", undefined, "r", "Confirme antes de enviar de novo."));
    const { hook } = setup();
    await reenviar(hook);
    expect(showApiError).not.toHaveBeenCalled();
  });
});

describe("reenvio que o canal recusou de novo", () => {
  it("a rota responde 200 com a linha em failed: a pessoa é avisada, com o motivo", async () => {
    post.mockResolvedValueOnce({ data: { status: "failed", error_code: "channel_disabled" } });
    const { hook } = setup();
    await reenviar(hook);
    expect(toastErro).toHaveBeenCalledTimes(1);
    const [titulo, opcoes] = toastErro.mock.calls[0] as [string, { description: string }];
    expect(titulo).toBe("A mensagem não saiu de novo.");
    expect(opcoes.description).not.toBe("");
    expect(showApiError).not.toHaveBeenCalled();
  });

  it("código sem frase cai na frase genérica, nunca no texto cru do canal", async () => {
    post.mockResolvedValueOnce({ data: { status: "failed", error_code: "codigo_novo" } });
    const { hook } = setup();
    await reenviar(hook);
    expect((toastErro.mock.calls[0] as [string, { description: string }])[1].description).toBe("Não foi possível enviar esta mensagem.");
  });

  it("texto cru do canal com endereço interno não chega ao aviso", async () => {
    post.mockResolvedValueOnce({ data: {
      status: "failed", error_code: "canal_x_error",
      error_message: "fetch failed http://servico-interno:3000/api/sendText",
    } });
    const { hook } = setup();
    await reenviar(hook);
    const descricao = (toastErro.mock.calls[0] as [string, { description: string }])[1].description;
    expect(descricao).toBe("Não foi possível enviar esta mensagem.");
  });

  it("frase nossa gravada no envio (organização suspensa) chega ao aviso", async () => {
    post.mockResolvedValueOnce({ data: {
      status: "failed", error_code: "org_suspensa",
      error_message: "Envio automático bloqueado: a organização está suspensa.",
    } });
    const { hook } = setup();
    await reenviar(hook);
    const descricao = (toastErro.mock.calls[0] as [string, { description: string }])[1].description;
    expect(descricao).toBe("Envio automático bloqueado: a organização está suspensa.");
  });

  it("reenvio aceito (queued/sent) não dispara aviso: a bolha muda sozinha", async () => {
    post.mockResolvedValueOnce({ data: { status: "queued", error_code: null } });
    const { hook } = setup();
    await reenviar(hook);
    expect(toastErro).not.toHaveBeenCalled();
  });
});
