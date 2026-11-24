/**
 * O TETO DO VISITANTE ANÔNIMO NO TURNO DE VERDADE — o teste que o CR do
 * mantenedor cobra: quando a IA atinge o teto, o visitante NÃO fica no silêncio.
 *
 * Os três pontos do CR, um por bloco:
 *
 *  1. ORDEM (ponto 1): o aviso ao lead sai ANTES de `performHumanHandoff` armar
 *     o `force_human` (que veta todo envio posterior). Remover a ordem faz o
 *     aviso morrer calado — este caso fica vermelho.
 *  2. MOTIVO (ponto 2): o `reason` da passagem é `teto_do_visitante_anonimo`,
 *     não `orcamento_de_ia`. Usar o motivo do gasto faria o cartão da Central
 *     dizer "limite de gasto com IA" para quem nunca pediu nada — este caso
 *     fica vermelho com o motivo errado.
 *  3. RASTRO (ponto 3): a passagem grava a linha em `passagens_de_atendimento`
 *     com `origem = 'teto_do_anonimo'` e `motivo_codigo = 'teto_do_visitante_anonimo'`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  passagem: vi.fn(),
  emHandoff: vi.fn(),
  aviso: vi.fn(),
  cancel: vi.fn(),
}));

// Só os EFEITOS do handoff são dublados. As detecções seguem as REAIS.
vi.mock("@/lib/agent-engine/agent/human-handoff", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLeadInHandoff: mocks.emHandoff,
  performHumanHandoff: mocks.passagem,
}));
vi.mock("@/lib/agent-engine/agent/aviso-de-escalacao", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  avisarLeadLendoOContato: mocks.aviso,
}));
vi.mock("@/lib/agent-engine/cron/scheduler", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cancelPendingCronsForLead: mocks.cancel,
}));

// O gate de elegibilidade é o transporte do agent-engine (pg). Dublá-lo aqui
// é o que permite medir o ramo do teto do visitante anônimo sem banco real.
vi.mock("@/lib/ai/elegibilidade/consulta-pg", () => ({
  decidirElegibilidadeDaConversa: vi.fn(),
}));

import { runAgentTurn } from "@/lib/agent-engine/agent/inbound-turn";
import { decidirElegibilidadeDaConversa } from "@/lib/ai/elegibilidade/consulta-pg";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CANAL = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const MENSAGEM = "66666666-6666-4666-8666-666666666666";

function poolCom(
  historico: Array<{ direction: "inbound" | "outbound"; body: string; sent_at: Date }>,
  fixada: { direction: "inbound" | "outbound"; body: string; sent_at: Date },
): never {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("lead_checkpoints")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("organizations")) {
        return { rows: [{ id: ORG, status: "active", settings: {} }] };
      }
      if (sql.includes("contacts")) {
        return { rows: [{ id: CONTATO, name: "Visitante do site", is_blocked: false }] };
      }
      if (sql.includes("conversations")) {
        return {
          rows: [{ id: CONVERSA, organization_id: ORG, contact_id: CONTATO, channel_session_id: CANAL }],
        };
      }
      if (sql.includes("messages")) {
        if (sql.includes("direction = 'inbound'")) {
          return { rows: historico.filter((m) => m.direction === "inbound") };
        }
        return { rows: historico.filter((m) => m.direction === "outbound") };
      }
      return { rows: [] };
    }),
  } as never;
}

function logFalso() {
  const info = vi.fn();
  return { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn(), infoChamado: info };
}

async function turno(
  pool: never,
  log: ReturnType<typeof logFalso>,
  elegibilidade: { permite: boolean; motivo: string },
): Promise<void> {
  (decidirElegibilidadeDaConversa as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    permite: elegibilidade.permite,
    motivo: elegibilidade.motivo,
    bloqueioPorAllowlist: false,
    contatoDaEquipe: false,
  });

  const job = {
    id: JOB,
    organization_id: ORG,
    contact_id: CONTATO,
    kind: "inbound_turn",
    payload: {},
    attempts: 1,
    claimed_by: "w",
    claimed_at: new Date(),
  };
  const deps = {
    log,
    llmCfg: {},
    crmCfg: {},
    knobs: { maxSteps: 1, allowlistTtlMs: 21 * 24 * 60 * 60 * 1000 },
    clock: () => new Date("2026-10-06T15:00:00Z"),
    channel: () => ({ send: vi.fn(async () => ({ kind: "sent" })) }),
  };
  await runAgentTurn(deps as never, job as never, pool, { workerId: "w" }, {
    resolvedAgent: {
      config: {
        agentId: "agente-1",
        versionId: "v1",
        operationMode: "automatic",
        pausedAt: null,
        systemPrompt: "persona",
        toolIds: [],
        casesEnabled: false,
        historyMessageWindow: 20,
        historyTokenWindow: 1000,
        handoffKeywords: [],
        filtroDePalavraChave: null,
      },
      routerId: null,
      intentName: null,
      confidence: null,
      outcome: "fallback",
    },
    channelSessionId: CANAL,
    conversationId: CONVERSA,
    inboundMessageId: MENSAGEM,
    buildOpening: () => "",
  } as never);
}

const mensagensDeLog = (log: ReturnType<typeof logFalso>): string[] =>
  log.infoChamado.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emHandoff.mockResolvedValue(false);
  mocks.aviso.mockResolvedValue({ avisado: true });
  mocks.passagem.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(0);
});

describe("turno REAL — o teto do visitante anônimo pede contato e passa para a equipe", () => {
  it("teto batido: avisa o lead ANTES de silenciar o bot, com motivo do teto do anônimo", async () => {
    const log = logFalso();
    const pool = poolCom(
      [
        texto("outbound", "Oi! Como posso ajudar?", 0),
        texto("inbound", "quero saber o preço", 3),
        texto("inbound", "e o prazo de entrega?", 4),
        texto("inbound", "e tem desconto?", 5),
      ],
      texto("inbound", "e tem desconto?", 5),
    );

    // O teto do anônimo está batido: o turno encerra sem chegar ao modelo,
    // mas com aviso ao lead e passagem para a equipe.
    await expect(turno(pool, log, { permite: false, motivo: "teto_do_visitante_anonimo" })).resolves.toBeUndefined();

    // Ponto 1: o aviso ao lead foi mandado (com o motivo do teto do anônimo).
    expect(mocks.aviso).toHaveBeenCalledTimes(1);
    const opts = mocks.aviso.mock.calls[0]?.[2] as { motivo: string };
    expect(opts.motivo).toBe("teto_do_visitante_anonimo");

    // Ponto 2: o handoff foi acionado com o motivo do teto do anônimo (não o do orçamento).
    expect(mocks.passagem).toHaveBeenCalledTimes(1);
    expect(mocks.passagem.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        reason: "teto_do_visitante_anonimo",
        passagem: expect.objectContaining({
          origem: "teto_do_anonimo",
          motivoCodigo: "teto_do_visitante_anonimo",
        }),
      }),
    );
    // A ordem: o aviso sai ANTES da passagem, que arma o `force_human`.
    expect(mocks.aviso.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.passagem.mock.invocationCallOrder[0] ?? 0,
    );

    // O turno encerrou (não chegou ao modelo).
    expect(mensagensDeLog(log).some((m) => m.includes("turno pulado"))).toBe(true);
  });

  it("aviso que falha NÃO impede a passagem para a equipe", async () => {
    mocks.aviso.mockRejectedValueOnce(new Error("canal fora do ar"));
    const pool = poolCom(
      [texto("outbound", "Oi!", 0), texto("inbound", "oi de novo", 3)],
      texto("inbound", "oi de novo", 3),
    );
    await expect(
      turno(pool, logFalso(), { permite: false, motivo: "teto_do_visitante_anonimo" }),
    ).resolves.toBeUndefined();
    expect(mocks.passagem).toHaveBeenCalledTimes(1);
    expect(mocks.passagem.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        reason: "teto_do_visitante_anonimo",
        avisoAoLead: { avisado: false, porque: "erro_no_envio" },
      }),
    );
  });

  it("outro veto do gate segue silencioso, sem aviso nem passagem", async () => {
    const pool = poolCom(
      [texto("outbound", "Oi!", 0), texto("inbound", "oi", 3)],
      texto("inbound", "oi", 3),
    );
    await turno(pool, logFalso(), { permite: false, motivo: "conversa_silenciada" });
    expect(mocks.aviso).not.toHaveBeenCalled();
    expect(mocks.passagem).not.toHaveBeenCalled();
  });

  it("motivo errado (orcamento_de_ia) no teto do anônimo é rejeitado — este caso vigia o motivo", async () => {
    const pool = poolCom(
      [
        texto("outbound", "Oi!", 0),
        texto("inbound", "qualquer coisa", 3),
      ],
      texto("inbound", "qualquer coisa", 3),
    );

    // Se o código usasse o motivo do orçamento para o teto do anônimo, este
    // teste passaria. Com o motivo correto (teto_do_visitante_anonimo), ele
    // reprova — por isso ele é a cerca que impede a confusão.
    await expect(
      turno(pool, logFalso(), { permite: false, motivo: "teto_do_visitante_anonimo" }),
    ).resolves.toBeUndefined();
    expect(mocks.passagem.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ reason: "teto_do_visitante_anonimo" }),
    );
    expect(mocks.passagem.mock.calls[0]?.[2]).not.toEqual(
      expect.objectContaining({ reason: "orcamento_de_ia" }),
    );
  });
});

function texto(
  direction: "inbound" | "outbound",
  body: string,
  minutos: number,
): { direction: "inbound" | "outbound"; body: string; sent_at: Date; [campo: string]: unknown } {
  return {
    direction,
    type: "text",
    body,
    media_url: null,
    media_storage_path: null,
    media_mime: null,
    media_derived_text: null,
    sent_at: new Date(Date.UTC(2026, 9, 6, 15, minutos)),
  };
}