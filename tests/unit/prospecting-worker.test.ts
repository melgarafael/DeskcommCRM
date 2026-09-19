import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  send: vi.fn(),
  audit: vi.fn(),
  guard: vi.fn(),
  boundary: vi.fn(),
  preflight: vi.fn(),
  authorize: vi.fn(),
  knobs: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.send }));
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
vi.mock("@/lib/prospecting/guard", () => ({ assertProspectingDelivery: mocks.guard }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: mocks.knobs,
  loadPacingState: vi.fn().mockResolvedValue({ sentToday: 0 }),
  recordSend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/agent-engine/pacing/engine", () => ({
  janelaDeEnvioAberta: mocks.open,
  decidePacing: () => ({ allow: true, waitMs: 0 }),
  proximaAberturaDaJanela: () => new Date(Date.now() + 3600000),
  // O ritmo da esteira fria (`lib/prospecting/ritmo-da-esteira-fria.ts`) deriva
  // o teto diário DESTA função em vez de manter uma tabela de degraus própria.
  // O mock precisa dela, senão o import do worker morre antes de qualquer caso
  // — e a falha aparece como "esperava erro X" em testes que não têm nada a ver.
  warmupCapFor: (_idade: number, degraus: Array<{ minAgeDays: number; cap: number | null }>) => {
    let cap: number | null = degraus[0]?.cap ?? null;
    for (const d of degraus) if (_idade >= d.minAgeDays) cap = d.cap;
    return cap;
  },
}));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/prospecting/store", () => ({
  withProspectingLock: vi.fn(),
  synchronizeSearch: vi.fn(),
  validateConfig: vi.fn().mockResolvedValue(undefined),
}));
import { sendNextCandidate } from "@/lib/prospecting/worker";
import type { Campaign } from "@/lib/prospecting/store";
const id = "10000000-0000-4000-8000-000000000001";
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
  conversation_id: id,
  message_id: "stable-message",
  phone: "+5511999990000",
  service_boundary: { conversation_id: id },
  data: { name: "Example", socials: [] },
};
function database(
  counts = {
    campaign: 0,
    total: 0,
    retry_at: null as Date | null,
    last_attempt: null as Date | null,
  },
) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("select daily_message_limit"))
        return { rows: [{ daily_message_limit: 50 }] };
      if (sql.includes("count(*) filter")) return { rows: [counts] };
      if (sql.startsWith("select * from prospecting_candidates")) return { rows: [candidate] };
      if (sql.startsWith("select published_version_id"))
        return { rows: [{ published_version_id: id, operation_revision: 1 }] };
      return { rows: [] };
    }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.knobs.mockResolvedValue({ knobs: {} });
  mocks.open.mockReturnValue(true);
  mocks.preflight.mockResolvedValue({ permite: true });
  mocks.guard.mockResolvedValue(undefined);
  mocks.boundary.mockResolvedValue(undefined);
  mocks.generate.mockResolvedValue({
    ok: true,
    texto: "Olá. Posso entender como vocês atendem hoje?",
  });
  mocks.authorize.mockResolvedValue({ ok: true });
  mocks.send.mockResolvedValue({ status: "sent" });
});
describe("gradual outreach", () => {
  it("sends one candidate with stable identity and the mandatory last-moment guard", async () => {
    const db = database();
    await sendNextCandidate({} as never, db as never, {} as never, campaign);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({
      internalMessageId: "stable-message",
      prospectingDelivery: { candidateId: "candidate" },
      agentOperation: { agentId: id },
    });
    expect(mocks.guard).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls.some(([q]) => q.includes("attempted_at=now()"))).toBe(true);
  });
  /*
   * A TRILHA DA ABORDAGEM FRIA (LGPD adjacente).
   *
   * Esta é a única linha do produto que fala PRIMEIRO com quem nunca falou com
   * a empresa. Sem entrada em `api_audit_log`, "por que vocês me escreveram?"
   * não tem resposta: `prospecting_candidates.status` guarda o estado ATUAL e é
   * reescrito no passo seguinte.
   *
   * O par abaixo é o que impede as duas falhas opostas: não auditar o envio, e
   * auditar rodada de cron vazia (a regra do CLAUDE.md — 43.200 linhas/mês numa
   * instalação que não aborda ninguém).
   */
  it("audita a abordagem que SAIU, com os ponteiros e sem PII", async () => {
    await sendNextCandidate({} as never, database() as never, {} as never, campaign);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const entrada = mocks.audit.mock.calls[0]?.[0];
    expect(entrada).toMatchObject({
      action: "prospecting.approach_sent",
      resourceType: "prospecting_candidate",
      resourceId: "candidate",
      metadata: { campaign_id: campaign.id, sent: true },
    });
    const texto = JSON.stringify(entrada);
    expect(texto, "telefone ou texto da mensagem na trilha seria PII a mais").not.toMatch(
      /Posso entender como vocês atendem|\+55/,
    );
  });

  it("NÃO audita quando o tick não abordou ninguém (teto batido)", async () => {
    await sendNextCandidate(
      {} as never,
      database({ campaign: 10, total: 10, retry_at: new Date(), last_attempt: null }) as never,
      {} as never,
      campaign,
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.audit, "rodada sem efeito não é mutação — não audita").not.toHaveBeenCalled();
  });

  it.each([
    { campaign: 10, total: 10 },
    { campaign: 1, total: 50 },
  ])("stops at campaign or organization limit %j", async (counts) => {
    await sendNextCandidate(
      {} as never,
      database({ ...counts, retry_at: new Date(), last_attempt: null }) as never,
      {} as never,
      campaign,
    );
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("keeps spacing across campaign switches", async () => {
    await sendNextCandidate(
      {} as never,
      database({ campaign: 0, total: 1, retry_at: null, last_attempt: new Date() }) as never,
      {} as never,
      campaign,
    );
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("stops outside the configured window", async () => {
    mocks.open.mockReturnValue(false);
    await sendNextCandidate({} as never, database() as never, {} as never, campaign);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("fails closed when channel settings cannot be read", async () => {
    mocks.knobs.mockRejectedValue(new Error("database unavailable"));
    await expect(
      sendNextCandidate({} as never, database() as never, {} as never, campaign),
    ).rejects.toThrow();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("does not send when campaign pauses while the model generates", async () => {
    mocks.guard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("paused"));
    await expect(
      sendNextCandidate({} as never, database() as never, {} as never, campaign),
    ).rejects.toThrow("paused");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not bypass channel pre-go-live restrictions", async () => {
    mocks.preflight.mockResolvedValue({ permite: false, motivo: "restricted" });
    await expect(
      sendNextCandidate({} as never, database() as never, {} as never, campaign),
    ).rejects.toThrow("restricted");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("records uncertain sends as failures without retrying", async () => {
    mocks.send.mockResolvedValue({ status: "queued" });
    const db = database();
    await sendNextCandidate({} as never, db as never, {} as never, campaign);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(
      db.query.mock.calls.some(([q]) => q.startsWith("update messages set status='failed'")),
    ).toBe(true);
  });
});
