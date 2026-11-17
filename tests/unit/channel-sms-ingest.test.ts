import { beforeEach, describe, expect, it, vi } from "vitest";

const encontrarContatoPorTelefone = vi.fn();
const marcarConversaComMensagem = vi.fn();
const aplicarEfeitosPosEntrada = vi.fn();
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: (...a: unknown[]) => encontrarContatoPorTelefone(...a),
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: (...a: unknown[]) => marcarConversaComMensagem(...a),
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: (...a: unknown[]) => aplicarEfeitosPosEntrada(...a),
}));

import { ingerirSmsRecebido } from "@/lib/channels/sms/ingest";

const SMS = {
  externalId: "SM" + "b".repeat(32),
  contaId: "AC" + "0".repeat(32),
  de: "+14155550100",
  para: "+14155550199",
  texto: "STOP",
  quantidadeDeMidias: 0,
};

/** Admin falso que registra o que foi gravado em cada tabela. */
function adminFalso(opcoes: { erroDaMensagem?: { code: string; message: string } } = {}) {
  const gravado = { contacts: [] as unknown[], messages: [] as unknown[], conversations: [] as unknown[] };
  type Tabela = keyof typeof gravado;
  const rpc = vi.fn(async () => ({ data: "conv-1", error: null }));
  const from = vi.fn((tabela: string) => {
    const cadeia = {
      insert: (linha: unknown) => {
        gravado[tabela as Tabela].push(linha);
        return cadeia;
      },
      update: (linha: unknown) => {
        gravado[tabela as Tabela].push({ update: linha });
        return cadeia;
      },
      select: () => cadeia,
      eq: () => cadeia,
      single: async () => ({ data: { id: "contato-novo" }, error: null }),
      maybeSingle: async () =>
        tabela === "messages" && opcoes.erroDaMensagem
          ? { data: null, error: opcoes.erroDaMensagem }
          : { data: { id: "msg-1" }, error: null },
      then: (resolver: (v: unknown) => void) => resolver({ error: null }),
    };
    return cadeia;
  });
  return { admin: { from, rpc } as never, gravado, rpc };
}

const ENTRADA = { organizationId: "org-1", channelSessionId: "sess-1", sms: SMS };

describe("ingestão do SMS", () => {
  beforeEach(() => {
    encontrarContatoPorTelefone.mockReset();
    marcarConversaComMensagem.mockReset();
    aplicarEfeitosPosEntrada.mockReset();
  });

  it("contato novo nasce com origem sms e SEM afirmar que tem WhatsApp", async () => {
    encontrarContatoPorTelefone.mockResolvedValue(null);
    const { admin, gravado } = adminFalso();
    const r = await ingerirSmsRecebido(admin, ENTRADA);
    expect(r).toEqual({ status: "ingested", conversationId: "conv-1", messageId: "msg-1" });
    const contato = gravado.contacts[0] as Record<string, unknown>;
    expect(contato).toMatchObject({ organization_id: "org-1", phone_number: "+14155550100", source: "sms" });
    expect(contato).not.toHaveProperty("phone_whatsapp");
  });

  it("contato que já existe pelo telefone é reaproveitado, sem criar outro", async () => {
    encontrarContatoPorTelefone.mockResolvedValue({ id: "contato-do-whatsapp", phone_number: "+14155550100" });
    const { admin, gravado } = adminFalso();
    await ingerirSmsRecebido(admin, ENTRADA);
    expect(gravado.contacts).toHaveLength(0);
    expect((gravado.messages[0] as Record<string, unknown>).contact_id).toBe("contato-do-whatsapp");
  });

  it("a conversa é carimbada sms, e a mensagem entra com o id do fornecedor", async () => {
    encontrarContatoPorTelefone.mockResolvedValue({ id: "c1", phone_number: "+14155550100" });
    const { admin, gravado, rpc } = adminFalso();
    await ingerirSmsRecebido(admin, ENTRADA);
    expect(rpc).toHaveBeenCalledWith("fn_upsert_wa_conversation", { p_org: "org-1", p_contact: "c1", p_session: "sess-1" });
    expect(gravado.conversations).toContainEqual({ update: { channel: "sms" } });
    expect(gravado.messages[0]).toMatchObject({
      external_id: SMS.externalId,
      direction: "inbound",
      type: "text",
      body: "STOP",
      channel_session_id: "sess-1",
    });
  });

  it("o texto segue para o funil comum (STOP, negócio, agente) marcado como sms", async () => {
    encontrarContatoPorTelefone.mockResolvedValue({ id: "c1", phone_number: "+14155550100" });
    const { admin } = adminFalso();
    await ingerirSmsRecebido(admin, ENTRADA);
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ texto: "STOP", canal: "sms", origem: "sms_webhook", messageId: "msg-1" }),
    );
    expect(marcarConversaComMensagem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ canal: "sms" }));
  });

  it("o mesmo SMS entregue de novo é duplicata, sem efeitos em dobro", async () => {
    encontrarContatoPorTelefone.mockResolvedValue({ id: "c1", phone_number: "+14155550100" });
    const { admin } = adminFalso({ erroDaMensagem: { code: "23505", message: "duplicate" } });
    const r = await ingerirSmsRecebido(admin, ENTRADA);
    expect(r).toEqual({ status: "duplicate", conversationId: "conv-1" });
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });
});
