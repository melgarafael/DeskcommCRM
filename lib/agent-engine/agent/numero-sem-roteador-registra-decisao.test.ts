/**
 * #4340 — NÚMERO SEM ROTEADOR NÃO É UM TURNO INVISÍVEL.
 *
 * ─── O defeito medido ────────────────────────────────────────────────────────
 *
 * Quando o agente de IA muda de número de WhatsApp, o roteador fica preso ao
 * número antigo (arquivado, exibido como "Número removido", e ainda marcado
 * ativo). O número novo NÃO ganha roteador. Toda conversa que chega nele é
 * resolvida por `resolveTurnAgent` com `router === null`: o agente publicado do
 * número atende (o "agente principal"), e a resolução volta com
 * `outcome: 'no_router'` e `routerId: null`.
 *
 * O turno, então, cai no `if (routed.routerId !== null)` que grava
 * `ai_router_decisions` — e não grava nada. Resultado em produção: 43 turnos no
 * número do Atendimento, nenhum no do Agendamento, e nenhuma linha no painel
 * dizendo "este número não tem roteador". O cliente reclamou de um problema que
 * o banco não registrava.
 *
 * ─── O contrato desta fatia ──────────────────────────────────────────────────
 *
 * (a) número SEM roteador, com agente publicado (o principal): UMA linha por
 *     turno em `ai_router_decisions` com `outcome = 'no_match'` e
 *     `router_id = null` — e o turno CONTINUA saindo no agente principal
 *     (comportamento de hoje preservado: a linha é telemetria, não desvio).
 * (b) dois turnos na mesma conversa (jobs diferentes) = uma linha por turno,
 *     não duas; a reexecução do MESMO job (reagendamento) reusa a linha.
 * (c) conversa SEM `channel_session_id`: nada é gravado. Sem número não há
 *     "número sem roteador" a apontar — inventar decisão sujaria a telemetria.
 *
 * ─── Por que `no_match` e não um valor novo ──────────────────────────────────
 *
 * O CHECK de `ai_router_decisions.outcome` (baseline, apêndice da 9064) aceita
 * EXATAMENTE classified, sticky, reclassified, fallback, no_match,
 * classifier_failed e transferred. Um valor novo exigiria migration, e esta
 * fatia não tem migration. `no_match` é o desfecho honesto — não houve
 * roteador para casar — e o discriminador de "número sem roteador" é
 * `router_id is null`: todo `no_match` de um roteador DE VERDADE carrega o
 * `router_id` dele, porque aquele caminho só grava com roteador carregado.
 * (`origem` não serve: o CHECK aceita só 'classificador' e 'acao', baseline
 * 73681; e `motivo` só os três motivos de transferência, baseline 73692.)
 *
 * ─── O harness ───────────────────────────────────────────────────────────────
 *
 * `runAgentTurn` de verdade, com o mesmo banco fingido de
 * `roteador-nao-grava-duas-vezes.test.ts`: ele guarda as linhas inseridas em
 * `ai_router_decisions` e responde à guarda do job (`select 1 ... job_id = $2`)
 * com o que já foi gravado. O resto do turno segue o caminho de produção e para
 * na primeira chamada de modelo, que morre por falta de config de LLM
 * (`/config LLM/`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const espias = vi.hoisted(() => ({
  destino: vi.fn(),
  funis: vi.fn(),
}));

vi.mock("@/lib/agent-engine/agent/destino-da-intencao", () => ({
  aplicaDestinoDaIntencao: espias.destino,
  funisDeProdutoDoRoteador: espias.funis,
}));

import { runAgentTurn } from "@/lib/agent-engine/agent/inbound-turn";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CANAL = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const JOB_2 = "55555555-5555-4555-8555-555555555556";
const MENSAGEM = "66666666-6666-4666-8666-666666666666";

/** Terça 15h BRT — dentro das duas janelas (anti-ban e agente). */
const TERCA_15H = new Date("2026-10-06T18:00:00Z");

const AGENTE = {
  agentId: "agente-principal",
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
};

interface Linha {
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_derived_text: string | null;
  sent_at: Date;
}

function texto(direction: Linha["direction"], body: string, minutos: number): Linha {
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

const DO_CLIENTE = texto("inbound", "quero agendar uma visita", 3);
const HISTORICO = [texto("outbound", "Oi! Como posso ajudar?", 0), DO_CLIENTE];

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

function jobDoTurno(id: string = JOB) {
  return {
    id,
    organization_id: ORG,
    contact_id: CONTATO,
    kind: "inbound_turn",
    payload: {},
    attempts: 1,
    claimed_by: "w",
    claimed_at: TERCA_15H,
    created_at: TERCA_15H,
  };
}

interface Consulta {
  sql: string;
  params: unknown[];
}

/**
 * Banco fingido com o formato de cada consulta do turno. A ÚNICA tabela que
 * este arquivo mede é `ai_router_decisions`: as linhas inseridas ficam
 * guardadas para que a guarda de "este job já decidiu" enxergue o que a
 * passagem anterior gravou, como o Postgres faria.
 */
function bancoFingido() {
  const decisoes: unknown[][] = [];
  const consultas: Consulta[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      consultas.push({ sql, params: params ?? [] });
      if (sql.includes("insert into ai_router_decisions")) {
        decisoes.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("from ai_router_decisions")) {
        const jobId = params?.[1];
        return { rows: decisoes.some((d) => d[7] === jobId) ? [{ existe: 1 }] : [] };
      }
      if (/from contacts where organization_id = \$1 and id = \$2/.test(sql)) {
        return { rows: [LINHA_DO_CONTATO] };
      }
      if (sql.includes("from messages") && /and id = \$3/.test(sql)) {
        return { rows: [DO_CLIENTE] };
      }
      if (sql.includes("from messages") && sql.includes("media_mime")) {
        return { rows: [...HISTORICO].reverse() };
      }
      if (sql.includes("playbook_pointers")) {
        return { rows: [{ layer: "platform", version_id: "v1", content: "plataforma" }] };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return { pool, decisoes, consultas };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** A resolução do turno num número SEM roteador: agente do número, `no_router`. */
const SEM_ROTEADOR = {
  config: AGENTE,
  routerId: null,
  intentName: null,
  confidence: null,
  outcome: "no_router",
} as const;

async function passagem(
  banco: ReturnType<typeof bancoFingido>,
  opcoes: { jobId?: string; channelSessionId?: string; log?: ReturnType<typeof logFalso> } = {},
): Promise<{ erro: Error | null; log: ReturnType<typeof logFalso> }> {
  const log = opcoes.log ?? logFalso();
  try {
    await runAgentTurn(
      {
        log,
        llmCfg: {},
        crmCfg: {},
        knobs: { maxSteps: 1 },
        clock: () => TERCA_15H,
      } as never,
      jobDoTurno(opcoes.jobId ?? JOB) as never,
      banco.pool as never,
      { workerId: "w" },
      {
        resolvedAgent: SEM_ROTEADOR,
        channelSessionId: opcoes.channelSessionId ?? CANAL,
        conversationId: CONVERSA,
        inboundMessageId: MENSAGEM,
        buildOpening: () => "",
      } as never,
    );
    return { erro: null, log };
  } catch (err) {
    return { erro: err as Error, log };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  espias.funis.mockResolvedValue([]);
  espias.destino.mockResolvedValue({ status: "movido" });
});

describe("#4340 (a) número sem roteador grava UMA decisão no_match e mantém o agente principal", () => {
  it("grava uma linha com outcome no_match, router_id nulo e o agente que atendeu", async () => {
    const banco = bancoFingido();

    const { erro } = await passagem(banco);

    // O turno segue o caminho de produção e para na falta de config de LLM —
    // ou seja, chegou ao mesmo ponto de antes: o agente principal atende.
    expect(String(erro?.message)).toMatch(/config LLM/);
    expect(banco.decisoes, "número sem roteador não gravou decisão nenhuma").toHaveLength(1);

    const [org, routerId, conversa, intencao, confianca, agente, outcome, jobId] = banco.decisoes[0]!;
    expect(org).toBe(ORG);
    expect(routerId, "a linha do número sem roteador não pode inventar router_id").toBeNull();
    expect(conversa).toBe(CONVERSA);
    expect(intencao).toBeNull();
    expect(confianca).toBeNull();
    expect(agente, "o agente que de fato atendeu o turno tem de estar na linha").toBe("agente-principal");
    expect(outcome).toBe("no_match");
    expect(jobId).toBe(JOB);
  });

  it("o registro do número sem roteador sai UMA vez por turno, como info e não como aviso", async () => {
    const banco = bancoFingido();
    const log = logFalso();

    await passagem(banco, { log });

    const semRoteador = ([mensagem]: unknown[]) =>
      String(mensagem).toLowerCase().includes("sem roteador");
    const avisos = log.info.mock.calls.filter(semRoteador);
    expect(avisos, "o registro de número sem roteador tem de sair exatamente uma vez").toHaveLength(1);
    // Estado normal de quem nunca criou roteador: não é `warn` a cada turno.
    expect(log.warn.mock.calls.filter(semRoteador)).toHaveLength(0);
    expect(avisos[0]?.[1]).toMatchObject({ conversation_id: CONVERSA, agent_id: "agente-principal" });
  });
});

describe("#4340 (b) uma linha POR TURNO — nem duas no mesmo, nem uma para dois", () => {
  it("dois turnos na mesma conversa geram duas linhas (uma de cada job)", async () => {
    const banco = bancoFingido();

    await passagem(banco, { jobId: JOB });
    await passagem(banco, { jobId: JOB_2 });

    expect(banco.decisoes, "um dos dois turnos ficou invisível").toHaveLength(2);
    expect(banco.decisoes.map((d) => d[7])).toEqual([JOB, JOB_2]);
  });

  it("a reexecução do MESMO job (reagendamento) não duplica a linha", async () => {
    const banco = bancoFingido();

    await passagem(banco);
    expect(banco.decisoes).toHaveLength(1);

    // A fila devolve a MESMA linha de job_queue para 'pending': mesmo job_id.
    await passagem(banco);

    expect(banco.decisoes, "a reexecução do mesmo job gravou a decisão duas vezes").toHaveLength(1);
    expect(banco.consultas.filter((c) => c.sql.includes("select 1 from ai_router_decisions"))).toHaveLength(2);
  });
});

describe("#4340 (c) conversa sem channel_session_id não inventa decisão", () => {
  it("sem número não há 'número sem roteador' a apontar: nada é gravado", async () => {
    const banco = bancoFingido();

    await passagem(banco, { channelSessionId: "" });

    expect(banco.decisoes, "gravou decisão de roteamento para uma conversa sem número").toHaveLength(0);
  });
});

describe("#4340 CONTROLES — o que já gravava continua igual", () => {
  it("turno com roteador de verdade segue gravando a decisão do roteador (não no_match)", async () => {
    const banco = bancoFingido();
    const log = logFalso();

    // O turno morre na falta de config de LLM, como o de cima: o que se mede é
    // a linha gravada ANTES disso.
    await runAgentTurn(
      { log, llmCfg: {}, crmCfg: {}, knobs: { maxSteps: 1 }, clock: () => TERCA_15H } as never,
      jobDoTurno() as never,
      banco.pool as never,
      { workerId: "w" },
      {
        resolvedAgent: {
          config: AGENTE,
          routerId: "router-1",
          intentName: "agendamento",
          confidence: 0.9,
          outcome: "classified",
        },
        channelSessionId: CANAL,
        conversationId: CONVERSA,
        inboundMessageId: MENSAGEM,
        buildOpening: () => "",
      } as never,
    ).catch(() => undefined);

    expect(banco.decisoes).toHaveLength(1);
    expect(banco.decisoes[0]?.[1]).toBe("router-1");
    expect(banco.decisoes[0]?.[6]).toBe("classified");
    expect(
      [...log.info.mock.calls, ...log.warn.mock.calls].filter(([m]) =>
        String(m).toLowerCase().includes("sem roteador"),
      ),
      "registro de número sem roteador num turno que TEM roteador",
    ).toHaveLength(0);
  });
});
