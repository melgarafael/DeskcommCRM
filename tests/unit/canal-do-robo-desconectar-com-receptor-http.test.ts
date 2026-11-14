/**
 * DESCONECTAR O ROBÔ DE MENSAGENS (#3486) CONTRA UM RECEPTOR HTTP DE VERDADE.
 *
 * A exclusão neutra da conexão (`DELETE /api/v1/channel-sessions/[id]`) tenta
 * apagar o webhook do robô no fornecedor ANTES de girar o token do caminho —
 * senão o fornecedor seguiria entregando numa URL que virou 404. É best-effort:
 * se o fornecedor falha, a exclusão que o operador pediu segue, e a auditoria
 * registra `robo: "falhou"`.
 *
 * O handler e `desligarRoboNoFornecedor` rodam de verdade; o receptor local faz
 * o papel da Bot API (`TELEGRAM_API_BASE_URL`), e o que se afirma é o que chegou
 * pelo fio. Dublês só no banco, na cifra e na auditoria.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const TOKEN = "123456789:AAH-token-de-prova-local";

const h = vi.hoisted(() => ({
  escritas: [] as string[],
  audit: vi.fn(async (_e: unknown) => undefined),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: vi.fn(),
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "33333333-3333-4333-8333-333333333333", idioma: "pt-BR", full_name: "Ana", email: "a@x.test" },
    org: { orgId: ORG, role: "admin" },
  })),
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn(async () => false), loadAuthUser: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/channels/health", () => ({ resolverSaudeDaConexaoRemovida: vi.fn(async () => "sem_mudanca") }));
vi.mock("@/lib/channels/central-de-pausa", () => ({ sincronizarAvisoDePausa: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_a: unknown, texto: string) => `enc:${texto}`,
  decryptWebhookSecret: async (_a: unknown, cifrado: string) => cifrado.replace(/^enc:/, ""),
}));
// Admin: as contagens do impacto voltam zero (canal virgem → hard delete) e a
// leitura da credencial devolve o token cifrado do robô.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from() {
      let op = "select";
      const q = {
        select: () => q,
        eq: () => q,
        update: () => ((op = "update"), q),
        delete: () => ((op = "delete"), q),
        maybeSingle: async () => ({ data: { telegram_token_encrypted: `enc:${TOKEN}` }, error: null }),
        then: (ok: (r: unknown) => unknown) => {
          if (op !== "select") h.escritas.push(`admin:${op}`);
          return Promise.resolve({ count: 0, data: null, error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from() {
      let op = "select";
      const q = {
        select: () => q,
        eq: () => q,
        update: () => ((op = "update"), q),
        delete: () => ((op = "delete"), q),
        maybeSingle: async () => ({
          data: {
            id: CANAL,
            provider: "telegram",
            waha_session_name: null,
            display_name: "Acme",
            phone_number: null,
            meta_phone_number_id: null,
            meta_token_encrypted: null,
            zernio_credencial_da_instalacao: false,
          },
          error: null,
        }),
        then: (ok: (r: unknown) => unknown) => {
          h.escritas.push(op);
          return Promise.resolve({ data: null, error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));

const recebidos: { caminho: string; corpo: Record<string, unknown> }[] = [];
let fornecedorFalha = false;
let servidor: Server;

async function lerCorpo(req: IncomingMessage): Promise<Record<string, unknown>> {
  let bruto = "";
  for await (const parte of req) bruto += String(parte);
  return bruto ? (JSON.parse(bruto) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  servidor = createServer(async (req, res) => {
    const caminho = req.url ?? "";
    recebidos.push({ caminho, corpo: await lerCorpo(req) });
    const ok = caminho.endsWith("/deleteWebhook") && !fornecedorFalha;
    res.writeHead(ok ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, result: true } : { ok: false, error_code: 500, description: "Internal" }));
  });
  await new Promise<void>((pronto) => servidor.listen(0, "127.0.0.1", pronto));
  const { port } = servidor.address() as AddressInfo;
  process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.TELEGRAM_API_BASE_URL;
  await new Promise<void>((fim) => servidor.close(() => fim()));
});

beforeEach(() => {
  recebidos.length = 0;
  h.escritas = [];
  h.audit.mockClear();
  fornecedorFalha = false;
});

const { DELETE } = await import("@/app/api/v1/channel-sessions/[id]/route");
const { BOT_CHANNEL_PROVIDER } = await import("@/lib/channels/bot/connect");

async function excluir(): Promise<Response> {
  return DELETE(new NextRequest(`https://crm.test/api/v1/channel-sessions/${CANAL}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: CANAL }),
  });
}

function metadataDaAuditoria(): Record<string, unknown> {
  expect(h.audit).toHaveBeenCalledTimes(1);
  return (h.audit.mock.calls[0]![0] as { metadata: Record<string, unknown> }).metadata;
}

describe("excluir a conexão do robô", () => {
  it("o provider do dublê é o do robô (senão o teste exercitaria outro ramo)", () => {
    expect(BOT_CHANNEL_PROVIDER).toBe("telegram");
  });

  it("chama deleteWebhook no fornecedor, com o token no caminho, e a exclusão acontece", async () => {
    const r = await excluir();
    expect(r.status).toBe(200);
    expect(recebidos.map((x) => x.caminho)).toEqual([`/bot${TOKEN}/deleteWebhook`]);
    expect(recebidos[0]!.corpo).toEqual({ drop_pending_updates: false });
    expect(h.escritas).toEqual(["delete"]);
    expect(metadataDaAuditoria()).toMatchObject({ provider: "telegram", robo: "desfeito" });
  });

  it("fornecedor falha: a exclusão segue e a auditoria registra robo: 'falhou'", async () => {
    fornecedorFalha = true;
    const r = await excluir();
    expect(r.status).toBe(200);
    expect(recebidos.map((x) => x.caminho)).toEqual([`/bot${TOKEN}/deleteWebhook`]);
    expect(h.escritas).toEqual(["delete"]);
    expect(metadataDaAuditoria()).toMatchObject({ robo: "falhou" });
  });
});
