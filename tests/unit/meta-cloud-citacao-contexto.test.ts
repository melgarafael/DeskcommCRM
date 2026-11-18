import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { metaCloudAdapter } from "@/lib/channels/adapters/meta-cloud";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const query: Record<string, unknown> = {
        maybeSingle: async () => ({ data: null, error: null }),
      };
      query.select = () => query;
      query.eq = () => query;
      query.is = () => query;
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

const ORG = "00000000-0000-4000-8000-000000000236";
const NUMERO_DO_ENV = "1103328999528818";

function stubFetch(resposta: unknown = { messages: [{ id: "wamid.TEST123" }] }, ok = true) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => resposta,
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("metaCloudAdapter.send — citação e contexto (#4880)", () => {
  beforeEach(() => {
    vi.stubEnv("META_PHONE_NUMBER_ID", NUMERO_DO_ENV);
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "test-token");
    vi.stubEnv("META_GRAPH_VERSION", "v19.0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("1. Sending with replyToExternalId includes context: { message_id: <id> } in the JSON request body", async () => {
    const spy = stubFetch({ messages: [{ id: "wamid.OUT1" }] });
    const replyId = "wamid.HBgMNTUzMTk5ODk2NjM5OBUCABIYFj";

    const res = await metaCloudAdapter.send({
      organizationId: ORG,
      sessionRef: NUMERO_DO_ENV,
      to: "5531998966398",
      kind: "text",
      body: "o link está aqui",
      replyToExternalId: replyId,
    });

    expect(res).toEqual({ externalId: "wamid.OUT1" });
    expect(spy).toHaveBeenCalledTimes(1);

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain(`/${NUMERO_DO_ENV}/messages`);
    expect(init.method).toBe("POST");

    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload).toHaveProperty("context");
    expect(payload.context).toEqual({ message_id: replyId });
    expect(payload.messaging_product).toBe("whatsapp");
    expect(payload.to).toBe("5531998966398");
  });

  it("2. Sending without replyToExternalId does not include context", async () => {
    const spy = stubFetch({ messages: [{ id: "wamid.OUT2" }] });

    const res = await metaCloudAdapter.send({
      organizationId: ORG,
      sessionRef: NUMERO_DO_ENV,
      to: "5531998966398",
      kind: "text",
      body: "mensagem normal sem citacao",
    });

    expect(res).toEqual({ externalId: "wamid.OUT2" });
    expect(spy).toHaveBeenCalledTimes(1);

    const [, init] = spy.mock.calls[0]!;
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("context");
  });

  it("sending with undefined or null or empty replyToExternalId omits context", async () => {
    for (const replyToExternalId of [undefined, null, "", "   "]) {
      const spy = stubFetch({ messages: [{ id: "wamid.OUT3" }] });

      await metaCloudAdapter.send({
        organizationId: ORG,
        sessionRef: NUMERO_DO_ENV,
        to: "5531998966398",
        kind: "text",
        body: "teste",
        replyToExternalId,
      });

      const [, init] = spy.mock.calls[0]!;
      const payload = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(payload).not.toHaveProperty("context");
    }
  });
});
