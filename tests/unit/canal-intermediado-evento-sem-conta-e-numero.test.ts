import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as NextServer from "next/server";
import type * as EntradaAceita from "@/lib/channels/entrada-aceita";

import type * as Credenciais from "@/lib/channels/zernio/credentials";
import type * as Saude from "@/lib/channels/health";

/**
 * A ROTA do webhook do canal intermediado, ponta a ponta: o que entra e o que
 * muda o canal.
 *
 * O webhook do provedor é por espaço de trabalho, não por número. As regras
 * medidas aqui:
 *
 *   - evento com conta de outro número não é ingerido;
 *   - evento de mensagem SEM conta não é ingerido (o provedor documenta que
 *     `message.*` sempre traz a conta — ausência é anomalia);
 *   - `whatsapp.number.*` só muda o canal quando `number.phoneNumber` é o
 *     número desta sessão; sem número para comparar, fica só no arquivo.
 *
 * Cada caso negativo tem o seu controle positivo (mesmo corpo, conta/número
 * certo), para que "não ingeriu" não seja só "o dublê não sabe ingerir".
 */
const SEGREDO = "segredo-da-sessao-longo-o-bastante";
const CONTA_DA_SESSAO = "acc_sintetica_desta_sessao";
const OUTRA_CONTA = "acc_sintetica_de_outro_numero";
const NUMERO_DA_SESSAO = "+5511900000001";

const ops: { tabela: string; op: string; payload?: unknown }[] = [];

function cadeia(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          if (tabela === "channel_sessions" && op === "select") {
            return async () => ({
              data: {
                id: "sessao-1",
                organization_id: "org-1",
                provider: "zernio",
                display_name: "Número da loja",
                phone_number: NUMERO_DA_SESSAO,
                webhook_secret_encrypted: "\\xab",
                archived_at: null,
                zernio_account_id: CONTA_DA_SESSAO,
              },
              error: null,
            });
          }
          if (op === "select") return async () => ({ data: null, error: null });
          return async () => ({ data: { id: `${tabela}-novo` }, error: null });
        }
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
        return () => proxy;
      },
    },
  );
  ops.push({ tabela, op, payload });
  return proxy;
}

const admin = {
  rpc: async (nome: string, args: unknown) => {
    ops.push({ tabela: "rpc", op: nome, payload: args });
    return {
      data: nome.includes("contact") ? "contato-novo" : nome.includes("conversation") ? "conversa-nova" : null,
      error: null,
    };
  },
  from: (tabela: string) => ({
    select: () => cadeia(tabela, "select"),
    insert: (p: unknown) => cadeia(tabela, "insert", p),
    update: (p: unknown) => cadeia(tabela, "update", p),
    upsert: (p: unknown) => cadeia(tabela, "upsert", p),
    delete: () => cadeia(tabela, "delete"),
  }),
};

const saude = vi.hoisted(() => ({ chamadas: [] as unknown[] }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => SEGREDO }));
vi.mock("@/lib/channels/arquivo-de-webhook", () => ({
  abrirArquivoDoWebhook: async () => "arq",
  fecharArquivoDoWebhook: async (_a: unknown, _i: unknown, d: unknown) => {
    ops.push({ tabela: "webhook_events_log", op: "fechar", payload: d });
  },
}));
vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<typeof Credenciais>()),
  resolveZernioCreds: vi.fn(async () => null),
}));
vi.mock("@/lib/channels/health", async (orig) => ({
  ...(await orig<typeof Saude>()),
  sincronizarSaudeDaConexao: vi.fn(async (_a: unknown, sessao: unknown) => {
    saude.chamadas.push(sessao);
    return "aberto";
  }),
}));
// A mensagem nova responde antes de processar (`_entrada-do-canal.ts`): a
// marca de aceita no arquivo é dublada, e o que a rota agenda no `after()` é
// guardado aqui e rodado por `entregar` — o que se mede é a guarda de conta,
// não o momento da ingestão (esse tem o seu arquivo).
const depois = vi.hoisted(() => ({ tarefas: [] as Array<() => Promise<unknown>> }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof NextServer>()),
  after: (tarefa: () => Promise<unknown>) => {
    depois.tarefas.push(tarefa);
  },
}));
vi.mock("@/lib/channels/entrada-aceita", async (orig) => ({
  ...(await orig<typeof EntradaAceita>()),
  aceitarEntrada: async () => true,
}));

import { POST } from "@/app/api/v1/webhooks/channel/[token]/route";

function pedido(corpo: unknown) {
  const cru = JSON.stringify(corpo);
  const assinatura = createHmac("sha256", SEGREDO).update(cru, "utf8").digest("hex");
  return new Request("http://x/api/v1/webhooks/channel/token-de-teste", {
    method: "POST",
    body: cru,
    headers: { "x-zernio-signature": assinatura, "content-type": "application/json" },
  });
}

const mensagem = (extra: Record<string, unknown>) => ({
  id: "evt_1",
  event: "message.received",
  ...extra,
  message: {
    id: "m_1",
    conversationId: "6a76a2dc4b8fe115e5f6c300",
    platform: "whatsapp",
    platformMessageId: "wamid.SINTETICO",
    direction: "incoming",
    text: "olá",
    attachments: [],
    sender: { phoneNumber: "+5521988887777", name: "Cliente" },
    sentAt: "2026-09-27T12:00:00.000Z",
  },
});

const eventoDeNumero = (number: Record<string, unknown>) => ({
  id: "evt_n",
  event: "whatsapp.number.suspended",
  number: { id: "num_1", ...number, reason: "payment_failed" },
});

async function entregar(corpo: unknown) {
  const res = await POST(pedido(corpo) as never, { params: Promise.resolve({ token: "token-de-teste" }) } as never);
  for (const tarefa of depois.tarefas.splice(0)) await tarefa();
  const fechado = ops.find((o) => o.tabela === "webhook_events_log")?.payload as { erro?: string | null; status?: string };
  return {
    status: res.status,
    fechado,
    ingeriu: ops.some((o) => o.tabela === "rpc" || (o.tabela === "messages" && o.op !== "select")),
    mexeuNoCanal:
      saude.chamadas.length > 0 ||
      ops.some((o) => o.tabela === "agent_inbox_items" && o.op === "insert") ||
      ops.some((o) => o.tabela === "channel_sessions" && o.op === "update"),
  };
}

beforeEach(() => {
  ops.length = 0;
  saude.chamadas.length = 0;
});

describe("mensagem: só entra com a conta desta sessão", () => {
  it("controle: mensagem com a conta da sessão É ingerida", async () => {
    const r = await entregar(mensagem({ account: { id: CONTA_DA_SESSAO } }));
    expect(r.status).toBe(200);
    expect(r.ingeriu).toBe(true);
  });

  it("mensagem com a conta de OUTRO número não é ingerida", async () => {
    const r = await entregar(mensagem({ account: { id: OUTRA_CONTA } }));
    expect(r.status).toBe(200);
    expect(r.ingeriu).toBe(false);
    expect(r.fechado?.erro).toBe("evento_de_outra_conta");
  });

  it("mensagem SEM conta não é ingerida — e fica registrada no arquivo", async () => {
    const r = await entregar(mensagem({}));
    expect(r.status).toBe(200);
    expect(r.ingeriu).toBe(false);
    expect(r.fechado?.erro).toBe("evento_de_outra_conta");
  });
});

describe("evento de número: só muda o canal quando o número é o desta sessão", () => {
  it("o PRÓPRIO número muda o canal como sempre", async () => {
    const r = await entregar(eventoDeNumero({ phoneNumber: NUMERO_DA_SESSAO }));
    expect(r.status).toBe(200);
    expect(saude.chamadas).toHaveLength(1);
    expect(saude.chamadas[0]).toMatchObject({ id: "sessao-1", status: "FAILED" });
  });

  it("o próprio número em outra grafia (sem `+`) também é o próprio", async () => {
    const r = await entregar(eventoDeNumero({ phoneNumber: "5511900000001" }));
    expect(r.mexeuNoCanal).toBe(true);
  });

  it("OUTRO número não muda o canal nem abre aviso", async () => {
    const r = await entregar(eventoDeNumero({ phoneNumber: "+5521977776666" }));
    expect(r.status).toBe(200);
    expect(r.mexeuNoCanal).toBe(false);
    expect(r.fechado?.erro).toBe("evento_de_outro_numero");
  });

  it("sem número para comparar: registra, sem mudar status nem abrir aviso", async () => {
    const r = await entregar(eventoDeNumero({}));
    expect(r.status).toBe(200);
    expect(r.mexeuNoCanal).toBe(false);
    expect(r.fechado).toMatchObject({ status: "processed", erro: "numero_sem_comparacao" });
  });
});
