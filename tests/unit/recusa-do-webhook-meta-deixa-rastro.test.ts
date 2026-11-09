import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A RECUSA DO WEBHOOK DA META DEIXA RASTRO E NÃO PEDE REENTREGA (issue #290, item 3).
 *
 * O defeito: payload fora do contrato respondia 400. A Meta reentrega tudo que não
 * recebe 2xx, em backoff — então um corpo que nunca vai melhorar virava laço por
 * horas, e reentregas assim podem suspender a WABA. O desenho é o do lado WAHA,
 * que já está na main: responder 200, arquivar o corpo cru com `status = 'error'`
 * e o motivo, e avisar na Central.
 *
 * O que estes casos observam é o COMPORTAMENTO: o status HTTP, a linha que chegou
 * ao arquivo (`webhook_events_log`) e o aviso que chegou à Central
 * (`agent_inbox_items`). Nenhum caso pergunta se um símbolo existe.
 *
 * O que NÃO pode mudar, e está aqui de propósito:
 *   - assinatura: corpo torto SEM HMAC válido continua 401 e não vira linha;
 *   - idempotência: a MESMA entrega repetida não cria segunda linha nem segundo aviso;
 *   - sucesso: payload real bem assinado continua 200 e é ingerido;
 *   - o GET de verificação continua respondendo o challenge em texto puro.
 */

const SESSAO = { id: "sess-1", organizationId: "org-1", wabaId: "2434045433735175" };
const APP_SECRET = "app-secret-de-teste";
const VERIFY_TOKEN = "verify-token-de-teste";
const TOKEN = "token-de-teste-do-webhook-meta";
const ingeridos: unknown[] = [];

vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: async () => SESSAO,
}));

vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: async () => ({ appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN }),
}));

vi.mock("@/lib/channels/meta/ingest", () => ({
  ingestMetaEcho: async () => ({ status: "ingested" }),
  ingestMetaInbound: async (_a: unknown, e: unknown) => {
    ingeridos.push(e);
    return { status: "ingested" };
  },
  ingestMetaReaction: async () => ({ status: "ingested" }),
  ingestMetaAppContactSync: async () => ({ status: "ingested" }),
}));

/**
 * O banco de mentira: guarda o que foi arquivado e o que foi avisado, e imita o
 * que o Postgres faria com a chave de idempotência — a segunda entrega com o
 * MESMO id responde `23505`, como um INSERT repetido de verdade.
 */
const arquivados = new Map<string, Record<string, unknown>>();
const avisos: Record<string, unknown>[] = [];

/** Cadeia do PostgREST: todo filtro devolve a si mesma e a promessa resolve no fim. */
function cadeia(resultado: unknown): Record<string, unknown> {
  const p = Promise.resolve(resultado) as unknown as Record<string, unknown>;
  p.eq = () => p;
  p.neq = () => p;
  p.is = () => p;
  p.select = () => p;
  p.order = () => p;
  p.limit = () => p;
  p.maybeSingle = async () => resultado;
  return p;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      insert: (linha: Record<string, unknown>) => {
        if (tabela === "webhook_events_log") {
          const id = String(linha.id);
          if (arquivados.has(id)) {
            return cadeia({ data: null, error: { code: "23505", message: "duplicate key" } });
          }
          arquivados.set(id, linha);
          return cadeia({ data: { id }, error: null });
        }
        if (tabela === "agent_inbox_items") {
          const jaAberto = avisos.some(
            (a) =>
              a.organization_id === linha.organization_id &&
              a.kind === linha.kind &&
              a.title === linha.title &&
              a.status === "open",
          );
          if (jaAberto) {
            return cadeia({ data: null, error: { code: "23505", message: "duplicate key" } });
          }
          avisos.push({ ...linha, status: "open" });
          return cadeia({ data: null, error: null });
        }
        return cadeia({ data: null, error: null });
      },
      update: () => cadeia({ data: null, error: null }),
      select: () => cadeia({ data: [], error: null }),
    }),
  }),
}));

import { POST, GET } from "@/app/api/v1/webhooks/meta/[token]/route";

const assinado = (corpo: unknown) => {
  const cru = typeof corpo === "string" ? corpo : JSON.stringify(corpo);
  return {
    text: async () => cru,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(cru, "utf8").digest("hex")}`,
    }),
  } as never;
};

const ctx = { params: Promise.resolve({ token: TOKEN }) } as never;

/** `entry` que não é lista: o payload fora do contrato medido na rota. */
const FORA_DO_CONTRATO = { object: "whatsapp_business_account", entry: 3 };

beforeEach(() => {
  arquivados.clear();
  avisos.length = 0;
  ingeridos.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("(a) payload fora do contrato: 200, linha de ERRO com motivo e aviso", () => {
  it("responde 200 dizendo que recusou — não mente dizendo que processou", async () => {
    const res = await POST(assinado(FORA_DO_CONTRATO), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      received: 0,
      accepted: false,
      outcomes: ["recusado:contrato_violado"],
      reason: "payload_fora_do_contrato",
      campos: ["entry"],
      arquivo: "error",
    });
    expect(ingeridos).toHaveLength(0);
  });

  it("a linha do arquivo nasce `error`, com o motivo e o corpo cru — nunca `received`", async () => {
    await POST(assinado(FORA_DO_CONTRATO), ctx);

    expect(arquivados.size).toBe(1);
    const linha = [...arquivados.values()][0] ?? {};
    expect(linha).toMatchObject({
      organization_id: "org-1",
      channel_session_id: "sess-1",
      provider: "meta_cloud",
      webhook_path_token: TOKEN,
      http_method: "POST",
      raw_body: JSON.stringify(FORA_DO_CONTRATO),
      valid_signature: true,
      status: "error",
      attempts: 0,
    });
    // O prefixo é o mesmo contrato do lado WAHA: quem relê distingue pelo prefixo
    // o corpo que NUNCA vai passar do que só falhou por um instante.
    expect(String(linha.error_message)).toMatch(/^contrato_violado: /);
    expect(String(linha.error_message)).toContain("entry");
    // `event_type` de provedor não existe neste payload; inventar um seria mentir
    // sobre o fio.
    expect(linha.event_type ?? null).toBeNull();
    expect(linha.payload_parsed).toEqual(FORA_DO_CONTRATO);
  });

  it("o aviso chega à Central uma vez, como degradação operacional (`other`)", async () => {
    await POST(assinado(FORA_DO_CONTRATO), ctx);

    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({
      organization_id: "org-1",
      kind: "other",
      severity: "warn",
      ref_kind: null,
      ref_id: null,
    });
    expect(String(avisos[0]?.title)).toContain("Meta");
    // O motivo técnico fica no arquivo e no log; o corpo do aviso é fixo para não
    // virar PII nem deduplicar por texto diferente a cada entrega.
    expect(String(avisos[0]?.body)).not.toContain("entry");
  });

  it("o log estruturado continua saindo no nível `error`", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi
      .spyOn((await import("@/lib/logger")).logger, "error")
      .mockImplementation(() => undefined);

    await POST(assinado(FORA_DO_CONTRATO), ctx);

    const chamadas = [...log.mock.calls, ...erro.mock.calls].map((c) => String(c[0]));
    expect(chamadas.some((c) => c.includes("fora do contrato"))).toBe(true);
  });
});

describe("(b) a mesma entrega repetida não cria segundo evento nem segundo aviso", () => {
  it("duas entregas idênticas: 200 nas duas, UMA linha e UM aviso", async () => {
    const primeira = await POST(assinado(FORA_DO_CONTRATO), ctx);
    const segunda = await POST(assinado(FORA_DO_CONTRATO), ctx);

    expect(primeira.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(arquivados.size, "a reentrega da Meta criou um segundo evento").toBe(1);
    expect(avisos, "a reentrega abriu um segundo aviso").toHaveLength(1);

    // A segunda resposta diz que já estava arquivado — não finge trabalho novo.
    expect(await segunda.json()).toMatchObject({ arquivo: "ja_arquivado", accepted: false });
  });

  it("a chave de idempotência é o conteúdo da entrega, não o horário de chegada", async () => {
    await POST(assinado(FORA_DO_CONTRATO), ctx);
    const primeiroId = [...arquivados.keys()][0];

    // Corpo diferente do mesmo formato é OUTRA entrega: ganha linha própria.
    await POST(assinado({ object: "whatsapp_business_account", entry: "x" }), ctx);

    expect(arquivados.size).toBe(2);
    expect([...arquivados.keys()][0]).toBe(primeiroId);
    // As duas linhas continuam distinguíveis e nenhuma virou sucesso.
    expect([...arquivados.values()].every((l) => l.status === "error")).toBe(true);
  });
});

describe("(c) assinatura inválida continua recusada e NÃO vira evento", () => {
  it("corpo torto sem HMAC: 401, arquivo vazio, nenhum aviso", async () => {
    const res = await POST(
      { text: async () => JSON.stringify(FORA_DO_CONTRATO), headers: new Headers() } as never,
      ctx,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(arquivados.size, "payload não autenticado entrou no arquivo").toBe(0);
    expect(avisos).toHaveLength(0);
    expect(ingeridos).toHaveLength(0);
  });

  it("HMAC de outro segredo: 401 e nada gravado", async () => {
    const corpo = JSON.stringify(FORA_DO_CONTRATO);
    const errada = `sha256=${createHmac("sha256", "segredo-errado").update(corpo, "utf8").digest("hex")}`;

    const res = await POST(
      { text: async () => corpo, headers: new Headers({ "x-hub-signature-256": errada }) } as never,
      ctx,
    );

    expect(res.status).toBe(401);
    expect(arquivados.size).toBe(0);
    expect(avisos).toHaveLength(0);
  });
});

describe("(d) sucesso continua sucesso", () => {
  it("payload real bem assinado: 200, ingerido, e nenhuma linha de erro", async () => {
    const { readFileSync } = await import("node:fs");
    const reais = JSON.parse(
      readFileSync("tests/fixtures/meta/inbound-webhooks.json", "utf8"),
    ) as unknown[];

    const res = await POST(assinado(reais[0]), ctx);

    expect(res.status).toBe(200);
    expect(ingeridos).toHaveLength(1);
    expect(arquivados.size).toBe(0);
    expect(avisos).toHaveLength(0);
  });
});

describe("(e) o GET de verificação continua intocado", () => {
  const pedidoGet = (params: Record<string, string>) =>
    ({
      nextUrl: new URL(
        `https://exemplo.test/api/v1/webhooks/meta/${TOKEN}?${new URLSearchParams(params)}`,
      ),
    }) as never;

  it("devolve o challenge em texto puro", async () => {
    const res = await GET(
      pedidoGet({
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "12345",
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("12345");
  });

  it("verify token errado continua 403", async () => {
    const res = await GET(
      pedidoGet({ "hub.mode": "subscribe", "hub.verify_token": "outro", "hub.challenge": "12345" }),
      ctx,
    );

    expect(res.status).toBe(403);
  });
});
