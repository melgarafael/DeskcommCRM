import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async () => "segredo-novo-cifrado"),
  decryptWebhookSecret: vi.fn(async (_admin: unknown, cifrado: string) => (cifrado === "ilegivel" ? null : "chave-da-conta")),
}));

import { encerrarConexaoDeSms, soltarNumeroAnterior } from "@/lib/channels/sms";

// Montados em pedaços: o literal inteiro tem a forma de id real e o scanner
// de segredos do GitHub recusa o push. São falsos.
const CONTA = "AC" + "0123456789abcdef".repeat(2);
const NUMERO_ID = "PN" + "d".repeat(32);

function adminComLinha(linha: Record<string, unknown> | null) {
  const cadeia = { select: () => cadeia, eq: () => cadeia, maybeSingle: async () => ({ data: linha, error: null }) };
  return { from: vi.fn(() => cadeia) } as never;
}

const ENTRADA = { organizationId: "org-1", channelSessionId: "sess-1" };
const LINHA = { twilio_phone_number_sid: NUMERO_ID, twilio_account_sid: CONTA, webhook_secret_encrypted: "cifrado" };

describe("desconectar o SMS", () => {
  it("devolve o recebimento do número (SmsUrl vazio) com a chave da linha, e entrega um segredo novo", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await encerrarConexaoDeSms(adminComLinha(LINHA), ENTRADA, f);
    expect(r).toEqual({ recebimento: "desfeito", segredoNovoCifrado: "segredo-novo-cifrado" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${CONTA}/IncomingPhoneNumbers/${NUMERO_ID}.json`);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ SmsUrl: "" });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from(`${CONTA}:chave-da-conta`).toString("base64"),
    );
  });

  it("fornecedor recusando é 'falhou', mas o segredo novo sai do mesmo jeito (a exclusão segue)", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 500 }));
    expect(await encerrarConexaoDeSms(adminComLinha(LINHA), ENTRADA, f)).toEqual({
      recebimento: "falhou",
      segredoNovoCifrado: "segredo-novo-cifrado",
    });
  });

  it("sem chave legível não chama o fornecedor", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await encerrarConexaoDeSms(adminComLinha({ ...LINHA, webhook_secret_encrypted: "ilegivel" }), ENTRADA, f);
    expect(r.recebimento).toBe("sem_credencial");
    expect(f).not.toHaveBeenCalled();
    expect(await encerrarConexaoDeSms(adminComLinha(null), ENTRADA, f)).toMatchObject({ recebimento: "sem_credencial" });
  });
});

describe("soltar o número anterior ao trocar de número", () => {
  const ANTERIOR = "PN" + "e".repeat(32);
  const NOVAS = { accountSid: CONTA, authToken: "chave-nova" };
  const base = { organizationId: "org-1", channelSessionId: "sess-1", numeroIdAnterior: ANTERIOR };

  it("mesma conta: usa a chave nova e devolve o SmsUrl do número ANTERIOR, sem ler a linha", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const admin = adminComLinha(LINHA) as unknown as { from: ReturnType<typeof vi.fn> };
    const r = await soltarNumeroAnterior(admin as never, { ...base, contaAnterior: CONTA, credenciaisNovas: NOVAS }, f);
    expect(r).toBe("desfeito");
    expect(admin.from).not.toHaveBeenCalled();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${CONTA}/IncomingPhoneNumbers/${ANTERIOR}.json`);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ SmsUrl: "" });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from(`${CONTA}:chave-nova`).toString("base64"),
    );
  });

  it("outra conta: usa a chave gravada da conta antiga", async () => {
    const ANTIGA = "AC" + "9".repeat(32);
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await soltarNumeroAnterior(adminComLinha(LINHA), { ...base, contaAnterior: ANTIGA, credenciaisNovas: NOVAS }, f);
    expect(r).toBe("desfeito");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/Accounts/${ANTIGA}/IncomingPhoneNumbers/${ANTERIOR}.json`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from(`${ANTIGA}:chave-da-conta`).toString("base64"),
    );
  });

  it("outra conta sem chave legível: não chama o fornecedor", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await soltarNumeroAnterior(
      adminComLinha({ ...LINHA, webhook_secret_encrypted: "ilegivel" }),
      { ...base, contaAnterior: "AC" + "9".repeat(32), credenciaisNovas: NOVAS },
      f,
    );
    expect(r).toBe("sem_credencial");
    expect(f).not.toHaveBeenCalled();
  });

  it("fornecedor recusando é 'falhou' (a troca segue, só fica no log)", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 500 }));
    expect(await soltarNumeroAnterior(adminComLinha(LINHA), { ...base, contaAnterior: CONTA, credenciaisNovas: NOVAS }, f)).toBe(
      "falhou",
    );
  });
});
