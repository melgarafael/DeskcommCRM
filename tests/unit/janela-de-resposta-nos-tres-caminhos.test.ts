/**
 * Os TRÊS caminhos que ainda olhavam só a janela de DISPARO agora tratam o
 * envio pelo TIPO (#1985, follow-up do #1984).
 *
 * O #1984 separou a janela de RESPOSTA (`channel_knobs.resposta_*`) da de
 * DISPARO (`window_*`). Coluna vazia herda a de disparo, coluna a coluna
 * (`effectiveKnobs`/`loadChannelKnobs`). O motor já decidia por tipo; três
 * consumidores seguiam lendo só `window_*`:
 *
 *   1. a rota de retenção (`app/api/v1/conversations/[id]/retention/route.ts`);
 *   2. o aviso de escalação (`lib/agent-engine/agent/aviso-de-escalacao.ts`);
 *   3. o envio de resposta aprovada (`lib/agent-engine/agent/approved-reply.ts`).
 *
 * Cada bloco prova que o caminho decide pela janela de RESPOSTA quando o envio
 * é uma resposta. Com a janela de resposta aberta (0h-24h) e a de disparo
 * fechada a 3h, o caminho tem de deixar sair / mostrar como desbloqueada a
 * resposta — nunca a tratar pela janela de disparo fechada.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Um único mock de `runBeforeSend` para os DOIS emissores (escalação e resposta
// aprovada): guarda os args recebidos num array compartilhado e devolve "sent".
const argsDeRunBeforeSend = vi.hoisted(() => ({ values: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: vi.fn(async (args: Record<string, unknown>) => {
    argsDeRunBeforeSend.values.push(args);
    return { status: "sent", outcome: { kind: "sent" }, trace: [] };
  }),
  loadChannelKnobs: vi.fn(),
  loadPacingState: vi.fn(),
  recordSend: vi.fn(),
}));

// ---------------------------------------------------------------------------
// 1. Rota de retenção — usa a janela de RESPOSTA para o "aberta agora".
// ---------------------------------------------------------------------------
// `orgAtivaDaApi` REAL (sobre o `orgAtivaSemPortao` mockado): é ela que decide o 403 da org suspensa.
vi.mock("@/lib/auth/require-role", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), orgAtivaSemPortao: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { GET as getRetention } from "@/app/api/v1/conversations/[id]/retention/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

/** Cliente que responde por TABELA; toda cadeia devolve a si mesma. */
function cliente(porTabela: Record<string, unknown>) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }) },
    from: (tabela: string) => {
      const resposta = { data: porTabela[tabela] ?? null, error: null };
      const cadeia: unknown = new Proxy(
        {},
        {
          get: (_alvo, chave) =>
            chave === "then"
              ? (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok)
              : chave === "maybeSingle"
                ? async () => resposta
                : () => cadeia,
        },
      );
      return cadeia;
    },
  } as never;
}

async function retencoes(tabelas: Record<string, unknown>) {
  vi.mocked(createClient).mockResolvedValue(
    cliente({
      conversations: { id: "c", contact_id: "k", channel_session_id: CANAL },
      channel_knobs: null,
      organizations: { timezone: "America/Sao_Paulo" },
      ...tabelas,
    }),
  );
  const res = await getRetention(new NextRequest("http://localhost/api/v1/conversations/c/retention"), {
    params: Promise.resolve({ id: "c" }),
  });
  const corpo = (await res.json()) as { data: { retentions: Array<{ vetoed_code: string }> } };
  return corpo.data.retentions;
}

/** Resposta 0-24, disparo 7-22 — o par que separa os dois tipos a 3h. */
const JANELAS = {
  channel_knobs: {
    window_start_hour: 7,
    window_end_hour: 22,
    resposta_start_hour: 0,
    resposta_end_hour: 24,
    allow_sunday: true,
    timezone: "America/Sao_Paulo",
  },
  organizations: { timezone: "America/Sao_Paulo" },
};

describe("retenção: o 'aberta agora' usa a janela da RESPOSTA", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(loadAuthUser).mockResolvedValue({ idioma: "pt-BR" } as never);
    vi.mocked(orgAtivaSemPortao).mockResolvedValue({ orgId: ORG, org_status: "active" } as never);
  });

  it("resposta retida por outside_window some quando a janela de RESPOSTA está aberta (3h)", async () => {
    // Janela de disparo (7-22) fechada às 3h; janela de resposta (0-24) aberta.
    // resposta=outside_window 03:00, agora 03:00, nada enviado depois.
    vi.useFakeTimers({ now: new Date("2026-09-20T06:00:00Z"), toFake: ["Date"] }); // 03h em São Paulo
    const r = await retencoes({
      ...JANELAS,
      before_send_traces: [{ vetoed_code: "outside_window", created_at: "2026-09-20T06:00:00Z" }],
      messages: null,
    });
    // A resposta foi desbloqueada pela janela de resposta aberta — o trace
    // some. Se a rota usasse window_*, diria "fora da janela" (disparo fechado).
    expect(r).toEqual([]);
  });

  it("resposta retida por outside_window FICA quando a janela de RESPOSTA fechou, mesmo com a de disparo aberta", async () => {
    // Resposta [0-6] fecha às 11h; disparo [7-22] continua aberto. Se a rota
    // usasse window_*, reportaria "resolvida"; como ela usa a janela de RESPOSTA,
    // o aviso fica — prova que o discriminador é a janela de resposta, não a de disparo.
    vi.useFakeTimers({ now: new Date("2026-09-20T14:00:00Z"), toFake: ["Date"] }); // 11h em São Paulo
    const r = await retencoes({
      channel_knobs: {
        window_start_hour: 7,
        window_end_hour: 22,
        resposta_start_hour: 0,
        resposta_end_hour: 6,
        allow_sunday: true,
        timezone: "America/Sao_Paulo",
      },
      organizations: { timezone: "America/Sao_Paulo" },
      before_send_traces: [{ vetoed_code: "outside_window", created_at: "2026-09-20T14:00:00Z" }],
      messages: null,
    });
    expect(r.map((t) => t.vetoed_code)).toEqual(["outside_window"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Aviso de escalação — repassa `resposta: true` à cadeia.
// ---------------------------------------------------------------------------
vi.mock("@/lib/escalacao/disponibilidade", () => ({
  expectativaDeAtendimento: vi.fn(async () => ({ quem: null, frase: "" })),
}));
vi.mock("@/lib/escalacao/aviso-ao-lead", () => ({
  textoDoAviso: vi.fn((_motivo: unknown, _quem: unknown, _id: string, idioma?: string | null) =>
    idioma === "es" ? "Aviso em espanhol" : "Uma pessoa irá te atender.",
  ),
}));

import { avisarLeadDaEscalacao } from "@/lib/agent-engine/agent/aviso-de-escalacao";

const poolSimples = {
  query: async () => ({ rows: [] }),
} as never;

describe("aviso de escalação: envia como RESPOSTA quando quem pediu escreveu", () => {
  it("repassa `resposta: true` a runBeforeSend", async () => {
    const antes = argsDeRunBeforeSend.values.length;
    await avisarLeadDaEscalacao(
      poolSimples,
      {
        tenantId: ORG,
        leadId: "33333333-3333-4333-8333-333333333333",
        conversationId: "44444444-4444-4444-8444-444444444444",
        channelSessionId: CANAL,
        jobId: "job",
      },
      {
        motivo: "pediu_humano",
        channel: {} as never,
        optedOutThisTurn: false,
        now: new Date("2026-09-20T06:00:00Z"),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      },
    );
    const nova = argsDeRunBeforeSend.values.slice(antes);
    expect(nova).toHaveLength(1);
    expect(nova[0]?.resposta).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Resposta aprovada — repassa `resposta: true` à cadeia.
// ---------------------------------------------------------------------------
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  reconcileAcceptedSend: vi.fn(async () => false),
}));
vi.mock("@/lib/ai/replies/delivery", () => ({
  assertApprovedReplyPg: vi.fn(async () => ({
    contact_id: "33333333-3333-4333-8333-333333333333",
    conversation_id: "44444444-4444-4444-8444-444444444444",
    channel_session_id: CANAL,
    draft_id: "55555555-5555-4555-8555-555555555555",
    body: "Respondi a sua mensagem.",
    agent_id: "66666666-6666-4666-8666-666666666666",
  })),
  assertApprovedReplyReceiptPg: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  withServiceJob: vi.fn(async (_db: unknown, _job: unknown, action: () => Promise<unknown>) => action()),
}));
vi.mock("@/lib/channels/runtime", () => ({
  createRuntimeSendChannel: vi.fn(() => ({ send: vi.fn() })),
}));
vi.mock("@/lib/agent-engine/queue/claim", () => ({
  claimOfJob: vi.fn(() => ({ worker_id: "w", acquired_at: new Date() })),
}));
vi.mock("@/lib/agent-engine/guardrails/lgpd/legal-basis", () => ({
  deriveLgpdFromContact: vi.fn(() => ({})),
}));

import { createApprovedReplyHandler } from "@/lib/agent-engine/agent/approved-reply";

const poolDaAprovada = {
  query: async () => ({
    rows: [{ source: null, consent: null, is_anonymized: false, daily_message_limit: null }],
  }),
} as never;

describe("resposta aprovada: envia como RESPOSTA a mensagem recebida", () => {
  it("repassa `resposta: true` a runBeforeSend", async () => {
    const antes = argsDeRunBeforeSend.values.length;
    const handle = createApprovedReplyHandler({
      crmCfg: {} as never,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sleep: async () => undefined,
    });
    await handle(
      {
        kind: "approved_reply",
        id: "job",
        organization_id: ORG,
        contact_id: "33333333-3333-4333-8333-333333333333",
        locked_by: "worker-1",
        claim_acquired_at: new Date("2026-09-20T05:59:00Z"),
        payload: {},
      } as never,
      poolDaAprovada,
    );
    const nova = argsDeRunBeforeSend.values.slice(antes);
    expect(nova).toHaveLength(1);
    expect(nova[0]?.resposta).toBe(true);
  });
});