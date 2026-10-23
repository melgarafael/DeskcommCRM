import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { pedirInstalacao, usePedidoDeInstalacao } from "./pedido-de-instalacao";

function pedidoFalso() {
  const evento = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn().mockResolvedValue(undefined);
  Object.assign(evento, { prompt });
  return { evento, prompt };
}

describe("pedido de instalação do navegador", () => {
  it("guarda o pedido sem esconder a sugestão do próprio navegador, e o usa uma vez", async () => {
    const { result } = renderHook(() => usePedidoDeInstalacao());
    expect(result.current).toBe(false);
    const { evento, prompt } = pedidoFalso();
    act(() => {
      window.dispatchEvent(evento);
    });
    expect(evento.defaultPrevented).toBe(false);
    expect(result.current).toBe(true);
    await act(async () => {
      await pedirInstalacao();
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
  });

  it("depois de instalado, some", () => {
    const { result } = renderHook(() => usePedidoDeInstalacao());
    act(() => {
      window.dispatchEvent(pedidoFalso().evento);
    });
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(result.current).toBe(false);
  });
});
