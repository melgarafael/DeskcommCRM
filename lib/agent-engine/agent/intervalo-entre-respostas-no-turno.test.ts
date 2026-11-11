/**
 * #3940 — A PAUSA ENTRE RESPOSTAS VALE PARA A MENSAGEM QUE CHEGA DURANTE UM TURNO.
 *
 * O drain calcula o `run_after` pela última resposta da IA no instante em que a
 * mensagem chega. A que chega com um turno RODANDO não pega carona (a carona só
 * existe em job pending) e nasce medida contra a resposta ANTERIOR — com pausa
 * de 300 s e turnos de 70-90 s, a segunda resposta saía segundos depois da
 * primeira. O turno mede de novo, com a mesma régua do drain, e reagenda.
 *
 * Harness: o de `roteador-nao-grava-duas-vezes.test.ts` — o turno segue o caminho
 * de produção e para na primeira chamada de modelo (`/config LLM/`), que é a
 * prova de que ele NÃO foi adiado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/agent/destino-da-intencao", () => ({
  aplicaDestinoDaIntencao: vi.fn().mockResolvedValue({ status: "movido" }),
  funisDeProdutoDoRoteador: vi.fn().mockResolvedValue([]),
}));

import { runAgentTurn } from "@/lib/agent-engine/agent/inbound-turn";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CANAL = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const MENSAGEM = "66666666-6666-4666-8666-666666666666";

/** Terça 15h BRT — dentro da janela anti-ban. */
const AGORA = new Date("2026-10-06T18:00:00Z");
const PAUSA_MS = 300_000;
/** A resposta do turno ANTERIOR (o que estava rodando quando a mensagem chegou) saiu há 5 s. */
const RESPOSTA_DO_TURNO_EM_CURSO = new Date(AGORA.getTime() - 5_000);

const AGENTE = {
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
  janelaDeAtendimento: null,
};

const DO_CLIENTE = {
  direction: "inbound",
  type: "text",
  body: "e o prazo de entrega?",
  media_url: null,
  media_storage_path: null,
  media_mime: null,
  media_derived_text: null,
  sent_at: new Date(AGORA.getTime() - 2_000),
};

const LINHA_DO_CONTATO = {
  name: "Cliente",
  display_name: null,
  email: null,
  phone_number: "5511999999999",
  tags: [],
  is_blocked: false,
  is_personal: false,
  source: "whatsapp",
  consent: null,
  is_anonymized: false,
};

const JOB_DO_TURNO = {
  id: JOB,
  organization_id: ORG,
  contact_id: CONTATO,
  kind: "inbound_turn",
  payload: { inbound_message_id: MENSAGEM },
  attempts: 1,
  claimed_by: "w",
  claimed_at: AGORA,
  created_at: new Date(AGORA.getTime() - 60_000),
};

interface Consulta {
  sql: string;
  params: unknown[];
}

const ehUltimaRespostaDaIa = (sql: string) => sql.includes("sent_via = 'ai'") && sql.includes("max(created_at)");
const ehReagendamento = (sql: string) => /update job_queue\s+set status = 'pending'/.test(sql);

function bancoFingido(ultimaRespostaDaIa: Date | null) {
  const consultas: Consulta[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      consultas.push({ sql, params: params ?? [] });
      if (ehUltimaRespostaDaIa(sql)) return { rows: [{ em: ultimaRespostaDaIa }] };
      if (/from contacts where organization_id = \$1 and id = \$2/.test(sql)) {
        return { rows: [LINHA_DO_CONTATO] };
      }
      if (sql.includes("from messages") && /and id = \$3/.test(sql)) return { rows: [DO_CLIENTE] };
      if (sql.includes("from messages") && sql.includes("media_mime")) return { rows: [DO_CLIENTE] };
      if (sql.includes("playbook_pointers")) {
        return { rows: [{ layer: "platform", version_id: "v1", content: "plataforma" }] };
      }
      return { rows: [] };
    }),
  };
  return { pool, consultas };
}

async function turno(
  banco: ReturnType<typeof bancoFingido>,
  instante: Date,
  pausaMs: number | null,
): Promise<Error | null> {
  try {
    await runAgentTurn(
      {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        llmCfg: {},
        crmCfg: {},
        knobs: { maxSteps: 1 },
        clock: () => instante,
      } as never,
      JOB_DO_TURNO as never,
      banco.pool as never,
      { workerId: "w" },
      {
        resolvedAgent: {
          config: { ...AGENTE, replyMinIntervalMs: pausaMs },
          routerId: null,
          intentName: null,
          confidence: null,
          outcome: "default",
        },
        channelSessionId: CANAL,
        conversationId: CONVERSA,
        inboundMessageId: MENSAGEM,
        buildOpening: () => "",
      } as never,
    );
    return null;
  } catch (err) {
    return err as Error;
  }
}

const reagendamentos = (b: ReturnType<typeof bancoFingido>) => b.consultas.filter((c) => ehReagendamento(c.sql));
const medicoes = (b: ReturnType<typeof bancoFingido>) => b.consultas.filter((c) => ehUltimaRespostaDaIa(c.sql));

beforeEach(() => vi.clearAllMocks());

describe("pausa entre respostas — conferida de novo no turno", () => {
  it("mensagem que chegou durante um turno: o job é reagendado para última resposta + pausa", async () => {
    const banco = bancoFingido(RESPOSTA_DO_TURNO_EM_CURSO);

    const erro = await turno(banco, AGORA, PAUSA_MS);

    expect(erro?.name).toBe("job_settled");
    expect(String(erro?.message)).toMatch(/intervalo mínimo entre respostas/);
    // A régua do drain: filtra organização E conversa.
    expect(medicoes(banco)).toHaveLength(1);
    expect(medicoes(banco)[0]?.params).toEqual([ORG, CONVERSA]);
    // Reagenda para 5 s atrás + 300 s = daqui a 295 s.
    const [r] = reagendamentos(banco);
    expect(reagendamentos(banco)).toHaveLength(1);
    expect(r?.params[0]).toBe(JOB);
    expect(r?.params[2], "o turno não esperou a pausa").toBe(PAUSA_MS - 5_000);
  });

  it("o job reagendado não perde a mensagem e não gasta tentativa", async () => {
    const banco = bancoFingido(RESPOSTA_DO_TURNO_EM_CURSO);

    await turno(banco, AGORA, PAUSA_MS);

    const [r] = reagendamentos(banco);
    // Volta a pending devolvendo a tentativa do claim, sem tocar no payload
    // (a mensagem do turno mora nele) — é o `rescheduleJob` da janela de atendimento.
    expect(r?.sql).toContain("attempts = greatest(attempts - 1, 0)");
    expect(r?.params[5], "o reagendamento reescreveu o payload").toBeNull();
    // Nenhum envio nem descarte do job nesta passagem.
    expect(banco.consultas.some((c) => /insert into messages/i.test(c.sql))).toBe(false);
    expect(banco.consultas.some((c) => /status = '(cancelled|dead|done)'/.test(c.sql))).toBe(false);

    // Na hora marcada, o MESMO job roda, lê a MESMA mensagem e chega ao modelo.
    const depois = bancoFingido(RESPOSTA_DO_TURNO_EM_CURSO);
    const erro = await turno(depois, new Date(RESPOSTA_DO_TURNO_EM_CURSO.getTime() + PAUSA_MS + 1_000), PAUSA_MS);
    expect(String(erro?.message)).toMatch(/config LLM/);
    expect(reagendamentos(depois)).toHaveLength(0);
    const leitura = depois.consultas.find((c) => c.sql.includes("from messages") && /and id = \$3/.test(c.sql));
    expect(leitura?.params).toContain(MENSAGEM);
  });

  it("a pausa já passou: mede, não reagenda, responde", async () => {
    const banco = bancoFingido(new Date(AGORA.getTime() - PAUSA_MS - 1));

    const erro = await turno(banco, AGORA, PAUSA_MS);

    expect(String(erro?.message)).toMatch(/config LLM/);
    expect(medicoes(banco)).toHaveLength(1);
    expect(reagendamentos(banco)).toHaveLength(0);
  });
});

describe("CONTROLES — campo vazio ou 0 é o comportamento de hoje", () => {
  it.each([0, null])("pausa %s: nenhuma consulta extra e nenhum reagendamento", async (pausa) => {
    const banco = bancoFingido(RESPOSTA_DO_TURNO_EM_CURSO);

    const erro = await turno(banco, AGORA, pausa);

    expect(String(erro?.message)).toMatch(/config LLM/);
    expect(medicoes(banco)).toHaveLength(0);
    expect(reagendamentos(banco)).toHaveLength(0);
  });
});
