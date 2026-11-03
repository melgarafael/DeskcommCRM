import { beforeEach, describe, expect, it, vi } from "vitest";

const rejectCall = vi.fn();
const sendMessage = vi.fn();
vi.mock("@/lib/waha/client", () => ({
  getWahaClient: () => ({ rejectCall, sendMessage }),
}));

import {
  bloqueioDeChamadasLigado,
  comBloqueioDeChamadas,
  comMensagemDeRecusaDeChamadas,
  mensagemDeRecusaDeChamadas,
} from "@/lib/organizacao/bloqueio-de-chamadas";
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

describe("bloqueio de chamadas recebidas — a mensagem", () => {
  it("ausente, vazia, só espaços ou não-texto é nenhuma mensagem", () => {
    expect(mensagemDeRecusaDeChamadas(null)).toBeNull();
    expect(mensagemDeRecusaDeChamadas({ calls: { block_incoming: true } })).toBeNull();
    expect(mensagemDeRecusaDeChamadas({ calls: { reject_message: "   " } })).toBeNull();
    expect(mensagemDeRecusaDeChamadas({ calls: { reject_message: 42 } })).toBeNull();
    expect(mensagemDeRecusaDeChamadas({ calls: { reject_message: " Oi " } })).toBe("Oi");
  });

  it("gravar preserva o resto e mensagem vazia apaga a chave", () => {
    const base = { plan: "pro", calls: { block_incoming: true } };
    const com = comMensagemDeRecusaDeChamadas(base, "  Escreva aqui  ");
    expect(com).toEqual({ plan: "pro", calls: { block_incoming: true, reject_message: "Escreva aqui" } });
    expect(comMensagemDeRecusaDeChamadas(com, "")).toEqual(base);
  });
});

describe("call.received", () => {
  beforeEach(() => {
    // Chaves: `mockReset()` devolve o próprio mock, e o Vitest chamaria o retorno
    // de um `beforeEach` como limpeza — rodando `rejectCall` depois do teste.
    rejectCall.mockReset();
    sendMessage.mockReset();
  });

  it("com mensagem configurada, avisa quem ligou depois de recusar", async () => {
    rejectCall.mockResolvedValue(undefined);
    sendMessage.mockResolvedValue({});
    const settings = { calls: { block_incoming: true, reject_message: "Escreva, por favor." } };
    const ligacao = { ...LIGACAO, payload: { ...LIGACAO.payload, from: "5511911111111@c.us" } };
    await dispatchWahaEvent(adminCom(settings), SESSAO, ligacao, "r1");
    expect(sendMessage).toHaveBeenCalledWith("sessao-1", "5511911111111@c.us", "Escreva, por favor.");
    // Quem insiste em ligar não recebe o mesmo texto de novo.
    await dispatchWahaEvent(adminCom(settings), SESSAO, ligacao, "r2");
    expect(rejectCall).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sem mensagem, só recusa", async () => {
    rejectCall.mockResolvedValue(undefined);
    const ligacao = { ...LIGACAO, payload: { ...LIGACAO.payload, from: "5511922222222@c.us" } };
    await dispatchWahaEvent(adminCom({ calls: { block_incoming: true } }), SESSAO, ligacao, "r1");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("bloqueio desligado não manda mensagem, mesmo com texto salvo", async () => {
    const ligacao = { ...LIGACAO, payload: { ...LIGACAO.payload, from: "5511933333333@c.us" } };
    await dispatchWahaEvent(adminCom({ calls: { reject_message: "Oi" } }), SESSAO, ligacao, "r1");
    expect(rejectCall).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("falha ao avisar não lança e libera nova tentativa", async () => {
    rejectCall.mockResolvedValue(undefined);
    sendMessage.mockRejectedValueOnce(new Error("waha_500")).mockResolvedValue({});
    const settings = { calls: { block_incoming: true, reject_message: "Oi" } };
    const ligacao = { ...LIGACAO, payload: { ...LIGACAO.payload, from: "5511944444444@c.us" } };
    await expect(dispatchWahaEvent(adminCom(settings), SESSAO, ligacao, "r1")).resolves.toBeUndefined();
    await dispatchWahaEvent(adminCom(settings), SESSAO, ligacao, "r2");
    expect(sendMessage).toHaveBeenCalledTimes(2);
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
