import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const conexaoDeSms = vi.fn();
vi.mock("@/lib/channels/sms/credentials", () => ({ conexaoDeSms: (...a: unknown[]) => conexaoDeSms(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { capabilitiesOf, PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";
import { getAdapter } from "@/lib/channels";
import { channelBrand } from "@/lib/channels/presentation";
import { resolveSessionRef } from "@/lib/channels/session-ref";

// Montados em pedaços: o literal inteiro tem a forma de id real e o scanner
// de segredos do GitHub recusa o push. São falsos.
const CONTA = "AC" + "0123456789abcdef".repeat(2);
const NUMERO_ID = "PN" + "fedcba9876543210".repeat(2);
const CONEXAO = {
  channelSessionId: "sess-1",
  numeroId: NUMERO_ID,
  numero: "+14155550199",
  accountSid: CONTA,
  authToken: "chave_de_teste",
};

const ENVELOPE = {
  organizationId: "org-1",
  sessionRef: NUMERO_ID,
  to: "14155550100",
  kind: "text" as const,
  body: "Your estimate is ready",
};

function responder(status: number, corpo: unknown) {
  const f = vi.fn(async () => new Response(JSON.stringify(corpo), { status }));
  vi.stubGlobal("fetch", f);
  return f;
}

describe("adapter do SMS", () => {
  const adapter = getAdapter("twilio");

  beforeEach(() => {
    conexaoDeSms.mockReset();
    conexaoDeSms.mockResolvedValue(CONEXAO);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("está registrado e é canal por telefone", () => {
    expect(adapter.provider).toBe("twilio");
    expect((PROVIDERS_DE_TELEFONE as readonly string[]).includes("twilio")).toBe(true);
    expect(capabilitiesOf("twilio").costPerMessage).toBe(true);
    expect(capabilitiesOf("twilio").freeformOutsideWindow).toBe(true);
    expect(channelBrand({ provider: "twilio" })).toBe("sms");
    expect(resolveSessionRef({ provider: "twilio", twilio_phone_number_sid: NUMERO_ID })).toBe(NUMERO_ID);
  });

  it("endereça pelo telefone e recusa grupo", () => {
    const base = { groupChatId: null, waIdentity: null };
    expect(adapter.resolveRecipient({ ...base, isGroup: false, phoneNumber: "+1 (415) 555-0100" })).toBe("14155550100");
    expect(adapter.resolveRecipient({ ...base, isGroup: true, phoneNumber: "+14155550100" })).toBeNull();
    expect(adapter.resolveRecipient({ ...base, isGroup: false, phoneNumber: null })).toBeNull();
  });

  it("envia do número da conexão para o destino com +, e devolve o id do fornecedor", async () => {
    const f = responder(201, { sid: "SM" + "1".repeat(32) });
    const r = await adapter.send(ENVELOPE);
    expect(r).toEqual({ externalId: "SM" + "1".repeat(32) });
    expect(conexaoDeSms).toHaveBeenCalledWith(expect.anything(), { organizationId: "org-1", numeroId: NUMERO_ID });
    const form = new URLSearchParams(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(form.get("From")).toBe("+14155550199");
    expect(form.get("To")).toBe("+14155550100");
    expect(form.get("Body")).toBe("Your estimate is ready");
  });

  it("chama o beforeSend antes de sair", async () => {
    responder(201, { sid: "SM" + "2".repeat(32) });
    const ordem: string[] = [];
    await adapter.send({ ...ENVELOPE, beforeSend: async () => void ordem.push("antes") });
    expect(ordem).toEqual(["antes"]);
  });

  it("sem conta conectada é notConfigured (fica na fila), sem chamar o fornecedor", async () => {
    conexaoDeSms.mockResolvedValue(null);
    const f = responder(201, { sid: "x" });
    await expect(adapter.send(ENVELOPE)).rejects.toThrow(/^twilio_not_configured:/);
    expect(f).not.toHaveBeenCalled();
  });

  it("pedido de desacelerar sai com o código que o chamador reenvia", async () => {
    responder(429, { code: 20429, message: "Too Many Requests" });
    await expect(adapter.send(ENVELOPE)).rejects.toThrow(/^twilio_throttled:/);
  });

  it("chave recusada vira notConfigured (reconectar), não falha da mensagem", async () => {
    responder(401, { code: 20003, message: "Authenticate" });
    await expect(adapter.send(ENVELOPE)).rejects.toThrow(/^twilio_not_configured:/);
  });

  it("STOP do destinatário falha com a categoria no texto", async () => {
    responder(400, { code: 21610, message: "Attempt to send to unsubscribed recipient" });
    const erro = (await adapter.send(ENVELOPE).then(
      () => new Error("esperava recusa"),
      (e: unknown) => e as Error,
    )) as Error;
    expect(erro.message).toMatch(/^twilio_error: destinatario_descadastrado/);
    expect(erro.message).not.toContain("chave_de_teste");
  });

  it("mídia e texto vazio são recusados antes de buscar credencial", async () => {
    await expect(adapter.send({ ...ENVELOPE, kind: "image" as never })).rejects.toThrow(/^twilio_error: .*image/);
    await expect(adapter.send({ ...ENVELOPE, body: "  " })).rejects.toThrow(/^twilio_error: .*sem corpo/);
    expect(conexaoDeSms).not.toHaveBeenCalled();
  });

  it("saúde: número existe → WORKING; chave recusada → FAILED; sem conexão → inalcançável", async () => {
    responder(200, { phone_number: "+14155550199" });
    expect(await adapter.checkHealth!({ organizationId: "org-1", sessionRef: NUMERO_ID })).toEqual({
      reachable: true,
      status: "WORKING",
      detail: null,
    });
    responder(401, { message: "Authenticate" });
    expect((await adapter.checkHealth!({ organizationId: "org-1", sessionRef: NUMERO_ID })).status).toBe("FAILED");
    conexaoDeSms.mockResolvedValue(null);
    expect(await adapter.checkHealth!({ organizationId: "org-1", sessionRef: NUMERO_ID })).toEqual({
      reachable: false,
      status: null,
      detail: "sem_credencial_para_a_sessao",
    });
  });
});
