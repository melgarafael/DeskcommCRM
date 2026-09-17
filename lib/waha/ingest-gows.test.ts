import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { dispatchWahaEvent } from "./ingest";
import { wahaPayloadSchema } from "./envelope";

const payload = {
  id: "false_70000000000001@lid_TEST", from: "70000000000001@lid",
  fromMe: false, body: "Mensagem de teste",
  _data: { Info: { Chat: "70000000000001@lid", Sender: "70000000000001@lid",
    SenderAlt: "551198765432@s.whatsapp.net", PushName: "Cliente teste",
    IsFromMe: false, IsGroup: false } },
};
describe("entrada GOWS até a resolução canônica do contato", () => {
  it("entrega telefone normalizado, LID, nome e tenant à RPC existente", async () => {
    // Interrompe na fronteira de banco: testa dispatch + contrato + normalização,
    // sem simular efeitos posteriores que não fazem parte desta identificação.
    const rpc = vi.fn().mockRejectedValue(new Error("fronteira observada"));
    await expect(dispatchWahaEvent({ rpc } as never,
      { id: "canal-teste", organization_id: "org-teste" } as never,
      { event: "message.any", session: "teste", payload: wahaPayloadSchema.parse(payload) },
      "requisicao-teste")).rejects.toThrow("fronteira observada");
    expect(rpc).toHaveBeenCalledWith("fn_upsert_wa_contact", {
      p_org: "org-teste", p_kind: "lid", p_phone: "+5511998765432",
      p_lid: "70000000000001", p_chat_id: "70000000000001@lid", p_notify: "Cliente teste",
    });
  });
  it.each(["SenderAlt", "Sender", "Chat", "PushName"])("rejeita %s não textual", (field) => {
    expect(wahaPayloadSchema.safeParse({ ...payload, _data: { Info: { ...payload._data.Info, [field]: 123 } } }).success).toBe(false);
  });
});
