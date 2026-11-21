import { beforeEach, describe, expect, it, vi } from "vitest";

const rejectCall = vi.fn();
vi.mock("@/lib/waha/client", () => ({
  getWahaClient: () => ({ rejectCall }),
}));

import { bloqueioDeChamadasLigado, comBloqueioDeChamadas } from "@/lib/organizacao/bloqueio-de-chamadas";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

type Admin = Parameters<typeof dispatchWahaEvent>[0];

/** Um admin que só sabe responder `organizations.select("settings")`. */
function adminCom(settings: unknown, erro: string | null = null): Admin {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            erro ? { data: null, error: { message: erro } } : { data: { settings }, error: null },
        }),
      }),
    }),
  } as unknown as Admin;
}

const SESSAO = {
  id: "cs-1",
  organization_id: "org-1",
  waha_session_name: "sessao-1",
  is_warmup_complete: true,
  warmup_started_at: null,
};

const LIGACAO = {
  event: "call.received",
  session: "sessao-1",
  payload: { id: "call-1", from: "5531999999999@c.us", isVideo: false, isGroup: false },
};

describe("bloqueio de chamadas recebidas — a chave", () => {
  it("ausente, malformada ou diferente de true é desligado", () => {
    expect(bloqueioDeChamadasLigado(null)).toBe(false);
    expect(bloqueioDeChamadasLigado({})).toBe(false);
    expect(bloqueioDeChamadasLigado({ calls: { block_incoming: "true" } })).toBe(false);
    expect(bloqueioDeChamadasLigado({ calls: { block_incoming: true } })).toBe(true);
  });

  it("gravar preserva o resto de settings", () => {
    const novo = comBloqueioDeChamadas({ plan: "pro", calls: { outra: 1 } }, true);
    expect(novo).toEqual({ plan: "pro", calls: { outra: 1, block_incoming: true } });
  });
});

describe("call.received", () => {
  beforeEach(() => {
    // Chaves: `mockReset()` devolve o próprio mock, e o Vitest chamaria o retorno
    // de um `beforeEach` como limpeza — rodando `rejectCall` depois do teste.
    rejectCall.mockReset();
  });

  it("com o bloqueio ligado, recusa a chamada com o from e o id do evento", async () => {
    rejectCall.mockResolvedValue(undefined);
    await dispatchWahaEvent(adminCom({ calls: { block_incoming: true } }), SESSAO, LIGACAO, "r1");
    expect(rejectCall).toHaveBeenCalledWith("sessao-1", "5531999999999@c.us", "call-1");
  });

  it("desligado (o padrão), a chamada toca como antes", async () => {
    await dispatchWahaEvent(adminCom({}), SESSAO, LIGACAO, "r1");
    expect(rejectCall).not.toHaveBeenCalled();
  });

  it("chamada de grupo não é recusada", async () => {
    const grupo = { ...LIGACAO, payload: { ...LIGACAO.payload, isGroup: true } };
    await dispatchWahaEvent(adminCom({ calls: { block_incoming: true } }), SESSAO, grupo, "r1");
    expect(rejectCall).not.toHaveBeenCalled();
  });

  it("leitura da chave falhou: não recusa e não lança", async () => {
    await expect(
      dispatchWahaEvent(adminCom(null, "banco fora"), SESSAO, LIGACAO, "r1"),
    ).resolves.toBeUndefined();
    expect(rejectCall).not.toHaveBeenCalled();
  });

  it("WAHA recusou o pedido: não lança (o evento não pode ser reentregue)", async () => {
    rejectCall.mockImplementation(() => {
      throw new Error("waha_500");
    });
    let lancou: unknown = null;
    try {
      await dispatchWahaEvent(adminCom({ calls: { block_incoming: true } }), SESSAO, LIGACAO, "r1");
    } catch (e) {
      lancou = e;
    }
    expect(lancou).toBeNull();
    expect(rejectCall).toHaveBeenCalledTimes(1);
  });
});
