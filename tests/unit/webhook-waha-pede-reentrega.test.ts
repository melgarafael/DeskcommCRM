import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O webhook WAHA não perde a mensagem quando o banco falha por um instante.
 *
 * Antes: `dispatchWahaEvent` falhava (ou nem falhava — a ingestão engolia), a
 * rota devolvia 200, o WAHA riscava o evento, e a linha em `webhook_events_log`
 * ficava `received` para sempre, igual a um evento que deu certo. Três mensagens
 * de cliente perdidas em 14/09/2026 e duas na troca de banco de 24/09.
 *
 * Agora, medido pelo que a rota RESPONDE e pelo que ela GRAVA no arquivo:
 *   - falha transitória → 503 + Retry-After, arquivo `error` com `transitoria:`;
 *   - falha permanente → 200 (não adianta martelar), arquivo `error`;
 *   - sucesso → 200, arquivo `processed`;
 * e o cron `webhook-replay` relê o que ficou `transitoria:`, desiste com aviso
 * na Central depois do teto, e para cedo quando o banco ainda não voltou.
 */

const SESSAO = {
  id: "sess-1",
  organization_id: "org-1",
  waha_session_name: "default",
  webhook_secret_encrypted: "\\x00",
  status: "WORKING",
  is_warmup_complete: true,
  warmup_started_at: null,
};
const TOKEN = "token-da-rota-de-producao-0001";

interface Op {
  tabela: string;
  op: "insert" | "update" | "select";
  valores?: Record<string, unknown>;
  filtros: Array<[string, unknown]>;
}
const ops: Op[] = [];
/** O que o SELECT de `webhook_events_log` do cron devolve. */
let arquivoPendente: Record<string, unknown>[] = [];
/** Avisos já abertos na Central (o dedupe consulta isto). */
let avisoAberto = false;
/** Quando true, todo UPDATE devolve erro — o banco está fora. */
let updateFalha = false;

function consulta(tabela: string, op: Op["op"], valores?: Record<string, unknown>) {
  const registro: Op = { tabela, op, filtros: [], ...(valores ? { valores } : {}) };
  ops.push(registro);
  const resultado = () => {
    if (op === "update") return { data: null, error: updateFalha ? { message: "down" } : null };
    if (op === "insert") return { data: { id: `${tabela}-novo` }, error: null };
    if (tabela === "webhook_events_log") return { data: arquivoPendente, error: null };
    if (tabela === "agent_inbox_items") return { data: avisoAberto ? { id: "aviso-1" } : null, error: null };
    return { data: null, error: null };
  };
  const q: Record<string, unknown> = {};
  for (const f of ["eq", "neq", "like", "lt", "is", "in"]) {
    q[f] = (col: string, v: unknown) => {
      registro.filtros.push([`${f}:${col}`, v]);
      return q;
    };
  }
  q.order = () => q;
  q.limit = () => q;
  q.select = () => q;
  q.maybeSingle = async () => resultado();
  q.then = (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve(resultado()).then(ok, ko);
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      insert: (v: Record<string, unknown>) => consulta(tabela, "insert", v),
      update: (v: Record<string, unknown>) => consulta(tabela, "update", v),
      select: () => consulta(tabela, "select"),
    }),
    rpc: async () => ({ data: "segredo-decifrado-longo", error: null }),
  }),
}));

vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => ({ data: SESSAO, error: null }),
}));

vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/waha/webhook-auth", () => ({
  authenticateWahaWebhook: () => ({ ok: true, signatureVerified: true }),
}));

/** O que a ingestão faz a cada chamada, na ordem; acabou a lista, dá certo. */
let roteiro: Array<"ok" | "transitoria" | "permanente"> = [];
let despachos = 0;
vi.mock("@/lib/waha/ingest", async (original) => {
  const ft = await import("@/lib/waha/falha-transitoria");
  return {
    ...(await original<Record<string, unknown>>()),
    dispatchWahaEvent: async () => {
      despachos += 1;
      const passo = roteiro.shift() ?? "ok";
      if (passo === "transitoria") {
        throw new ft.FalhaTransitoriaDeIngestao("messages.insert inbound", { code: "57014", message: "timeout" });
      }
      if (passo === "permanente") {
        throw new ft.FalhaPermanenteDeIngestao("messages.insert inbound", { code: "23502", message: "not null" });
      }
    },
  };
});

import { logger } from "@/lib/logger";
import { POST as postGlobal } from "@/app/api/v1/webhooks/waha/route";
import { POST as postPorToken } from "@/app/api/v1/webhooks/waha/[token]/route";
import { MAX_TENTATIVAS, reprocessarArquivoDeWebhooks } from "@/lib/channels/reprocessar-arquivo-de-webhook";
import { createAdminClient } from "@/lib/supabase/admin";
import { MENSAGEM_QUE_NAO_ENTROU } from "@/lib/event-log/aviso-de-evento-morto";

const EVENTO = {
  event: "message",
  session: "default",
  payload: { id: "wamid.OK", from: "5531988887777@c.us", body: "oi" },
};
const pedido = () =>
  ({
    text: async () => JSON.stringify(EVENTO),
    headers: new Headers({ "x-webhook-hmac": "sha512=abc" }),
  }) as never;

const ROTAS = [
  { nome: "global", chamar: () => postGlobal(pedido()) },
  { nome: "por token", chamar: () => postPorToken(pedido(), { params: Promise.resolve({ token: TOKEN }) }) },
] as const;

const desfechosGravados = () =>
  ops.filter((o) => o.tabela === "webhook_events_log" && o.op === "update").map((o) => o.valores);

beforeEach(() => {
  ops.length = 0;
  roteiro = [];
  despachos = 0;
  arquivoPendente = [];
  avisoAberto = false;
  updateFalha = false;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe.each(ROTAS)("rota $nome", ({ chamar }) => {
  it("banco fora por um instante → 503 com Retry-After, e o arquivo fica marcado para reprocessar", async () => {
    roteiro = ["transitoria"];
    const res = await chamar();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(desfechosGravados()).toEqual([
      expect.objectContaining({ status: "error", error_message: expect.stringMatching(/^transitoria:/) }),
    ]);
  });

  it("mesmo sem conseguir gravar o desfecho (banco todo fora), responde 503", async () => {
    roteiro = ["transitoria"];
    updateFalha = true;
    expect((await chamar()).status).toBe(503);
  });

  it("falha permanente → 200 como antes, mas o arquivo diz `error`, não `processed`", async () => {
    roteiro = ["permanente"];
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(desfechosGravados()).toEqual([
      expect.objectContaining({ status: "error", error_message: expect.stringMatching(/^handler:/) }),
    ]);
  });

  it("controle: sucesso → 200 e o arquivo vira `processed`", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(desfechosGravados()).toEqual([{ status: "processed", error_message: null }]);
  });
});

const linha = (id: string, attempts: number, payload: unknown = EVENTO) => ({
  id,
  organization_id: "org-1",
  channel_session_id: "sess-1",
  payload_parsed: payload,
  attempts,
  error_message: "transitoria: messages.insert inbound: 57014 timeout",
});
const replay = () => reprocessarArquivoDeWebhooks(createAdminClient(), new Date(), "req-cron");
const avisosAbertos = () =>
  ops.filter((o) => o.tabela === "agent_inbox_items" && o.op === "insert").map((o) => o.valores);

describe("cron webhook-replay", () => {
  it("só lê linhas `transitoria:` de WAHA em `error`, mais velhas que a espera", async () => {
    await replay();
    const leitura = ops.find((o) => o.tabela === "webhook_events_log" && o.op === "select");
    expect(leitura?.filtros).toEqual(
      expect.arrayContaining([
        ["eq:provider", "waha"],
        ["eq:status", "error"],
        ["like:error_message", "transitoria:%"],
        ["lt:received_at", expect.any(String)],
      ]),
    );
  });

  it("banco de volta → reprocessa e marca `processed`", async () => {
    arquivoPendente = [linha("l1", 3)];
    const r = await replay();
    expect(r).toEqual({ lidas: 1, processadas: 1, ainda_falhando: 0, desistidas: 0 });
    expect(desfechosGravados()).toContainEqual({ status: "processed", error_message: null });
  });

  it("ainda fora → soma uma tentativa e não desiste antes do teto", async () => {
    arquivoPendente = [linha("l1", 3)];
    roteiro = ["transitoria"];
    const r = await replay();
    expect(r.ainda_falhando).toBe(1);
    expect(desfechosGravados()).toContainEqual({ attempts: 4 });
    expect(avisosAbertos()).toEqual([]);
  });

  it("no teto → `dead` e UM aviso na Central, com o título da família", async () => {
    arquivoPendente = [linha("l1", MAX_TENTATIVAS - 1)];
    roteiro = ["transitoria"];
    const r = await replay();
    expect(r.desistidas).toBe(1);
    expect(desfechosGravados()).toContainEqual(
      expect.objectContaining({ status: "dead", attempts: MAX_TENTATIVAS }),
    );
    expect(avisosAbertos()).toEqual([
      expect.objectContaining({
        organization_id: "org-1",
        kind: "event_dead",
        severity: "critical",
        title: MENSAGEM_QUE_NAO_ENTROU.titulo,
      }),
    ]);
  });

  it("com aviso da mesma família já aberto, não abre outro", async () => {
    arquivoPendente = [linha("l1", MAX_TENTATIVAS - 1)];
    roteiro = ["transitoria"];
    avisoAberto = true;
    await replay();
    expect(avisosAbertos()).toEqual([]);
  });

  it("arquivo sem corpo (a retenção já limpou) → `dead` com aviso, sem chamar a ingestão", async () => {
    arquivoPendente = [linha("l1", 0, null)];
    const r = await replay();
    expect(despachos).toBe(0);
    expect(r.desistidas).toBe(1);
    expect(avisosAbertos()).toHaveLength(1);
  });

  it("três falhas seguidas na rodada → para de martelar o banco", async () => {
    arquivoPendente = [linha("l1", 0), linha("l2", 0), linha("l3", 0), linha("l4", 0), linha("l5", 0)];
    roteiro = ["transitoria", "transitoria", "transitoria", "transitoria", "transitoria"];
    const r = await replay();
    expect(despachos).toBe(3);
    expect(r.ainda_falhando).toBe(3);
  });
});
