import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reg = { pushManager: { getSubscription: vi.fn(), subscribe: vi.fn() } };
vi.mock("./permission", () => ({ getPermission: () => "granted", areAlertsEnabled: () => true }));
vi.mock("./service_worker", () => ({ ensureNotifyServiceWorker: async () => reg }));

import { syncPushSubscription } from "./push_client";

// Pública de 65 bytes (0x04 + 64), em base64url — o formato que o servidor entrega.
const bytes = (fill: number) => {
  const b = new Uint8Array(65).fill(fill);
  b[0] = 4;
  return b;
};
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function inscricao(chave: Uint8Array | null, endpoint: string) {
  return {
    options: { applicationServerKey: chave ? chave.buffer : null },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  };
}

describe("syncPushSubscription", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response("{}")
        : new Response(JSON.stringify({ data: { enabled: true, public_key: b64url(bytes(7)) } })),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const endpointDoPut = () => {
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    return put ? JSON.parse(String(put[1].body)).endpoint : null;
  };

  it("inscrição feita com a MESMA chave do servidor é reaproveitada", async () => {
    const atual = inscricao(bytes(7), "https://push/atual");
    reg.pushManager.getSubscription.mockResolvedValue(atual);

    await syncPushSubscription();

    expect(atual.unsubscribe).not.toHaveBeenCalled();
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(endpointDoPut()).toBe("https://push/atual");
  });

  it("inscrição feita com OUTRA chave é desfeita e refeita com a do servidor", async () => {
    // O par do servidor mudou (ex.: backup restaurado numa VPS nova sem o .env):
    // a inscrição antiga nunca mais recebe nada, e o navegador não avisa.
    const velha = inscricao(bytes(9), "https://push/velha");
    const nova = inscricao(bytes(7), "https://push/nova");
    reg.pushManager.getSubscription.mockResolvedValue(velha);
    reg.pushManager.subscribe.mockResolvedValue(nova);

    await syncPushSubscription();

    expect(velha.unsubscribe).toHaveBeenCalledTimes(1);
    const chavePedida = reg.pushManager.subscribe.mock.calls[0]?.[0]?.applicationServerKey;
    expect(Array.from(chavePedida as Uint8Array)).toEqual(Array.from(bytes(7)));
    expect(endpointDoPut()).toBe("https://push/nova");
  });

  it("navegador que não informa a chave da inscrição: reaproveita, sem refazer a cada abertura", async () => {
    const atual = inscricao(null, "https://push/atual");
    reg.pushManager.getSubscription.mockResolvedValue(atual);

    await syncPushSubscription();

    expect(atual.unsubscribe).not.toHaveBeenCalled();
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(endpointDoPut()).toBe("https://push/atual");
  });

  it("sem inscrição: inscreve com a chave do servidor", async () => {
    const nova = inscricao(bytes(7), "https://push/nova");
    reg.pushManager.getSubscription.mockResolvedValue(null);
    reg.pushManager.subscribe.mockResolvedValue(nova);

    await syncPushSubscription();

    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(endpointDoPut()).toBe("https://push/nova");
  });
});
