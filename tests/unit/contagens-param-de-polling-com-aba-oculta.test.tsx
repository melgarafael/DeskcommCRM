/**
 * #4325 (segunda fatia) — o cliente para de refazer as contagens às cegas.
 *
 * ─── O que estava medido na main ───────────────────────────────────────────
 *
 * `hooks/inbox/useConversationCounts.ts` agendava `refetchInterval: 30_000` em
 * toda tela do Inbox (o hook é montado pelo badge do menu, que vive no shell).
 * Com a aba do navegador em segundo plano o número não é lido por ninguém — mas
 * o intervalo seguia ARMADO, disparando a cada 30 s e dependendo do default do
 * React Query para não buscar.
 *
 * ─── A regra desta fatia ───────────────────────────────────────────────────
 *
 * O hook escuta `visibilitychange`: com o documento oculto o intervalo é
 * `false` (DESARMADO, não só "sem buscar"), e `refetchIntervalInBackground` é
 * declarado `false` para a garantia não depender de default de biblioteca. Ao
 * voltar, o intervalo é rearmado: o cliente da produção (`makeQueryClient`) tem
 * `refetchOnWindowFocus: false`, então nada sai na hora, e a próxima contagem
 * chega 30 s depois da volta.
 *
 * O que este teste mede é o NÚMERO DE REQUISIÇÕES, com relógio falso e com o
 * MESMO cliente da produção: um `QueryClient` montado à mão ligaria o refetch
 * por foco e provaria um caminho que a tela não percorre. 10 minutos de aba
 * oculta não podem produzir uma chamada sequer.
 */
import type { ReactNode } from "react";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const RESPOSTA = { data: { fila: 1, unassigned: 1, mine: 2, all: 3, closed: 71, archived: 29 } };

const h = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: h.get },
}));

import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";
import { makeQueryClient } from "@/lib/query/client";

function montar() {
  const queryClient = makeQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useConversationCounts(ORG), { wrapper });
}

/** Troca a visibilidade do documento como o navegador faz, e avisa quem escuta. */
function visibilidade(estado: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => estado,
  });
  // O navegador dispara em `document`; o React Query escuta em `window`. Os dois
  // recebem o mesmo evento, como no navegador de verdade.
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  h.get.mockReset();
  h.get.mockResolvedValue(RESPOSTA);
  vi.useFakeTimers();
  visibilidade("visible");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("#4325 — contagens com a aba do navegador oculta", () => {
  it("CONTROLE: visível, o intervalo continua de 30 s (2 requisições por minuto)", async () => {
    const { unmount } = montar();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.get).toHaveBeenCalledTimes(1); // a primeira carga

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // 1 (carga) + 2 (30 s e 60 s) — o polling que a tela já tinha, preservado.
    expect(h.get).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("oculta, o intervalo é DESARMADO: 10 minutos sem uma requisição", async () => {
    const { unmount } = montar();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const depoisDaCarga = h.get.mock.calls.length;

    await act(async () => {
      visibilidade("hidden");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    // O timer do intervalo não fica armado atrás de uma promessa de "não buscar":
    // é desarmado. A contagem sai DEPOIS dos 10 minutos porque o cliente da
    // produção arma dois timers de uso único (o `staleTime` de 30 s e o `gcTime`
    // de 5 min), que já dispararam; um `setInterval` vivo sobraria aqui.
    const armadosComAbaOculta = vi.getTimerCount();

    expect(h.get).toHaveBeenCalledTimes(depoisDaCarga);
    expect(armadosComAbaOculta).toBe(0);
    unmount();
  });

  it("ao voltar para a aba, nada sai na hora e a próxima contagem chega aos 30 s", async () => {
    const { unmount } = montar();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      visibilidade("hidden");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    const antesDeVoltar = h.get.mock.calls.length;

    await act(async () => {
      visibilidade("visible");
      await vi.advanceTimersByTimeAsync(0);
    });

    // Nenhuma chamada na hora: `refetchOnWindowFocus` é `false` no cliente da
    // produção, e a volta só rearma o intervalo.
    expect(h.get.mock.calls.length).toBe(antesDeVoltar);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(h.get.mock.calls.length).toBe(antesDeVoltar + 1);
    unmount();
  });
});
