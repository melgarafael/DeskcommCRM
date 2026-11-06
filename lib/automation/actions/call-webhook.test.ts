import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import {
  assinaturaComCarimbo,
  executeCallWebhook,
  idDaEntrega,
  tentativasRegistradas,
  uuidV5,
} from "@/lib/automation/actions/call-webhook";
import type { ActionCtx } from "@/lib/automation/types";

function baseCtx(overrides: Partial<ActionCtx["event"]> = {}): ActionCtx {
  return {
    admin: {} as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
  ruleName: "Automação de teste",
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
    // Sem segredo não há o que assinar — mas id, tentativa e carimbo saem (#1529).
    expect(received!.headers["x-webhook-signature"]).toBeUndefined();
    expect(received!.headers["x-webhook-delivery"]).toBe(idDaEntrega("evt-1", "rule-1", 0, []));
    expect(received!.headers["x-webhook-attempt"]).toBe("1");
    expect(received!.headers["x-webhook-timestamp"]).toMatch(/^\d{10}$/);

    const parsedBody = JSON.parse(received!.body);
    expect(parsedBody.event).toBe("lead.created");
    expect(typeof parsedBody.occurred_at).toBe("string");
    expect(parsedBody.data).toEqual({ foo: "bar", lead: { id: "lead-1", title: "Fulano" } });
    expect(parsedBody.organization_id).toBeUndefined();
    expect(JSON.stringify(parsedBody)).not.toContain("org-1");

    await close();
  });

  // Critério de aceite nº 4 (issue #1536): `won_reason` gravado APARECE no
  // envelope de webhook — junto do resto do lead projetado, e sem abrir a
  // linha inteira (o projeto existe justamente para não vazar organization_id,
  // consent e source_metadata).
  it("o envelope do webhook traz won_reason junto dos campos públicos do lead", async () => {
    let body = "";
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        body = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const { port, close } = await listen(server);

    const ctx = baseCtx();
    ctx.context = {
      lead: {
        id: "lead-1",
        title: "Fulano",
        status: "won",
        won_reason: "Renovação anual",
        organization_id: "org-1",
        consent: "NAO_PODE_SAIR",
      },
    };

    const result = await executeCallWebhook(
      ctx,
      { url: `http://127.0.0.1:${port}/hook` },
      { skipUrlCheck: true },
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(body) as { data: { lead?: Record<string, unknown> } };
    expect(parsed.data.lead?.won_reason).toBe("Renovação anual");
    // O que o projeto existe para proteger continua fora.
    expect(body).not.toContain("org-1");
    expect(body).not.toContain("NAO_PODE_SAIR");

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

  // ─── #1612: o responsável é OPT-IN ────────────────────────────────────────
  const OWNER = "99999999-0000-4000-8000-000000000099";
  const COMPROMISSO = {
    appointment_id: "fff00000-0000-4000-8000-00000000000f",
    inicio: "2026-09-02T13:00:00.000Z",
    fim: "2026-09-02T13:30:00.000Z",
    situacao: "confirmed",
  };

  function ctxDeCompromisso(): ActionCtx {
    return {
      ...baseCtx({
        event_type: "appointment.created",
        entity_kind: "calendar_appointment",
        entity_id: COMPROMISSO.appointment_id,
        payload: { ...COMPROMISSO },
      }),
      context: { appointment: { id: COMPROMISSO.appointment_id, owner_user_id: OWNER } },
    };
  }

  async function corpoRecebido(
    ctx: ActionCtx,
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let body = "";
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        body = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200);
        res.end("ok");
      });
    });
    const { port, close } = await listen(server);
    const result = await executeCallWebhook(ctx, { url: `http://127.0.0.1:${port}/hook`, ...config }, {
      skipUrlCheck: true,
    });
    await close();
    expect(result.status).toBe("success");
    return JSON.parse(body).data as Record<string, unknown>;
  }

  it("sem include_owner, o responsável não aparece no corpo (#1612)", async () => {
    const data = await corpoRecebido(ctxDeCompromisso(), {});

    // O compromisso e o horário SAEM (é o ponto da issue); quem atende, não.
    expect(data.inicio).toBe(COMPROMISSO.inicio);
    expect(data.situacao).toBe("confirmed");
    expect(data).not.toHaveProperty("owner");
    expect(data).not.toHaveProperty("owner_user_id");
  });

  it("com include_owner: true, o responsável aparece — o opt-in abre a chave", async () => {
    const data = await corpoRecebido(ctxDeCompromisso(), { include_owner: true });

    expect(data.inicio).toBe(COMPROMISSO.inicio);
    expect(data.owner).toEqual({ id: OWNER });
  });

  it("include_owner: o nome do responsável só sai para membro da organização da regra", async () => {
    function adminCom(membros: string[]): ActionCtx["admin"] {
      let org: unknown = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vinculos: any = {
        select: () => vinculos,
        eq: (_col: string, v: unknown) => ((org = v), vinculos),
        in: async () => ({
          data: org === "org-1" ? membros.map((user_id) => ({ user_id })) : [],
          error: null,
        }),
      };
      return {
        from: () => vinculos,
        auth: {
          admin: {
            getUserById: async () => ({
              data: { user: { user_metadata: { full_name: "Ana" } } },
              error: null,
            }),
          },
        },
      } as unknown as ActionCtx["admin"];
    }

    const membro = { ...ctxDeCompromisso(), admin: adminCom([OWNER]) };
    expect((await corpoRecebido(membro, { include_owner: true })).owner).toEqual({
      id: OWNER,
      name: "Ana",
    });

    const deFora = { ...ctxDeCompromisso(), admin: adminCom([]) };
    expect((await corpoRecebido(deFora, { include_owner: true })).owner).toEqual({ id: OWNER });
  });

  it("o endereço e o link saem da linha ATUAL do compromisso, não do evento", async () => {
    const ctx = ctxDeCompromisso();
    ctx.context = {
      appointment: {
        id: COMPROMISSO.appointment_id,
        location_kind: "google_meet",
        location_details: "Sala 2",
        meeting_state: "ready",
        meeting_url: "https://meet.google.com/abc-defg-hij",
      },
    };

    const data = await corpoRecebido(ctx, {});

    expect(data.local).toEqual({ tipo: "google_meet", descricao: "Sala 2" });
    expect(data.meeting_url).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("compromisso já anonimizado ou com Meet cancelado: nada do que o banco anulou vai para fora", async () => {
    const ctx = ctxDeCompromisso();
    ctx.context = {
      appointment: {
        id: COMPROMISSO.appointment_id,
        location_kind: "google_meet",
        location_details: null,
        meeting_state: "cancelled",
        meeting_url: "https://meet.google.com/abc-defg-hij",
      },
    };

    const data = await corpoRecebido(ctx, {});

    expect(data.local).toEqual({ tipo: "google_meet", descricao: null });
    expect(data).not.toHaveProperty("meeting_url");
  });

  it("include_owner num compromisso SEM dono: a chave não nasce com null vazio", async () => {
    const ctx = ctxDeCompromisso();
    ctx.context = { appointment: { id: COMPROMISSO.appointment_id, owner_user_id: null } };

    const data = await corpoRecebido(ctx, { include_owner: true });

    expect(data).not.toHaveProperty("owner");
  });
});

// ─── #1529: id de entrega, tentativa e assinatura com carimbo de tempo ──────
//
// O VETOR abaixo é referência para quem integra (o guia em
// docs/integracao/webhooks-de-saida.md repete os mesmos valores): quem
// implementar a verificação do outro lado confere a própria conta contra ele.
// Os valores foram calculados de forma independente (uuid5 + hmac da stdlib do
// Python e node:crypto) — não saíram do código que este teste guarda.
const VETOR = {
  segredo: "segredo-de-exemplo-nao-use-em-producao",
  carimbo: 1767225600,
  eventId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  ruleId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  indiceDaAcao: 1,
  // A lista inteira da regra também compõe o id; o segredo fica de fora dela.
  acoes: [
    { type: "add_tag", config: { tag: "novo" } },
    {
      type: "call_webhook",
      config: { url: "https://exemplo.test/webhook", secret: "segredo-de-exemplo-nao-use-em-producao" },
    },
  ],
  entrega: "209f529f-3a34-5ccb-9486-5e20cd48fb45",
  corpo:
    '{"event":"lead.created","occurred_at":"2026-01-01T00:00:00.000Z","happened_at":"2025-12-31T21:00:00.000Z","delivery_id":"209f529f-3a34-5ccb-9486-5e20cd48fb45","data":{"lead":{"id":"lead-1"}}}',
  v1: "bccb00c040649c7e2618d9cd4a3bc79ade96d5dd939c0fb11f26064c538e57a5",
  legada: "6aa08c69080a291fadcdd6913d78e79dbd2705a95b3cf87c8a0018491a1a8dab",
} as const;

type Recebida = { headers: Record<string, string | string[] | undefined>; body: string };

/** Receptor que guarda TODAS as requisições e responde o status da vez. */
async function receptor(statusPorChamada: number[]): Promise<{
  url: string;
  recebidas: Recebida[];
  close: () => Promise<void>;
}> {
  const recebidas: Recebida[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      recebidas.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(statusPorChamada[recebidas.length - 1] ?? 200);
      res.end("ok");
    });
  });
  const { port, close } = await listen(server);
  return { url: `http://127.0.0.1:${port}/hook`, recebidas, close };
}

function cabecalho(r: Recebida, nome: string): string {
  const valor = r.headers[nome];
  if (typeof valor !== "string") throw new Error(`cabeçalho ${nome} ausente`);
  return valor;
}

/** Confere a X-Webhook-Signature do jeito que o receptor confere: t do próprio cabeçalho. */
function conferirV2(r: Recebida, segredo: string): void {
  const assinatura = cabecalho(r, "x-webhook-signature");
  const partes = Object.fromEntries(assinatura.split(",").map((p) => p.split("=") as [string, string]));
  expect(partes.t).toBe(cabecalho(r, "x-webhook-timestamp"));
  const esperado = createHmac("sha256", segredo)
    .update(`${partes.t}.${cabecalho(r, "x-webhook-delivery")}.${r.body}`)
    .digest("hex");
  expect(partes.v1).toBe(esperado);
}

describe("webhook de saída — entrega identificada e assinatura com carimbo (#1529)", () => {
  it("vetor fixo: v1 = HMAC(segredo, \"<t>.<delivery>.<corpo>\")", () => {
    expect(assinaturaComCarimbo(VETOR.segredo, VETOR.carimbo, VETOR.entrega, VETOR.corpo)).toBe(
      `t=${VETOR.carimbo},v1=${VETOR.v1}`,
    );
    // O legado, sobre o mesmo corpo, segue sendo o HMAC só do corpo.
    expect(createHmac("sha256", VETOR.segredo).update(VETOR.corpo).digest("hex")).toBe(VETOR.legada);
  });

  it("uuid v5 confere com o vetor do RFC 9562 (A.4) e com o da documentação do Python", () => {
    const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(uuidV5("www.example.com", NAMESPACE_DNS)).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    expect(uuidV5("python.org", NAMESPACE_DNS)).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("id da entrega do vetor: evento + regra + posição da ação + lista de ações", () => {
    expect(idDaEntrega(VETOR.eventId, VETOR.ruleId, VETOR.indiceDaAcao, VETOR.acoes)).toBe(VETOR.entrega);
    // A posição entra no id: a ação 0 e a 1 da mesma regra são entregas diferentes.
    expect(idDaEntrega(VETOR.eventId, VETOR.ruleId, 0, VETOR.acoes)).not.toBe(VETOR.entrega);
  });

  it("trocar só o segredo (ou a ordem das chaves da config) não muda o id", () => {
    const [tag, webhook] = VETOR.acoes;
    const outroSegredo = [tag, { type: "call_webhook", config: { secret_enc: "cifrado", url: webhook.config.url } }];
    expect(idDaEntrega(VETOR.eventId, VETOR.ruleId, 1, outroSegredo)).toBe(VETOR.entrega);
  });

  it("ação removida antes do Reenviar: a que herda a posição NÃO herda o id", () => {
    // Duas ações para a mesma URL; a 0 chegou, a 1 falhou. O operador remove a
    // 0 para reenviar só a outra — que passa a ser a posição 0. Se ela saísse
    // com o id da 0, o receptor a descartaria como duplicata, em silêncio.
    const a = { type: "call_webhook", config: { url: "https://x.test/hook", include_owner: true } };
    const b = { type: "call_webhook", config: { url: "https://x.test/hook" } };
    const idDaA = idDaEntrega(VETOR.eventId, VETOR.ruleId, 0, [a, b]);
    const idDaB = idDaEntrega(VETOR.eventId, VETOR.ruleId, 1, [a, b]);
    const bSozinha = idDaEntrega(VETOR.eventId, VETOR.ruleId, 0, [b]);
    expect(bSozinha).not.toBe(idDaA);
    // Configs iguais também: é a lista que mudou, não só a ação.
    expect(idDaEntrega(VETOR.eventId, VETOR.ruleId, 0, [b])).not.toBe(idDaEntrega(VETOR.eventId, VETOR.ruleId, 0, [b, b]));
    // Com a lista intacta, o id é estável — é o que o Reenviar sem edição reaproveita.
    expect(idDaEntrega(VETOR.eventId, VETOR.ruleId, 1, [a, b])).toBe(idDaB);
  });

  it("toda entrega com segredo leva os quatro cabeçalhos novos E o legado", async () => {
    const r = await receptor([200]);
    const ctx = baseCtx({ id: VETOR.eventId });
    ctx.ruleId = VETOR.ruleId;
    ctx.actionIndex = VETOR.indiceDaAcao;
    ctx.ruleActions = VETOR.acoes;

    const antes = Math.floor(Date.now() / 1000);
    const result = await executeCallWebhook(ctx, { url: r.url, secret: VETOR.segredo }, { skipUrlCheck: true });
    const depois = Math.floor(Date.now() / 1000);
    await r.close();

    expect(result.status).toBe("success");
    expect(result.detail).toMatchObject({ attempt: 1, delivery_id: VETOR.entrega });
    const [recebida] = r.recebidas;
    if (!recebida) throw new Error("nada chegou");
    expect(cabecalho(recebida, "x-webhook-delivery")).toBe(VETOR.entrega);
    expect(cabecalho(recebida, "x-webhook-attempt")).toBe("1");
    const carimbo = Number(cabecalho(recebida, "x-webhook-timestamp"));
    expect(carimbo).toBeGreaterThanOrEqual(antes);
    expect(carimbo).toBeLessThanOrEqual(depois);
    conferirV2(recebida, VETOR.segredo);
    expect(cabecalho(recebida, "x-deskcomm-signature")).toBe(
      createHmac("sha256", VETOR.segredo).update(recebida.body).digest("hex"),
    );
    // O corpo carrega o mesmo id do cabeçalho.
    expect(JSON.parse(recebida.body).delivery_id).toBe(VETOR.entrega);
  });

  it("três tentativas da mesma entrega: o mesmo Delivery e Attempt 1, 2, 3", async () => {
    const r = await receptor([500, 503, 500]);
    const result = await executeCallWebhook(
      baseCtx(),
      { url: r.url, secret: "s3cr3t" },
      { skipUrlCheck: true, retryDelaysMs: [1, 1] },
    );
    await r.close();

    expect(result.status).toBe("failed");
    expect(result.detail).toMatchObject({ attempts: 3, attempt: 3, delivery_id: idDaEntrega("evt-1", "rule-1", 0, []) });
    expect(r.recebidas).toHaveLength(3);
    const entregas = new Set(r.recebidas.map((x) => cabecalho(x, "x-webhook-delivery")));
    expect([...entregas]).toEqual([idDaEntrega("evt-1", "rule-1", 0, [])]);
    expect(r.recebidas.map((x) => cabecalho(x, "x-webhook-attempt"))).toEqual(["1", "2", "3"]);
    // O corpo é o mesmo em todas — o que muda é carimbo e assinatura com carimbo.
    expect(new Set(r.recebidas.map((x) => x.body)).size).toBe(1);
    for (const recebida of r.recebidas) conferirV2(recebida, "s3cr3t");
  }, 15_000);

  it("Reenviar no executor: primeiraTentativa 4 mantém o Delivery e manda Attempt 4", async () => {
    const r = await receptor([200]);
    const result = await executeCallWebhook(
      baseCtx(),
      { url: r.url },
      { skipUrlCheck: true, primeiraTentativa: 4 },
    );
    await r.close();

    expect(result.detail).toMatchObject({ attempt: 4, delivery_id: idDaEntrega("evt-1", "rule-1", 0, []) });
    const [recebida] = r.recebidas;
    if (!recebida) throw new Error("nada chegou");
    expect(cabecalho(recebida, "x-webhook-delivery")).toBe(idDaEntrega("evt-1", "rule-1", 0, []));
    expect(cabecalho(recebida, "x-webhook-attempt")).toBe("4");
  });

  // Ajuste sobre o #1830: `occurred_at` é contrato público e segue sendo a
  // hora do ENVIO; a hora do fato sai num campo novo, `happened_at`.
  it("envio adiado: occurred_at é a hora do envio, happened_at é event.created_at", async () => {
    const r = await receptor([200, 200]);
    const antes = Date.now();
    await executeCallWebhook(
      baseCtx({ created_at: "2026-01-01T00:00:00.000Z" }),
      { url: r.url },
      { skipUrlCheck: true },
    );
    // A forma em que o PostgREST devolve timestamptz: microssegundos e +00:00.
    await executeCallWebhook(
      baseCtx({ created_at: "2026-03-04T05:06:07.123456+00:00" }),
      { url: r.url },
      { skipUrlCheck: true },
    );
    const depois = Date.now();
    await r.close();

    const corpos = r.recebidas.map((x) => JSON.parse(x.body) as { occurred_at: string; happened_at: string });
    expect(corpos.map((c) => c.happened_at)).toEqual(["2026-01-01T00:00:00.000Z", "2026-03-04T05:06:07.123Z"]);
    for (const corpo of corpos) {
      expect(corpo.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const enviadoEm = Date.parse(corpo.occurred_at);
      expect(enviadoEm).toBeGreaterThanOrEqual(antes);
      expect(enviadoEm).toBeLessThanOrEqual(depois);
    }
  });

  it("sem created_at (ou inválido), happened_at cai para a hora do envio", async () => {
    const r = await receptor([200, 200]);
    const antes = Date.now();
    await executeCallWebhook(baseCtx(), { url: r.url }, { skipUrlCheck: true });
    await executeCallWebhook(baseCtx({ created_at: "não é data" }), { url: r.url }, { skipUrlCheck: true });
    const depois = Date.now();
    await r.close();

    for (const recebida of r.recebidas) {
      const quando = Date.parse((JSON.parse(recebida.body) as { happened_at: string }).happened_at);
      expect(quando).toBeGreaterThanOrEqual(antes);
      expect(quando).toBeLessThanOrEqual(depois);
    }
  });

  it("tentativasRegistradas: só a entrega pedida, legado conta, outra ação não", () => {
    const entrega = idDaEntrega("evt-1", "rule-1", 1, []);
    const outra = idDaEntrega("evt-1", "rule-1", 2, []);
    expect(tentativasRegistradas([], entrega)).toBe(0);
    expect(
      tentativasRegistradas(
        [
          { actions_result: [{ type: "call_webhook", status: "success", detail: { attempt: 2, delivery_id: entrega } }] },
          { actions_result: [{ type: "call_webhook", status: "success", detail: { attempt: 9, delivery_id: outra } }] },
          { actions_result: [{ type: "add_tag", status: "success", detail: { attempt: 7 } }] },
        ],
        entrega,
      ),
    ).toBe(2);
    // Resultado de antes do #1529: sem delivery_id, falha só com `attempts`.
    expect(
      tentativasRegistradas(
        [{ actions_result: [{ type: "call_webhook", status: "failed", detail: { response_status: 500, attempts: 3 } }] }],
        entrega,
      ),
    ).toBe(3);
    // Coluna com lixo não derruba o Reenviar.
    expect(tentativasRegistradas([{ actions_result: null }, { actions_result: ["x", 1] }], entrega)).toBe(0);
  });
});
