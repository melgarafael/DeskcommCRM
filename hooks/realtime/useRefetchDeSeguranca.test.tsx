import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRefetchDeSeguranca } from "./useRefetchDeSeguranca";

/**
 * ABA OCULTA NÃO CONFERE (issue #2235).
 *
 * O refetch de segurança roda em inbox, quadro e dossiê — as telas que ficam
 * abertas o dia inteiro. O intervalo disparava igual com a aba escondida, então
 * um inbox esquecido refazia conversas e mensagens a cada 45 s: ~160 refetches
 * por hora, cada um com payload de página, num produto que roda num Supabase
 * free (egress é cota).
 *
 * A guarda é a mesma convenção já usada por presença, voz, alertas e
 * `InterfaceRefresh`; o que a torna barata é a segunda metade — ao VOLTAR para
 * a aba, a conferência acontece NA HORA, então nada fica velho por causa da
 * pausa.
 */
let visibilidade: DocumentVisibilityState = "visible";

function definirVisibilidade(valor: DocumentVisibilityState) {
  visibilidade = valor;
  document.dispatchEvent(new Event("visibilitychange"));
}

function montar(intervaloMs = 1_000) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const refetch = vi.spyOn(qc, "refetchQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useRefetchDeSeguranca({
        queryKey: ["conversas"],
        assinatura: () => "x",
        ultimaEntrega: { current: null },
        intervaloMs,
      }),
    { wrapper },
  );
  return { hook, refetch };
}

const avancar = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  visibilidade = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilidade,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("o refetch de segurança respeita a aba oculta (issue #2235)", () => {
  it("com a aba visível, confere a cada intervalo", async () => {
    const { refetch } = montar();
    await avancar(3_000);
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("⭐ com a aba OCULTA, não confere — e nada é refeito às escondidas", async () => {
    const { refetch } = montar();
    definirVisibilidade("hidden");
    await avancar(10_000);
    expect(refetch, "a aba oculta voltou a refazer a página").not.toHaveBeenCalled();
  });

  it("⭐ ao VOLTAR para a aba, confere imediatamente — a pausa não deixa a tela velha", async () => {
    const { refetch } = montar();
    definirVisibilidade("hidden");
    await avancar(5_000);
    expect(refetch).not.toHaveBeenCalled();

    await act(async () => definirVisibilidade("visible"));
    expect(refetch, "a volta à aba não disparou a conferência imediata").toHaveBeenCalledTimes(1);

    await avancar(1_000);
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("desmontado, nem o intervalo nem a volta conferem mais", async () => {
    const { hook, refetch } = montar();
    await avancar(1_000);
    expect(refetch).toHaveBeenCalledTimes(1);

    hook.unmount();
    await avancar(5_000);
    await act(async () => definirVisibilidade("hidden"));
    await act(async () => definirVisibilidade("visible"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
