import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), eval: vi.fn() }));
vi.mock("@/lib/env", () => ({
  env: { UPSTASH_REDIS_REST_URL: "http://localhost:80", UPSTASH_REDIS_REST_TOKEN: "sintetico" },
}));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    set = mocks.set;
    get = mocks.get;
    eval = mocks.eval;
  },
}));
import { criarRecibosAuth } from "./recibo-auth";
beforeEach(() => vi.resetAllMocks());
describe("recibos Auth", () => {
  it("reserva independente para cada destinatário sem dados pessoais na chave", async () => {
    mocks.set.mockResolvedValue("OK");
    const recibos = criarRecibosAuth();
    await recibos.reservar("msg_1", 0, "teste@example.test codigo-secreto");
    await recibos.reservar("msg_1", 1, "teste@example.test codigo-secreto");
    const chaves = mocks.set.mock.calls.map((c) => c[0]);
    expect(chaves[0]).not.toBe(chaves[1]);
    expect(chaves.every((c) => /^auth-email:[a-f0-9]{64}$/.test(c))).toBe(true);
    expect(mocks.set.mock.calls[0]?.[2]).toEqual({ nx: true, ex: 600 });
  });
  it("reconhece entregue e ocupado sem sobrescrever recibo", async () => {
    mocks.set.mockResolvedValue(null);
    mocks.get.mockResolvedValueOnce("enviado").mockResolvedValueOnce("outro-dono");
    const recibos = criarRecibosAuth();
    expect((await recibos.reservar("msg_1", 0, "{}")).estado).toBe("enviado");
    expect((await recibos.reservar("msg_1", 0, "{}")).estado).toBe("ocupado");
    expect(mocks.eval).not.toHaveBeenCalled();
  });
  it("conclui por comparação de dono, com retenção de 24h", async () => {
    mocks.set.mockResolvedValue("OK");
    mocks.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const recibo = await criarRecibosAuth().reservar("msg_1", 0, "{}");
    await recibo.concluir();
    expect(mocks.eval.mock.calls[0]?.[0]).toContain("86400");
    expect(mocks.eval.mock.calls[0]?.[2]).toEqual([mocks.set.mock.calls[0]?.[1]]);
    await expect(recibo.concluir()).rejects.toThrow("recibo_perdido");
  });
  it("não cai para memória quando Redis recusa escrita", async () => {
    mocks.set.mockRejectedValue(new Error("fora"));
    await expect(criarRecibosAuth().reservar("msg_1", 0, "{}")).rejects.toThrow("fora");
  });
});
