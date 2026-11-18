import { describe, expect, it, vi } from "vitest";
import { agentePorRemetente, telefoneDoCanal } from "./sender-routing";
import { senderRoutesSchema, telefoneDoRemetente } from "@/lib/ai/agents/sender-routes";
import type { LoadedRouter } from "./router-config";

const interno = "11111111-1111-4111-8111-111111111111";
const publico = "22222222-2222-4222-8222-222222222222";
const router = {
  fallbackAgentId: publico,
  senderRoutes: [{ phone: "+5511999998888", agent_id: interno }],
} as LoadedRouter;
const input = { tenantId: "org-a", conversationId: "conv-a", channelSessionId: "canal-a" };

describe("roteamento determinístico por remetente", () => {
  it("normaliza apenas a apresentação, sem aproximar identidades", () => {
    expect(telefoneDoRemetente("+55 (11) 99999-8888")).toBe("+5511999998888");
    expect(telefoneDoRemetente("sou a secretaria +5511999998888")).toBeNull();
    expect(telefoneDoRemetente("5511999998888@lid")).toBeNull();
    expect(telefoneDoRemetente("551199998888")).not.toBe("+5511999998888");
  });
  it("recusa duplicatas após normalização e referências inválidas", () => {
    expect(
      senderRoutesSchema.safeParse([
        { phone: "+55 (11) 99999-8888", agent_id: interno },
        { phone: "+5511999998888", agent_id: publico },
      ]).success,
    ).toBe(false);
    expect(
      senderRoutesSchema.safeParse([{ phone: "+5511999998888", agent_id: "inventado" }]).success,
    ).toBe(false);
  });
  it("escolhe pelo chat que o canal gravou na entrada e filtra empresa e canal", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ external_id: "false_5511999998888@c.us_3EB0AA" }] });
    const out = await agentePorRemetente({ query }, input, router);
    expect(out.agentId).toBe(interno);
    expect(query.mock.calls[0]?.[1]).toEqual(["org-a", "conv-a", "canal-a"]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("ct.organization_id=cv.organization_id");
    expect(sql).toContain("not cv.is_group");
    expect(sql).toContain("m.direction='inbound'");
    expect(sql).toContain("m.sent_via='external_device'");
    // A ficha do contato não é identidade: quem atende edita o telefone dela.
    expect(sql).not.toContain("phone_number");
  });
  it("o telefone da ficha não escolhe agente: vale o chat da entrada", async () => {
    // Ficha com o número da rota, mas a mensagem veio de outro chat.
    const query = vi.fn().mockResolvedValue({
      rows: [{ phone_number: "+5511999998888", external_id: "false_5511888887777@c.us_3EB0BB" }],
    });
    const out = await agentePorRemetente({ query }, input, router);
    expect(out.agentId).toBeNull();
  });
  it("o chat sem o nono dígito é o mesmo número da rota", () => {
    expect(telefoneDoCanal("false_551199998888@c.us_3EB0CC")).toBe("+5511999998888");
    expect(telefoneDoCanal("false_5511999998888@s.whatsapp.net_3EB0CC")).toBe("+5511999998888");
  });
  it("chat sem telefone, id sem chat ou chat malformado não identifica ninguém", () => {
    for (const id of [
      "false_100000000000001@lid_3EB0DD",
      "3EB0DD",
      "false_5511999998888@g.us_3EB0DD",
      "false_+5511999998888@c.us_3EB0DD",
      null,
    ]) {
      expect(telefoneDoCanal(id), String(id)).toBeNull();
    }
  });
  it("sem entrada, número diferente ou nulo não seleciona o interno", async () => {
    for (const rows of [
      [],
      [{ external_id: "false_5511888887777@c.us_X" }],
      [{ external_id: null }],
      [{ external_id: "false_100000000000001@lid_X" }],
    ]) {
      const out = await agentePorRemetente(
        { query: vi.fn().mockResolvedValue({ rows }) },
        input,
        router,
      );
      expect(out.agentId).toBeNull();
      expect(out.reserved.has(interno)).toBe(true);
    }
  });
  it("falha fechada com configuração inválida ou fallback interno", async () => {
    const db = { query: vi.fn() };
    await expect(
      agentePorRemetente(db, input, { ...router, fallbackAgentId: interno }),
    ).rejects.toThrow("public_fallback");
    await expect(
      agentePorRemetente(db, input, { ...router, senderRoutes: "errado" }),
    ).rejects.toThrow("invalid");
    expect(db.query).not.toHaveBeenCalled();
  });
});
