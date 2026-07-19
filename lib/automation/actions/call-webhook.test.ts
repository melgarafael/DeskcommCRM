import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { executeCallWebhook } from "@/lib/automation/actions/call-webhook";
import type { ActionCtx } from "@/lib/automation/types";

function baseCtx(overrides: Partial<ActionCtx["event"]> = {}): ActionCtx {
  return {
    admin: {} as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    requestId: "req-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: "lead-1",
      payload: { foo: "bar" },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      ...overrides,
    },
    context: { lead: { id: "lead-1", title: "Fulano" } },
  };
}

async function listen(server: Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("executeCallWebhook", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("sucesso: envia envelope correto, sem assinatura, sem organization_id", async () => {
    let received: { headers: Record<string, string | string[] | undefined>; body: string } | undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received = { headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const { port, close } = await listen(server);

    const result = await executeCallWebhook(
      baseCtx(),
      { url: `http://127.0.0.1:${port}/hook` },
      { skipUrlCheck: true },
    );

    expect(result.status).toBe("success");
    expect(result.detail?.response_status).toBe(200);
    expect(received).toBeDefined();
    expect(received!.headers["x-deskcomm-event"]).toBe("lead.created");
    expect(received!.headers["x-deskcomm-signature"]).toBeUndefined();

    const parsedBody = JSON.parse(received!.body);
    expect(parsedBody.event).toBe("lead.created");
    expect(typeof parsedBody.occurred_at).toBe("string");
    expect(parsedBody.data).toEqual({ foo: "bar", lead: { id: "lead-1", title: "Fulano" } });
    expect(parsedBody.organization_id).toBeUndefined();
    expect(JSON.stringify(parsedBody)).not.toContain("org-1");

    await close();
  });

  it("com secret: header de assinatura HMAC-sha256 do body", async () => {
    let received: { headers: Record<string, string | string[] | undefined>; body: string } | undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received = { headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
        res.writeHead(200);
        res.end("ok");
      });
    });
    const { port, close } = await listen(server);

    const result = await executeCallWebhook(
      baseCtx(),
      { url: `http://127.0.0.1:${port}/hook`, secret: "s3cr3t" },
      { skipUrlCheck: true },
    );

    expect(result.status).toBe("success");
    const expectedSig = createHmac("sha256", "s3cr3t").update(received!.body).digest("hex");
    expect(received!.headers["x-deskcomm-signature"]).toBe(expectedSig);

    await close();
  });

  it("falha 500 persistente: 3 tentativas, retorna failed com response_status", async () => {
    let hits = 0;
    server = createServer((req, res) => {
      hits += 1;
      req.resume();
      req.on("end", () => {
        res.writeHead(500);
        res.end("nope");
      });
    });
    const { port, close } = await listen(server);

    const result = await executeCallWebhook(
      baseCtx(),
      { url: `http://127.0.0.1:${port}/hook` },
      { skipUrlCheck: true, retryDelaysMs: [1, 1] },
    );

    expect(hits).toBe(3);
    expect(result.status).toBe("failed");
    expect(result.detail?.response_status).toBe(500);

    await close();
  }, 15_000);

  it("falha depois sucesso: 500 na 1ª, 200 na 2ª — success com attempt=2", async () => {
    let hits = 0;
    server = createServer((req, res) => {
      hits += 1;
      const status = hits === 1 ? 500 : 200;
      req.resume();
      req.on("end", () => {
        res.writeHead(status);
        res.end("body");
      });
    });
    const { port, close } = await listen(server);

    const result = await executeCallWebhook(
      baseCtx(),
      { url: `http://127.0.0.1:${port}/hook` },
      { skipUrlCheck: true, retryDelaysMs: [1, 1] },
    );

    expect(hits).toBe(2);
    expect(result.status).toBe("success");
    expect(result.detail?.attempt).toBe(2);

    await close();
  }, 15_000);

  it("URL insegura (sem skipUrlCheck): failed com error unsafe_url", async () => {
    const result = await executeCallWebhook(baseCtx(), { url: "https://127.0.0.1:9/x" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^unsafe_url/);
  });

  it("envelope projeta lead/contact públicos — não vaza colunas internas do DB", async () => {
    let received: { body: string } | undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received = { body: Buffer.concat(chunks).toString("utf8") };
        res.writeHead(200);
        res.end("ok");
      });
    });
    const { port, close } = await listen(server);

    const fullLeadRow = {
      id: "lead-1",
      organization_id: "org-secret-1",
      title: "Pedido #42",
      status: "open",
      pipeline_id: "pipe-1",
      stage_id: "stage-1",
      value_cents: 5000,
      currency: "BRL",
      tags: ["vip"],
      custom_fields: { foo: "bar" },
      source: "whatsapp",
      created_at: "2026-01-01T00:00:00Z",
      owner_user_id: "user-secret-1",
      is_archived: false,
      source_metadata: { ip: "10.0.0.1" },
    };
    const fullContactRow = {
      id: "contact-1",
      organization_id: "org-secret-1",
      name: "Fulano da Silva",
      display_name: "Fulano",
      email: "fulano@example.com",
      phone_number: "+5511999999999",
      tags: ["lead"],
      created_at: "2026-01-01T00:00:00Z",
      cpf_hash: "cpf-secret-hash",
      consent: { marketing: true },
      source_metadata: { referrer: "ads" },
      is_blocked: false,
    };

    const ctx = baseCtx();
    ctx.context = { lead: fullLeadRow, contact: fullContactRow };

    const result = await executeCallWebhook(
      ctx,
      { url: `http://127.0.0.1:${port}/hook` },
      { skipUrlCheck: true },
    );

    expect(result.status).toBe("success");
    const rawBody = received!.body;
    const parsed = JSON.parse(rawBody);

    expect(parsed.data.lead).toEqual({
      id: "lead-1",
      title: "Pedido #42",
      status: "open",
      pipeline_id: "pipe-1",
      stage_id: "stage-1",
      value_cents: 5000,
      currency: "BRL",
      tags: ["vip"],
      custom_fields: { foo: "bar" },
      source: "whatsapp",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(parsed.data.contact).toEqual({
      id: "contact-1",
      name: "Fulano da Silva",
      display_name: "Fulano",
      email: "fulano@example.com",
      phone_number: "+5511999999999",
      tags: ["lead"],
      created_at: "2026-01-01T00:00:00Z",
    });

    for (const forbidden of [
      "organization_id",
      "org-secret-1",
      "cpf_hash",
      "cpf-secret-hash",
      "owner_user_id",
      "user-secret-1",
      "source_metadata",
      "is_archived",
      "is_blocked",
      "consent",
    ]) {
      expect(rawBody).not.toContain(forbidden);
    }

    await close();
  });

  it("SSRF via redirect: 302 não é seguido, falha com redirect_not_followed, target não recebe hit", async () => {
    let targetHits = 0;
    const target = createServer((req, res) => {
      targetHits += 1;
      req.resume();
      req.on("end", () => {
        res.writeHead(200);
        res.end("should never be hit");
      });
    });
    const { port: targetPort, close: closeTarget } = await listen(target);

    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/internal` });
        res.end();
      });
    });
    const { port, close } = await listen(server);

    const result = await executeCallWebhook(
      baseCtx(),
      { url: `http://127.0.0.1:${port}/hook` },
      { skipUrlCheck: true, retryDelaysMs: [1, 1] },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("redirect_not_followed");
    expect(targetHits).toBe(0);

    await close();
    await closeTarget();
  }, 15_000);
});
