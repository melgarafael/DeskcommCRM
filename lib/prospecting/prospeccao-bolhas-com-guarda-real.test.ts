import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS BOLHAS DEPOIS DA PRIMEIRA, COM A GUARDA DE VERDADE.
 *
 * O defeito medido na revisão do PR #2680 só aparece com a guarda REAL e um envio
 * que carimba `conversations.last_outbound_at`:
 *
 *   1. toda bolha levava `prospectingDelivery` e o handler roda
 *      `assertProspectingDelivery` na entrada de cada envio (`_handler.ts:437`);
 *   2. depois da 1ª bolha, o PRÓPRIO handler grava `last_outbound_at = now`
 *      (`_handler.ts`, no `conversationUpdate` do fim do envio);
 *   3. a guarda recusa conversa com `last_outbound_at` preenchido e o
 *      `ProspectingError` sai com escopo `campanha` (o default de `provider.ts`) —
 *      que é o escopo que o tick lê para PAUSAR a campanha.
 *
 * Resultado medido: a pessoa recebe só a 1ª bolha, SEM o "responda PARAR", e a
 * campanha para no primeiro contato.
 *
 * Por isso aqui a guarda NÃO é dublada (`@/lib/prospecting/guard` fica real) e o
 * dublê do handler é fiel justamente nas duas linhas que o defeito usa: a guarda
 * na entrada e o carimbo na saída. O caminho é o do TICK, e não o do envio
 * isolado, porque é no tick que "pausar a campanha" tem consequência observável.
 */
const id = "10000000-0000-4000-8000-000000000001";
const CONVERSA = id;

/** O estado que a guarda lê — e que o envio da bolha anterior altera. */
const estado = {
  conversation: {
    status: "open",
    last_inbound_at: null as string | null,
    last_outbound_at: null as string | null,
    assigned_to_user_id: null as string | null,
    bot_silenced_until: null as string | null,
  },
};

/** O que de fato saiu pelo canal, na ordem. */
const envios: string[] = [];
/** Quantas vezes o dublê do handler rodou a guarda de primeiro contato. */
const guardasNaEntrada = { chamadas: 0 };
/** Todo SQL que o caminho pediu — é onde se vê a campanha sendo pausada. */
const sqls: string[] = [];

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  audit: vi.fn(),
  boundary: vi.fn(),
  preflight: vi.fn(),
  authorize: vi.fn(),
  knobs: vi.fn(),
  open: vi.fn(),
  paradas: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("@/app/api/v1/messages/_handler", async () => {
  // A guarda REAL, importada de propósito: o dublê do handler a chama como o
  // handler de verdade chama (`_handler.ts:437`).
  const { assertProspectingDelivery } = await vi.importActual<
    typeof import("@/lib/prospecting/guard")
  >("@/lib/prospecting/guard");
  return {
    sendMessageHandler: async (
      _supabase: unknown,
      ctx: { prospectingDelivery?: unknown },
      input: { body: string },
    ) => {
      if (ctx.prospectingDelivery) {
        guardasNaEntrada.chamadas++;
        await assertProspectingDelivery(clienteDoSupa() as never, ctx.prospectingDelivery as never);
      }
      envios.push(input.body);
      // `_handler.ts` (~1337): DEPOIS de enviar, o handler grava o carimbo da
      // saída na conversa. É este carimbo que a guarda cheia lê como "contato já
      // atendido" na bolha seguinte.
      estado.conversation.last_outbound_at = new Date().toISOString();
      return { status: "sent", id: `balao-${envios.length}` };
    },
  };
});
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: mocks.generate,
}));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({ llmEdgeConfigFromEnv: () => ({}) }));
vi.mock("@/lib/atendimento/origem", () => ({
  assertServiceBoundarySupabase: mocks.boundary,
  beginServiceAtOrigin: vi.fn(),
}));
vi.mock("@/lib/atendimento/fronteira", () => ({ parseServiceBoundary: (x: unknown) => x }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: mocks.authorize }));
vi.mock("@/lib/ai/elegibilidade/consulta-pre-go-live", () => ({
  decidirPreGoLiveDoCanalViaSupabase: mocks.preflight,
}));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: mocks.knobs,
  loadPacingState: vi.fn().mockResolvedValue({ sentToday: 0 }),
  recordSend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/agent-engine/pacing/engine", () => ({
  janelaDeEnvioAberta: mocks.open,
  // O PORTÃO PRÓPRIO DA PROSPECÇÃO (dias + horas, 0642) chegou com a main, e o
  // worker o consulta ANTES de qualquer envio: sem estas duas chaves o dublê não
  // tem a função, o tick morre com "not a function" e NENHUMA bolha sai — o caso
  // ficaria vermelho por um buraco do dublê, não pelo defeito que ele mede.
  janelaDeProspeccaoAberta: () => true,
  proximaAberturaDaProspeccao: () => new Date(Date.now() + 3600000),
  decidePacing: () => ({ allow: true, waitMs: 0 }),
  proximaAberturaDaJanela: () => new Date(Date.now() + 3600000),
  warmupCapFor: (
    _idade: number,
    degraus: Array<{ minAgeDays: number; cap: number | null }>,
  ) => {
    let cap: number | null = degraus[0]?.cap ?? null;
    for (const d of degraus) if (_idade >= d.minAgeDays) cap = d.cap;
    return cap;
  },
}));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/organizacao/operante", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizacao/operante")>()),
  idsDeOrgsParadas: mocks.paradas,
}));
vi.mock("@/lib/prospecting/store", () => ({
  withProspectingLock: vi.fn(),
  synchronizeSearch: vi.fn(),
  validateConfig: vi.fn().mockResolvedValue(undefined),
  prepararCandidatoNoEnvio: mocks.prepare,
}));

import {
  assertProspectingContinuation,
  assertProspectingDelivery,
} from "@/lib/prospecting/guard";
import { ProspectingError } from "@/lib/prospecting/provider";
import { withProspectingLock } from "@/lib/prospecting/store";
import type { Campaign } from "@/lib/prospecting/store";
import { tickProspecting } from "@/lib/prospecting/worker";

/**
 * O cliente Supabase que a guarda REAL enxerga. Cadeia tolerante: a guarda usa
 * `.from(...).select(...).eq(...).eq(...).maybeSingle()`, e o valor devolvido é o
 * ESTADO VIVO — a conversa com `last_outbound_at` preenchido pelo envio anterior.
 */
function clienteDoSupa() {
  const linhas: Record<string, unknown> = {
    prospecting_candidates: {
      campaign_id: id,
      contact_id: id,
      status: "sending",
      conversation_id: CONVERSA,
    },
    prospecting_campaigns: { status: "running" },
    contacts: {
      is_blocked: false,
      force_human: false,
      is_anonymized: false,
      source: "prospecting",
      consent: { legitimate_interest: { ref: "LIA-example" } },
    },
  };
  return {
    from(table: string) {
      const consulta = {
        select: () => consulta,
        eq: () => consulta,
        maybeSingle: async () => ({
          data: table === "conversations" ? estado.conversation : (linhas[table] ?? null),
          error: null,
        }),
      };
      return consulta;
    },
  };
}

const campaign = {
  id,
  organization_id: id,
  next_send_at: new Date(0),
  config: {
    agent_id: id,
    channel_session_id: id,
    pipeline_id: id,
    stage_id: id,
    qualified_stage_id: "10000000-0000-4000-8000-000000000002",
    instruction: "Oferta definida pelo operador",
    qualification: "Necessidade confirmada pela pessoa",
    daily_limit: 10,
    interval_minutes: 15,
    legal_basis_ref: "LIA-example",
  },
} as Campaign;

const candidate = {
  id: "candidate",
  contact_id: id,
  conversation_id: CONVERSA,
  message_id: "stable-message",
  phone: "+551****0000",
  service_boundary: { conversation_id: CONVERSA },
  data: { name: "Example", socials: [] },
};

const textoDoModelo =
  "Olá! Somos a Acme e ajudamos lojas como a de vocês a vender mais.\n\n" +
  "Queria entender como vocês atendem hoje.";

/** O banco do tick e do envio. Toda query entra em `sqls`, com os params. */
function banco() {
  return {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      sqls.push(sql);
      if (sql.startsWith("select * from prospecting_campaigns where organization_id=$1 and status='running'"))
        return { rows: [campaign] };
      if (sql.startsWith("select daily_message_limit")) return { rows: [{ daily_message_limit: 50 }] };
      if (sql.includes("count(*) filter"))
        return { rows: [{ campaign: 0, total: 0, retry_at: null, last_attempt: null }] };
      if (sql.startsWith("select * from prospecting_candidates")) return { rows: [candidate] };
      if (sql.startsWith("select locale from organizations")) return { rows: [{ locale: "pt-BR" }] };
      if (/^select (a\.)?published_version_id/.test(sql))
        // O "Estilo de resposta" LIGADO, com teto baixo o bastante para fatiar.
        return {
          rows: [
            {
              published_version_id: id,
              operation_revision: 1,
              split_messages: true,
              split_max_chars: 60,
            },
          ],
        };
      return { rows: [] };
    }),
  };
}

/** Roda o TICK inteiro: é nele que "pausar a campanha" deixa rastro no SQL. */
async function rodarOTick() {
  const db = banco();
  (withProspectingLock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (_pool: unknown, _org: unknown, fn: (d: unknown) => Promise<unknown>) => fn(db),
  );
  const pool = { query: vi.fn(async () => ({ rows: [{ organization_id: id }] })) };
  await tickProspecting(pool as never, clienteDoSupa() as never);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  estado.conversation = {
    status: "open",
    last_inbound_at: null,
    last_outbound_at: null,
    assigned_to_user_id: null,
    bot_silenced_until: null,
  };
  envios.length = 0;
  sqls.length = 0;
  guardasNaEntrada.chamadas = 0;
  mocks.knobs.mockResolvedValue({ knobs: {} });
  mocks.open.mockReturnValue(true);
  mocks.preflight.mockResolvedValue({ permite: true });
  mocks.boundary.mockResolvedValue(undefined);
  mocks.authorize.mockResolvedValue({ ok: true });
  mocks.paradas.mockResolvedValue([]);
  mocks.generate.mockResolvedValue({ ok: true, texto: textoDoModelo });
});

describe("as bolhas depois da primeira, com a guarda real (revisão do PR #2680)", () => {
  it("a 2ª e a 3ª bolha saem mesmo com o carimbo do próprio envio — e a campanha NÃO é pausada", async () => {
    const db = await rodarOTick();

    // A saída chegou no PRIMEIRO contato...
    expect(envios[0], "a saída não está na 1ª bolha").toContain("responda PARAR");
    // O ponto do PR: a campanha segue de pé. Com a guarda cheia em todas as
    // bolhas, o tick grava a pausa — e o motivo do erro é a recusa da própria
    // guarda (409, escopo `campanha`). `pausou[1][2]` é esse motivo.
    const pausou = db.query.mock.calls.find(([q]) =>
      String(q).includes("update prospecting_campaigns set status='paused'"),
    );
    expect(pausou?.[1]?.[2] ?? null, "a campanha foi PAUSADA no primeiro contato").toBeNull();
    // A pessoa recebeu a abordagem INTEIRA: o carimbo de `last_outbound_at` que
    // ela mesma produziu não recusa a própria continuação.
    expect(envios, "a abordagem parou na 1ª bolha").toHaveLength(3);
    // ...e a saída não depende da última bolha.
    expect(envios.at(-1)).not.toContain("responda PARAR");
    // A guarda REAL foi exercida na 1ª bolha (é ela que carimba o cenário), e só
    // nela: nas seguintes vale a conferência leve.
    expect(guardasNaEntrada.chamadas).toBe(1);
    const candidatura = db.query.mock.calls.find(([q]) =>
      String(q).startsWith("update prospecting_candidates set status=$3"),
    );
    expect(candidatura?.[1]).toEqual([id, "candidate", "sent", null]);

    // A trilha registra o que saiu, com a contagem de bolhas.
    expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({
      action: "prospecting.approach_sent",
      metadata: { sent: true, bubbles_sent: 3, bubbles_total: 3 },
    });
  });

  it("controle: a guarda REAL recusa a conversa que já tem `last_outbound_at` — 409 de escopo campanha", async () => {
    // O que o mantenedor mediu, aqui reproduzido no mesmo fixture: a conversa
    // fria passa; depois do carimbo do NOSSO envio, a guarda cheia recusa. O
    // escopo `campanha` é o que faz o tick pausar a fila inteira.
    await expect(
      assertProspectingDelivery(clienteDoSupa() as never, {
        organizationId: id,
        candidateId: "candidate",
        conversationId: CONVERSA,
      }),
    ).resolves.toBeUndefined();

    estado.conversation.last_outbound_at = new Date().toISOString();
    const erro = await assertProspectingDelivery(clienteDoSupa() as never, {
      organizationId: id,
      candidateId: "candidate",
      conversationId: CONVERSA,
    }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProspectingError);
    expect((erro as ProspectingError).message).toBe(
      "Contato já atendido, assumido por humano ou sem autorização para esta abordagem.",
    );
    expect((erro as ProspectingError).status).toBe(409);
    expect((erro as ProspectingError).escopo).toBe("campanha");
  });

  it("controle: a conferência leve ignora o carimbo do nosso envio, mas PARA na pessoa que respondeu", async () => {
    const ctx = { organizationId: id, candidateId: "candidate", conversationId: CONVERSA };
    // O carimbo do NOSSO envio anterior, sozinho, não para a abordagem.
    estado.conversation.last_outbound_at = new Date().toISOString();
    await expect(assertProspectingContinuation(clienteDoSupa() as never, ctx)).resolves.toBeUndefined();

    // A pessoa respondeu (ou mandou STOP): para — e o escopo é `candidato`, que
    // é o que NÃO pausa a campanha.
    estado.conversation.last_inbound_at = new Date().toISOString();
    const erro = await assertProspectingContinuation(clienteDoSupa() as never, ctx).catch(
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ProspectingError);
    expect((erro as ProspectingError).status).toBe(409);
    expect((erro as ProspectingError).escopo).toBe("candidato");
  });
});
