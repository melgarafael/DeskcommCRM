import { describe, expect, it, vi } from "vitest";

import { aplicarAvisoDeStatus } from "@/lib/channels/sms/status";
import { ehAvisoDeStatus, enviarSms, lerAvisoDeStatus, lerSmsRecebido } from "@/lib/channels/sms/twilio";

/**
 * O recibo de entrega do SMS (#4415, achados 2 e 3 da revisão de 26/11): o
 * envio pede o aviso de status, o aviso é separado do SMS recebido, e o
 * desfecho chega à linha de `messages` sem rebaixar nem duplicar.
 */

// Montados em pedaços: o literal inteiro tem a forma de id real e o scanner
// de segredos do GitHub recusa o push. São falsos.
const CONTA = "AC" + "0123456789abcdef".repeat(2);
const SID = "SM" + "b".repeat(32);

/** O formato do aviso de status do fornecedor: sem `Body`, com `MessageStatus`. */
const AVISO = {
  MessageSid: SID,
  SmsSid: SID,
  AccountSid: CONTA,
  From: "+14155550199",
  To: "+14155550100",
  MessageStatus: "undelivered",
  SmsStatus: "undelivered",
  ErrorCode: "30003",
  ApiVersion: "2010-04-01",
};

const RECEBIDO = {
  MessageSid: "SM" + "a".repeat(32),
  AccountSid: CONTA,
  From: "+14155550100",
  To: "+14155550199",
  Body: "Can you send a quote?",
  NumMedia: "0",
  SmsStatus: "received",
};

describe("aviso de status x SMS recebido", () => {
  it("o aviso de status é reconhecido; o SMS recebido (mesmo com SmsStatus=received) não", () => {
    expect(ehAvisoDeStatus(AVISO)).toBe(true);
    expect(ehAvisoDeStatus(RECEBIDO)).toBe(false);
    expect(ehAvisoDeStatus({ ...RECEBIDO, MessageStatus: "received" })).toBe(false);
  });

  it("o payload de status da revisão NÃO é aceito como SMS recebido (antes passava, com corpo vazio)", () => {
    expect(lerSmsRecebido(AVISO)).toEqual({ ok: false, campos: ["MessageStatus"] });
    expect(lerSmsRecebido(RECEBIDO).ok).toBe(true);
  });

  it("estado do fornecedor vira desfecho; recusa leva a categoria e o código", () => {
    expect(lerAvisoDeStatus(AVISO)).toEqual({
      ok: true,
      aviso: { externalId: SID, contaId: CONTA, de: "+14155550199", desfecho: "failed", motivo: "outro", codigo: 30003 },
    });
    const stop = lerAvisoDeStatus({ ...AVISO, MessageStatus: "failed", ErrorCode: "21610" });
    expect(stop.ok && stop.aviso.motivo).toBe("destinatario_descadastrado");
    const entregue = lerAvisoDeStatus({ ...AVISO, MessageStatus: "delivered", ErrorCode: "" });
    expect(entregue.ok && entregue.aviso).toMatchObject({ desfecho: "delivered", motivo: null, codigo: null });
    for (const caminho of ["queued", "accepted", "sending", "scheduled"]) {
      const r = lerAvisoDeStatus({ ...AVISO, MessageStatus: caminho });
      expect(r.ok && r.aviso.desfecho).toBeNull();
    }
  });

  it("aviso fora do contrato devolve os campos culpados", () => {
    expect(lerAvisoDeStatus({ ...AVISO, From: "nao-e-telefone" })).toEqual({ ok: false, campos: ["From"] });
  });
});

describe("o envio pede o recibo", () => {
  const creds = { accountSid: CONTA, authToken: "chave_de_teste" };
  const envio = { de: "+14155550199", para: "+14155550100", texto: "Your estimate is ready" };

  function fetchQueAceita() {
    return vi.fn(async () => new Response(JSON.stringify({ sid: SID }), { status: 201 }));
  }

  it("com URL https, o StatusCallback vai no formulário", async () => {
    const f = fetchQueAceita();
    await enviarSms(creds, { ...envio, avisoDeStatusUrl: "https://crm.exemplo.com/api/v1/webhooks/channel/tok" }, f);
    const form = new URLSearchParams(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(form.get("StatusCallback")).toBe("https://crm.exemplo.com/api/v1/webhooks/channel/tok");
  });

  it("sem URL, ou com URL que não é https, o envio sai sem StatusCallback", async () => {
    for (const avisoDeStatusUrl of [undefined, null, "http://crm.exemplo.com/x"]) {
      const f = fetchQueAceita();
      await enviarSms(creds, { ...envio, avisoDeStatusUrl }, f);
      const form = new URLSearchParams(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect(form.has("StatusCallback")).toBe(false);
    }
  });
});

/** Admin falso que registra cada update: os valores, os filtros e o que voltou. */
function adminQueRegistra(afetadas = 1) {
  const updates: Array<{ valores: Record<string, unknown>; filtros: Array<[string, ...unknown[]]> }> = [];
  const from = vi.fn(() => ({
    update: (valores: Record<string, unknown>) => {
      const registro = { valores, filtros: [] as Array<[string, ...unknown[]]> };
      updates.push(registro);
      const cadeia = {
        eq: (...a: unknown[]) => (registro.filtros.push(["eq", ...a]), cadeia),
        not: (...a: unknown[]) => (registro.filtros.push(["not", ...a]), cadeia),
        is: (...a: unknown[]) => (registro.filtros.push(["is", ...a]), Promise.resolve({ error: null })),
        select: async () => ({ data: Array.from({ length: afetadas }, (_, i) => ({ id: `m${i}` })), error: null }),
      };
      return cadeia;
    },
  }));
  return { admin: { from } as never, updates };
}

const ENTRADA = { organizationId: "org-1", channelSessionId: "sess-1" };

function aviso(estado: string, codigo = "") {
  const r = lerAvisoDeStatus({ ...AVISO, MessageStatus: estado, ErrorCode: codigo });
  if (!r.ok) throw new Error("aviso de teste inválido");
  return r.aviso;
}

describe("o desfecho chega à mensagem", () => {
  it("recusa da operadora vira failed com a categoria, só na mensagem outbound desta conexão, sem sobrescrever failed", async () => {
    const { admin, updates } = adminQueRegistra();
    const r = await aplicarAvisoDeStatus(admin, { ...ENTRADA, aviso: aviso("undelivered", "30003") });
    expect(r).toEqual({ status: "ingested", reason: "status_failed" });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.valores).toMatchObject({
      status: "failed",
      error_code: "sms_outro",
      error_message: "A operadora não entregou o SMS (outro, código 30003).",
    });
    expect(updates[0]?.filtros).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", "org-1"],
        ["eq", "channel_session_id", "sess-1"],
        ["eq", "external_id", SID],
        ["eq", "direction", "outbound"],
        ["not", "status", "in", "(read,failed)"],
      ]),
    );
  });

  it("entregue grava delivered e carimba delivered_at uma vez só", async () => {
    const { admin, updates } = adminQueRegistra();
    await aplicarAvisoDeStatus(admin, { ...ENTRADA, aviso: aviso("delivered") });
    expect(updates).toHaveLength(2);
    expect(updates[0]?.valores).toMatchObject({ status: "delivered" });
    expect(updates[0]?.valores).not.toHaveProperty("error_code");
    expect(Object.keys(updates[1]?.valores ?? {})).toEqual(["delivered_at"]);
    expect(updates[1]?.filtros).toContainEqual(["is", "delivered_at", null]);
  });

  it("sent atrasado não rebaixa delivered", async () => {
    const { admin, updates } = adminQueRegistra();
    await aplicarAvisoDeStatus(admin, { ...ENTRADA, aviso: aviso("sent") });
    expect(updates[0]?.filtros).toContainEqual(["not", "status", "in", "(delivered,read,failed)"]);
  });

  it("estado intermediário não toca no banco", async () => {
    const { admin, updates } = adminQueRegistra();
    expect(await aplicarAvisoDeStatus(admin, { ...ENTRADA, aviso: aviso("queued") })).toEqual({
      status: "ignored",
      reason: "estado_intermediario",
    });
    expect(updates).toHaveLength(0);
  });

  it("aviso de mensagem que não é nossa (ou já resolvida) é ignorado", async () => {
    const { admin } = adminQueRegistra(0);
    expect(await aplicarAvisoDeStatus(admin, { ...ENTRADA, aviso: aviso("delivered") })).toEqual({
      status: "ignored",
      reason: "mensagem_desconhecida_ou_ja_resolvida",
    });
  });
});
