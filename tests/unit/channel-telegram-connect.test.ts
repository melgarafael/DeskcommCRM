import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CONEXÃO DO BOT: validar o token, inventar os segredos, registrar o webhook e
 * SÓ ENTÃO gravar a sessão.
 *
 * ## Os três defeitos que este arquivo existe para impedir
 *
 *   1. **sessão gravada sem webhook**: a tela mostra "conectado" e nenhuma
 *      mensagem chega — o pior desfecho, porque não há erro para procurar.
 *      Por isso o teste afirma a ORDEM: `setWebhook` antes do INSERT;
 *   2. **token vazando**: o token do @BotFather não pode aparecer na resposta,
 *      na mensagem de erro nem no `display_name`. Ele também não pode ser o
 *      `secret_token` do webhook (são segredos diferentes: um fala com o
 *      Telegram, o outro prova que o Telegram falou com a gente);
 *   3. **401 tratado como rede**: dizer "token inválido" quando o Telegram está
 *      fora do ar manda o operador caçar o problema no lugar errado — e o
 *      inverso manda-o tentar de novo para sempre com uma credencial revogada.
 */

const chamadas: { metodo: string; body: Record<string, unknown>; url: string }[] = [];
let respostaGetMe: { ok: boolean; status: number; corpo: unknown } = {
  ok: true,
  status: 200,
  corpo: { ok: true, result: { id: 777, is_bot: true, first_name: "Atendimento", username: "acme_bot" } },
};
let respostaSetWebhook: { ok: boolean; status: number; corpo: unknown } = { ok: true, status: 200, corpo: { ok: true, result: true } };

const inseridos: Record<string, unknown>[] = [];
const reativados: Record<string, unknown>[] = [];

vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_admin: unknown, texto: string) => `enc:${texto}`,
}));
vi.mock("@/lib/channels/reactivate", () => ({
  reactivateChannelSession: async (_a: unknown, _b: unknown, linha: Record<string, unknown>) => {
    reativados.push(linha);
    return { error: null };
  },
}));
vi.mock("@/lib/ai/elegibilidade/pre-go-live", () => ({
  metadataInicialDoCanal: () => ({ pre_go_live: true }),
}));

const { conectarRobo, novoSegredoDoWebhook, acharSessaoDoRobo } = await import("@/lib/channels/bot/connect");

const adminFake = {
  from(tabela: string) {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "maybeSingle")
            return async () =>
              tabela === "channel_sessions"
                ? { data: { id: "sess-nova" }, error: null }
                : { data: null, error: null };
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
          if (prop === "insert") {
            return (payload: Record<string, unknown>) => {
              if (tabela === "channel_sessions") inseridos.push(payload);
              return proxy;
            };
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  },
} as never;

const BASE = "https://crm.acme.com.br";

beforeEach(() => {
  chamadas.length = 0;
  inseridos.length = 0;
  reativados.length = 0;
  respostaGetMe = {
    ok: true,
    status: 200,
    corpo: { ok: true, result: { id: 777, is_bot: true, first_name: "Atendimento", username: "acme_bot" } },
  };
  respostaSetWebhook = { ok: true, status: 200, corpo: { ok: true, result: true } };

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const metodo = String(url).split("/").pop() ?? "";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    chamadas.push({ metodo, body, url: String(url) });
    const r = metodo === "getMe" ? respostaGetMe : respostaSetWebhook;
    return {
      ok: r.ok,
      status: r.status,
      text: async () => JSON.stringify(r.corpo),
      json: async () => r.corpo,
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conectarRobo", () => {
  it("registra o webhook ANTES de gravar a sessão", async () => {
    const r = await conectarRobo(adminFake, {
      organizationId: "org-1",
      token: "123456789:AAH-segredo-do-botfather",
      existente: null,
      webhookUrlBase: BASE,
      userId: "user-1",
      requestId: "req-1",
    });
    expect(r.ok).toBe(true);
    const ordem = chamadas.map((c) => c.metodo);
    expect(ordem).toEqual(["getMe", "setWebhook"]);
    expect(inseridos).toHaveLength(1);
  });

  it("a URL registrada é a rota NEUTRA do webhook, com token de caminho", async () => {
    const r = await conectarRobo(adminFake, {
      organizationId: "org-1",
      token: "123456789:AAH-segredo-do-botfather",
      existente: null,
      webhookUrlBase: BASE,
      userId: "user-1",
      requestId: "req-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.webhookUrl).toMatch(new RegExp(`^${BASE}/api/v1/webhooks/channel/[a-f0-9]{48}$`));
    const setWebhook = chamadas.find((c) => c.metodo === "setWebhook");
    expect(setWebhook?.body.url).toBe(r.webhookUrl);
    // Sem `X-Telegram-Bot-Api-Secret-Token` o canal não teria prova de origem.
    expect(typeof setWebhook?.body.secret_token).toBe("string");
  });

  it("o `secret_token` do webhook NÃO é o token do bot", async () => {
    const token = "123456789:AAH-segredo-do-botfather";
    await conectarRobo(adminFake, {
      organizationId: "org-1",
      token,
      existente: null,
      webhookUrlBase: BASE,
      userId: "user-1",
      requestId: "req-1",
    });
    const setWebhook = chamadas.find((c) => c.metodo === "setWebhook");
    expect(setWebhook?.body.secret_token).not.toBe(token);
    expect(String(setWebhook?.body.secret_token)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("entrega só `message` — os outros tipos de update não têm tratamento na v1", async () => {
    await conectarRobo(adminFake, {
      organizationId: "org-1",
      token: "123456789:AAH-segredo-do-botfather",
      existente: null,
      webhookUrlBase: BASE,
      userId: "user-1",
      requestId: "req-1",
    });
    expect(chamadas.find((c) => c.metodo === "setWebhook")?.body.allowed_updates).toEqual(["message"]);
    // Descartar updates pendentes na conexão perderia justamente a mensagem que
    // o operador foi conectar para atender.
    expect(chamadas.find((c) => c.metodo === "setWebhook")?.body.drop_pending_updates).toBe(false);
  });

  it("grava o token CIFRADO e o id do robô; o nome sai do bot", async () => {
    await conectarRobo(adminFake, {
      organizationId: "org-1",
      token: "123456789:AAH-segredo-do-botfather",
      existente: null,
      webhookUrlBase: BASE,
      userId: "user-1",
      requestId: "req-1",
    });
    expect(inseridos[0]).toMatchObject({
      organization_id: "org-1",
      provider: "telegram",
      telegram_bot_id: "777",
      telegram_token_encrypted: "enc:123456789:AAH-segredo-do-botfather",
      display_name: "Atendimento",
      status: "WORKING",
    });
  });

  it("token recusado (401): 422 com a causa certa e NADA gravado", async () => {
    respostaGetMe = { ok: false, status: 401, corpo: { ok: false, error_code: 401, description: "Unauthorized" } };
    const r = await conectarRobo(adminFake, {
      organizationId: "org-1",
      token: "123456789:token-revogado",
      existente: null,
      webhookUrlBase: BASE,
      userId: "user-1",
      requestId: "req-1",
    });
    expect(r).toMatchObject({ ok: false, status: 422 });
    if (r.ok) throw new Error("esperava falha");
    expect(r.reason).toMatch(/@BotFather/);
    expect(inseridos).toHaveLength(0);
    expect(chamadas.map((c) => c.metodo)).not.toContain("setWebhook");
  });

  it("rede fora do ar: 502 — e não 'token inválido'", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("getaddrinfo EAI_AGAIN api.telegram.org");
    });
    const r = await conectarRobo(adminFake, {
      organizationId: "org-1",
      token: "123456789:AAH-segredo-do-botfather",
      existente: null,
      webhookUrlBase: BASE,
      userId: "user-1",
      requestId: "req-1",
    });
    expect(r).toMatchObject({ ok: false, status: 502 });
    if (r.ok) throw new Error("esperava falha");
    expect(r.reason).toMatch(/Não foi possível falar com o Telegram/);
    expect(inseridos).toHaveLength(0);
  });

  it("URL recusada pelo Telegram: 502 e nada gravado (a tela não pode ficar verde)", async () => {
    respostaSetWebhook = {
      ok: false,
      status: 400,
      corpo: { ok: false, error_code: 400, description: "Bad Request: bad webhook: HTTPS url must be provided" },
    };
    const r = await conectarRobo(adminFake, {
      organizationId: "org-1",
      token: "123456789:AAH-segredo-do-botfather",
      existente: null,
      webhookUrlBase: "http://localhost:3000",
      userId: "user-1",
      requestId: "req-1",
    });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(inseridos).toHaveLength(0);
  });

  it("reconectar RESSUSCITA a sessão arquivada em vez de criar outra", async () => {
    const r = await conectarRobo(adminFake, {
      organizationId: "org-1",
      token: "123456789:AAH-segredo-do-botfather",
      existente: {
        id: "sess-antiga",
        botId: "777",
        displayName: "Suporte ACME",
        status: "FAILED",
        webhookPathToken: "abc123",
        hasToken: true,
        webhookSecretEncrypted: "enc:antigo",
        archivedAt: "2026-10-01T00:00:00Z",
      },
      webhookUrlBase: BASE,
      userId: "user-1",
      requestId: "req-1",
    });
    expect(r.ok).toBe(true);
    expect(inseridos).toHaveLength(0);
    expect(reativados).toHaveLength(1);
    // O token do caminho é reaproveitado: trocá-lo renomearia o canal para quem
    // já o depura, e a URL antiga continuaria configurada no Telegram.
    expect((reativados[0] as { webhook_path_token?: string }).webhook_path_token).toBe("abc123");
    const setWebhook = chamadas.find((c) => c.metodo === "setWebhook");
    expect(setWebhook?.body.url).toBe(`${BASE}/api/v1/webhooks/channel/abc123`);
  });

  it("o token do bot nunca aparece na resposta de sucesso", async () => {
    const token = "123456789:AAH-segredo-do-botfather";
    const r = await conectarRobo(adminFake, {
      organizationId: "org-1",
      token,
      existente: null,
      webhookUrlBase: BASE,
      userId: "user-1",
      requestId: "req-1",
    });
    expect(JSON.stringify(r)).not.toContain(token);
  });
});

describe("novoSegredoDoWebhook", () => {
  it("32 bytes em hex: entropia de verdade e dentro do que o Telegram aceita", () => {
    const a = novoSegredoDoWebhook();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(novoSegredoDoWebhook()).not.toBe(a);
  });
});

describe("acharSessaoDoRobo", () => {
  it("consulta pelo provider e pela organização — o client é service role e ignora a RLS", async () => {
    const filtros: [string, unknown][] = [];
    /** Builder encadeável de verdade: `then` assenta, senão o await trava. */
    function builder(): Record<string, unknown> {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "maybeSingle") return async () => ({ data: null, error: null });
            if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
            if (prop === "eq")
              return (c: string, v: unknown) => {
                filtros.push([c, v]);
                return proxy;
              };
            return () => proxy;
          },
        },
      );
      return proxy;
    }
    const admin = { from: () => builder() } as never;

    await acharSessaoDoRobo(admin, "org-9");

    expect(filtros).toContainEqual(["organization_id", "org-9"]);
    expect(filtros).toContainEqual(["provider", "telegram"]);
  });
});
