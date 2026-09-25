import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * O CONTRATO do webhook da Cloud API.
 *
 * A ordem dos casos é a da dúvida: primeiro que os payloads REAIS produzem
 * exatamente os mesmos eventos de antes (é o que prova que ninguém apertou
 * demais), depois que o payload torto para de virar 500.
 *
 * O 500 não é hipótese: `parseMetaWebhook` faz `for (const entry of
 * envelope.entry ?? [])`, e `for...of` sobre um número LANÇA. A rota não tem
 * `try/catch` em volta, então a Meta recebia 5xx e reentregava o mesmo corpo em
 * backoff — indefinidamente, porque ele nunca ia melhorar.
 */

const SESSAO = { id: "sess-1", organizationId: "org-1", wabaId: "2434045433735175" };
const APP_SECRET = "app-secret-de-teste";
const ingeridos: unknown[] = [];

vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: async () => SESSAO,
}));

vi.mock("@/lib/channels/meta/ingest", () => ({
  ingestMetaEcho: async () => ({ status: "ingested" }),
  ingestMetaInbound: async (_a: unknown, e: unknown) => {
    ingeridos.push(e);
    return { status: "ingested" };
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({}) }) }) }) }) }),
  }),
}));

import { lerEnvelopeMeta } from "@/lib/channels/meta/envelope";
import { parseMetaWebhook } from "@/lib/channels/meta/webhook";
import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";

/** Payloads REAIS capturados da WABA de teste — os mesmos de `meta-webhook-inbound.test.ts`. */
const REAIS = JSON.parse(readFileSync("tests/fixtures/meta/inbound-webhooks.json", "utf8")) as unknown[];

const pedido = (corpo: unknown) => {
  const cru = typeof corpo === "string" ? corpo : JSON.stringify(corpo);
  return {
    text: async () => cru,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(cru, "utf8").digest("hex")}`,
    }),
  } as never;
};
const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;

describe("os payloads reais atravessam inteiros", () => {
  it.each(REAIS.map((p, i) => [i, p] as const))("payload real #%i passa e nada some", (_i, cru) => {
    const r = lerEnvelopeMeta(JSON.stringify(cru));
    expect(r.ok).toBe(true);
    expect(r.ok && r.envelope).toEqual(cru);
  });

  it("o parser produz EXATAMENTE os mesmos eventos com e sem o schema no meio", () => {
    // Prova de não-regressão: se o schema tivesse comido um campo, a lista de
    // eventos mudaria — e é ela que vira mensagem no inbox.
    for (const cru of REAIS) {
      const validado = lerEnvelopeMeta(JSON.stringify(cru));
      expect(validado.ok).toBe(true);
      expect(validado.ok && parseMetaWebhook(validado.envelope)).toEqual(
        parseMetaWebhook(cru as Parameters<typeof parseMetaWebhook>[0]),
      );
    }
  });

  it("campo desconhecido no envelope, na entry e na change passa intacto", () => {
    const comNovidade = {
      object: "whatsapp_business_account",
      campoDoFuturo: 1,
      entry: [{ id: "waba-1", time: 123, changes: [{ field: "messages", value: {}, extra: true }] }],
    };
    const r = lerEnvelopeMeta(JSON.stringify(comNovidade));
    expect(r.ok).toBe(true);
    expect(r.ok && r.envelope).toEqual(comNovidade);
  });

  it("o miolo de `value` NÃO é apertado — quem o lê já trata qualquer forma", () => {
    // `parseMetaWebhook` lê tudo por `str()`/`Array.isArray`. Exigir tipo aqui
    // trocaria "campo ignorado" por "webhook inteiro recusado".
    const r = lerEnvelopeMeta(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "w", changes: [{ field: "messages", value: { messages: "nem é lista", metadata: 7 } }] }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("envelope de outro produto (`object: page`) passa no contrato e o parser é quem ignora", () => {
    // A separação importa: recusar aqui viraria 400 para um evento legítimo que
    // simplesmente não é nosso.
    const r = lerEnvelopeMeta(JSON.stringify({ object: "page", entry: [{ id: "x" }] }));
    expect(r.ok).toBe(true);
    expect(r.ok && parseMetaWebhook(r.envelope)).toEqual([]);
  });
});

describe("o payload fora do contrato é recusado, e o campo é nomeado", () => {
  const recusa = (corpo: unknown): string[] => {
    const r = lerEnvelopeMeta(JSON.stringify(corpo));
    if (r.ok) throw new Error("o schema ACEITOU um payload que devia recusar");
    expect(r.motivo).toBe("contrato_violado");
    return [...r.campos].sort();
  };

  it("`entry` que não é lista — o campo que virava 500", () => {
    expect(recusa({ object: "whatsapp_business_account", entry: 3 })).toEqual(["entry"]);
  });

  it("sem o contrato, esse mesmo valor LANÇAVA no parser", () => {
    expect(() =>
      parseMetaWebhook({ object: "whatsapp_business_account", entry: 3 } as never),
    ).toThrow(TypeError);
  });

  it("`changes` que não é lista, e `value` que não é objeto", () => {
    expect(recusa({ object: "whatsapp_business_account", entry: [{ id: "w", changes: 1 }] })).toEqual([
      "entry.0.changes",
    ]);
    expect(
      recusa({ object: "whatsapp_business_account", entry: [{ id: "w", changes: [{ value: "texto" }] }] }),
    ).toEqual(["entry.0.changes.0.value"]);
  });

  it("json quebrado é motivo PRÓPRIO", () => {
    expect(lerEnvelopeMeta("{nao é json")).toMatchObject({ ok: false, motivo: "json_invalido" });
  });
});

describe("a rota — o desfecho que a Meta enxerga", () => {
  it("payload real bem assinado: 200 e a mensagem é ingerida", async () => {
    vi.stubEnv("META_APP_SECRET", APP_SECRET);
    ingeridos.length = 0;

    const res = await POST(pedido(REAIS[0]), ctx);

    expect(res.status).toBe(200);
    expect(ingeridos).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it("`entry` torto bem assinado: 400 com o campo, e NADA é ingerido", async () => {
    // Antes era 500 (exceção não capturada) e a Meta reentregava para sempre.
    vi.stubEnv("META_APP_SECRET", APP_SECRET);
    ingeridos.length = 0;

    const res = await POST(pedido({ object: "whatsapp_business_account", entry: 3 }), ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "validation_failed", details: { campos: ["entry"] } },
    });
    expect(ingeridos).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("a assinatura continua vindo ANTES do contrato — corpo torto sem HMAC é 401", async () => {
    vi.stubEnv("META_APP_SECRET", APP_SECRET);

    const res = await POST(
      { text: async () => '{"entry":3}', headers: new Headers() } as never,
      ctx,
    );

    expect(res.status).toBe(401);
    vi.unstubAllEnvs();
  });
});
