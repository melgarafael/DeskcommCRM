/**
 * `apagarAssinaturaSocial` — a peça que o DELETE da Central de Conexões usa para
 * não deixar a assinatura de webhook viva no Zernio (issue #2419).
 *
 * Cobre os três casos que a issue pede: canal social COM id gravado (apaga pelo
 * id), SEM id gravado (reconcilia pela URL do token, como o #2364) e provedor
 * fora do ar (lança — o chamador decide entre falhar fechado ou best-effort).
 */
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ fetch: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "provider-key",
  encryptWebhookSecret: async () => "enc",
}));
vi.mock("@/lib/channels/health", () => ({ resolverSaudeDaConexaoRemovida: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn() } }));
vi.mock("../zernio/credentials", () => ({ zernioBaseUrl: () => "https://zernio.test" }));

import { apagarAssinaturaSocial } from "./store";

const ORG = "org-1";
const CANAL = "ch-1";
const TOKEN = "tok-123";

interface DbOpts {
  /** `false` = perfil já desvinculado (sem linha na integração). */
  integracao?: boolean;
  metadata?: Record<string, unknown>;
}

function fakeDb(opts: DbOpts = {}) {
  const { integracao = true, metadata = {} } = opts;
  const db = {
    from(table: string) {
      let cols = "";
      const q = {
        select: (c?: string) => ((cols = c ?? ""), q),
        eq: () => q,
        is: () => q,
        maybeSingle: async () => {
          if (table === "channel_integrations")
            return integracao
              ? { data: { profile_id: "p", credential_encrypted: "x" }, error: null }
              : { data: null, error: null };
          if (cols.includes("metadata")) return { data: { metadata }, error: null };
          if (cols.includes("webhook_path_token"))
            return { data: { webhook_path_token: TOKEN }, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
  };
  return db as never;
}

function provider(responses: Record<string, number>, webhooks: Array<{ _id: string; url: string }> = []) {
  h.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${String(url).replace("https://zernio.test/v1/", "")}`;
    if (key === "GET webhooks/settings")
      return new Response(JSON.stringify({ webhooks }), { status: responses[key] ?? 200 });
    return new Response("{}", { status: responses[key] ?? 200 });
  });
}

const deletes = () =>
  h.fetch.mock.calls
    .filter(([, init]) => (init as RequestInit).method === "DELETE")
    .map(([url]) => String(url).replace("https://zernio.test/v1/", ""));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", h.fetch);
});

it("apaga pelo id gravado sem listar nada", async () => {
  provider({});
  const resultado = await apagarAssinaturaSocial(
    fakeDb({ metadata: { social_webhook_id: "wh-1" } }),
    ORG,
    CANAL,
  );
  expect(resultado).toBe("apagada");
  expect(deletes()).toEqual(["webhooks/settings?webhookId=wh-1"]);
});

it("sem id gravado, reconcilia pela URL do token ainda válido", async () => {
  provider({}, [{ _id: "wh-9", url: `https://app.exemplo/api/v1/webhooks/channel/${TOKEN}` }]);
  const resultado = await apagarAssinaturaSocial(fakeDb({ metadata: {} }), ORG, CANAL);
  expect(resultado).toBe("apagada");
  expect(deletes()).toEqual(["webhooks/settings?webhookId=wh-9"]);
});

it("sem id e sem assinatura na lista, converge sem chamar o DELETE", async () => {
  provider({}, [{ _id: "wh-9", url: "https://app.exemplo/api/v1/webhooks/channel/outro-token" }]);
  const resultado = await apagarAssinaturaSocial(fakeDb({ metadata: {} }), ORG, CANAL);
  expect(resultado).toBe("apagada");
  expect(deletes()).toEqual([]);
});

it("provedor fora do ar lança, para o chamador decidir", async () => {
  provider({ "DELETE webhooks/settings?webhookId=wh-1": 500 });
  await expect(
    apagarAssinaturaSocial(fakeDb({ metadata: { social_webhook_id: "wh-1" } }), ORG, CANAL),
  ).rejects.toThrow("O provedor não concluiu a operação (HTTP 500).");
});

it("sem integração (perfil desvinculado), devolve sem_integracao sem falar com o provedor", async () => {
  provider({});
  const resultado = await apagarAssinaturaSocial(
    fakeDb({ integracao: false, metadata: { social_webhook_id: "wh-1" } }),
    ORG,
    CANAL,
  );
  expect(resultado).toBe("sem_integracao");
  expect(h.fetch).not.toHaveBeenCalled();
});
