/**
 * A RETOMADA DO CANAL NÃO ARMA UMA SEGUNDA RETOMADA.
 *
 * Num canal que ainda não entrou, `removeChannel` chama o callback do
 * `subscribe` com CLOSED de forma SÍNCRONA — medido contra o
 * `@supabase/realtime-js` 2.112.3 instalado (canal `joining` → `cb:CLOSED` antes
 * de a chamada retornar). O dublê abaixo reproduz exatamente isso.
 *
 * A retomada chamava `removeChannel(active)` com `active` ainda apontando o
 * canal velho: o CLOSED síncrono passava pela guarda `active !== novo` e armava
 * OUTRA retomada. Esse timer órfão disparava depois e derrubava o canal que já
 * tinha voltado saudável — uma janela em que o Realtime não entrega nada e
 * nenhum "reassinado" avisa a tela. O painel de chamada dependia disso para
 * saber que a ligação acabou.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Callback = (s: string) => void;
const mock = vi.hoisted(() => ({
  prepare: vi.fn(),
  channel: vi.fn(),
  remove: vi.fn(),
  callbacks: [] as Callback[],
}));

vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: mock.prepare,
  createClient: () => ({ channel: mock.channel, removeChannel: mock.remove }),
}));

import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mock.callbacks = [];
  mock.prepare.mockResolvedValue(undefined);
  mock.channel.mockImplementation(() => {
    const indice = mock.callbacks.length;
    const canal = {
      indice,
      on: vi.fn(() => canal),
      subscribe: vi.fn((cb: Callback) => {
        mock.callbacks[indice] = cb;
        return canal;
      }),
    };
    return canal;
  });
  // Calibrado contra a biblioteca real: remover dispara CLOSED antes de retornar.
  mock.remove.mockImplementation((canal: { indice: number }) => {
    mock.callbacks[canal.indice]?.("CLOSED");
    return Promise.resolve("ok");
  });
});

afterEach(() => vi.useRealTimers());

it("queda → retomada → canal saudável: nenhum segundo canal nasce depois", async () => {
  const entregas: unknown[] = [];
  const { unmount } = renderHook(() =>
    useRealtimeChannel({ name: "voice-calls", onChange: (p) => entregas.push(p) }),
  );
  await act(async () => {});
  expect(mock.channel).toHaveBeenCalledTimes(1);

  await act(async () => mock.callbacks[0]!("SUBSCRIBED"));
  await act(async () => mock.callbacks[0]!("CHANNEL_ERROR"));

  // 1 s de recuo: retomada — remove o velho, monta o novo.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(mock.channel).toHaveBeenCalledTimes(2);
  expect(mock.remove).toHaveBeenCalledTimes(1);

  await act(async () => mock.callbacks[1]!("SUBSCRIBED"));
  expect(entregas).toEqual([{ tipo: "reassinado" }]);

  // Um minuto de canal saudável: não pode aparecer terceiro canal nem remoção.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(mock.channel, "o timer órfão derrubou o canal saudável e remontou").toHaveBeenCalledTimes(2);
  expect(mock.remove).toHaveBeenCalledTimes(1);
  unmount();
});
