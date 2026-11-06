import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const osciladores: { frequency: number[] }[] = [];
const desconectadas = vi.fn();

class AudioContextDeTeste {
  currentTime = 0;
  destination = {};
  resume = async () => {};
  createOscillator() {
    const o = { frequency: [] as number[] };
    osciladores.push(o);
    return {
      frequency: { setValueAtTime: (hz: number) => o.frequency.push(hz) },
      connect: () => {},
      start: () => {},
      stop: () => {},
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
      disconnect: desconectadas,
    };
  }
}

describe("os sons da ligação", () => {
  beforeEach(() => {
    osciladores.length = 0;
    desconectadas.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("AudioContext", AudioContextDeTeste);
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("discando toca o toque brasileiro em ciclo e para quando mandam parar", async () => {
    const { tocarDiscando } = await import("./sons");
    const parar = tocarDiscando();
    const toques = () => osciladores.filter((o) => o.frequency[0] === 425).length;
    expect(toques()).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(toques()).toBe(2);
    parar();
    expect(desconectadas).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20000);
    expect(toques()).toBe(2);
  });

  it("recusou toca o sinal de ocupado", async () => {
    const { tocarRecusada } = await import("./sons");
    tocarRecusada();
    expect(osciladores.map((o) => o.frequency[0])).toEqual([425, 425, 425, 425, 425]);
  });

  it("atendeu sobe e encerrou desce", async () => {
    const { tocarAtendeu, tocarEncerrou } = await import("./sons");
    tocarAtendeu();
    expect(osciladores.map((o) => o.frequency[0])).toEqual([659, 880, 1175]);
    osciladores.length = 0;
    tocarEncerrou();
    expect(osciladores.map((o) => o.frequency[0])).toEqual([494, 330]);
  });
});
