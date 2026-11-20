/**
 * O envio de MÍDIA pelo inbox espera o servidor terminar (prova de tela do #4422).
 *
 * O servidor espera o WAHA até `TETO_DE_MIDIA_MS`. Com o prazo padrão de escrita
 * do `apiClient` (30s), o navegador desistia antes: o vídeo saía, mas a tela
 * convidava a reenviar, e o reenvio chegava em dobro ao cliente.
 *
 * Usa o `apiClient` DE VERDADE (só o `fetch` é dublê), com o relógio falso: o
 * que se mede é se a resposta lenta chega à tela, não qual opção foi passada.
 */
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PRAZO_DO_ENVIO_DE_MIDIA_MS, useSendMessage } from "@/hooks/inbox/useSendMessage";
import { TETO_DE_MIDIA_MS } from "@/lib/waha/teto-de-midia";

vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const conversa = "44444444-4444-4444-8444-444444444444";

/** Um servidor que responde 200 só depois de `atrasoMs` — e respeita o abort. */
function servidorQueDemora(atrasoMs: number) {
  return vi.fn((_url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => {
        resolve(
          new Response(JSON.stringify({ data: { id: "m1", conversation_id: conversa } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }, atrasoMs);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(init.signal?.reason);
      });
    }),
  );
}

async function enviarEsperando(entrada: Record<string, unknown>, atrasoMs: number) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", servidorQueDemora(atrasoMs));
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSendMessage(), { wrapper });
  let resultado: "enviou" | "desistiu" | null = null;
  act(() => {
    hook.result.current
      .mutateAsync({ conversation_id: conversa, ...entrada } as never)
      .then(() => { resultado = "enviou"; }, () => { resultado = "desistiu"; });
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(atrasoMs + 1_000); });
  return resultado;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("envio com mídia pelo inbox: o navegador espera o servidor", () => {
  it("o prazo do navegador fica acima do teto do servidor", () => {
    expect(PRAZO_DO_ENVIO_DE_MIDIA_MS).toBeGreaterThan(TETO_DE_MIDIA_MS);
  });

  it("vídeo cujo servidor responde no limite do teto chega como enviado, sem abort", async () => {
    const resultado = await enviarEsperando(
      {
        type: "video",
        media_storage_path: "org/conv/video.mp4",
        media_mime: "video/mp4",
        media_size_bytes: 40 * 1024 * 1024,
      },
      TETO_DE_MIDIA_MS,
    );
    expect(resultado, "o navegador desistiu antes do servidor e a tela convidaria a reenviar").toBe("enviou");
  });

  it("mídia por URL também espera", async () => {
    const resultado = await enviarEsperando(
      { type: "image", media_url: "https://exemplo.test/foto.jpg", media_mime: "image/jpeg" },
      40_000,
    );
    expect(resultado).toBe("enviou");
  });
});
