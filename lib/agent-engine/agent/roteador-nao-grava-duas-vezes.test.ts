/**
 * #3143 — O TURNO ADIADO PELA JANELA DO AGENTE NÃO GRAVA A DECISÃO DUAS VEZES.
 *
 * ─── O defeito medido ────────────────────────────────────────────────────────
 *
 * Com o #2696 a checagem de horário de funcionamento do agente
 * (`msAteAJanelaAbrir`) desceu para DEPOIS de o roteador ter rodado
 * (`resolveConversationTurn`), da gravação em `ai_router_decisions` e de
 * `aplicaDestinoDaIntencao`. Num turno que chega com o horário do agente fechado
 * e a janela de envio do número aberta — 19h para um agente 8h-18h — o turno é
 * REAGENDADO depois de tudo isso.
 *
 * Reagendar não cria turno novo: `rescheduleJob` devolve a MESMA linha de
 * `job_queue` para 'pending' (sem consumir `attempts`), e a reexecução roda com
 * o mesmo `job_id`. O roteador roda de novo e, sem o conserto, o job termina com
 * DUAS linhas em `ai_router_decisions`, além de `aplicaDestinoDaIntencao` ter
 * rodado duas vezes (a segunda devolveria `ja_no_destino`/`destino_ocupado`).
 *
 * ─── O conserto, e a saída escolhida ─────────────────────────────────────────
 *
 * (b) REUSAR na reexecução a decisão já gravada: a guarda pergunta se ESTE job
 * já tem decisão em `ai_router_decisions` e, se tiver, não grava de novo nem
 * reaplica o destino do card. A outra saída da issue — não gravar quando o turno
 * vai ser adiado — exigiria ler a janela do agente antes do roteador, e é
 * justamente essa a ordem que o #2696 fixou (pedido de atendente e opt-out vêm
 * ANTES da janela): o turno que encerra em handoff com o agente fechado não é
 * adiado, e ali a decisão TEM de ser gravada.
 *
 * ─── O harness ───────────────────────────────────────────────────────────────
 *
 * Duas passagens do MESMO job no MESMO banco fingido — é o que a fila faz. O
 * banco guarda as linhas de `ai_router_decisions` inseridas, então a segunda
 * passagem enxerga o que a primeira gravou, e o relógio injetado escolhe o
 * horário de cada passagem (19h e 8h; 23h e 12h; 15h). O resto do turno segue o
 * caminho de produção e para na primeira chamada de modelo, que morre por falta
 * de config de LLM na org (`/config LLM/`) — o mesmo ponto de parada de
 * `tests/unit/filtro-de-palavra-chave-no-turno.test.ts`.
 *
 * A régua do card (`aplicaDestinoDaIntencao`) é dublada — não há CRM aqui — mas
 * continua sendo UM contador por passagem: é ele que prova o "não roda duas
 * vezes" do turno reagendado.
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
const MENSAGEM = "66666666-6666-4666-8666-666666666666";
const ROTEADOR = "77777777-7777-4777-8777-777777777777";
const FUNIL = "88888888-8888-4888-8888-888888888888";
const ETAPA = "99999999-9999-4999-8999-999999999999";

/** Terça 15h BRT — dentro das DUAS janelas (anti-ban 7h-22h e agente 8h-18h). */
const TERCA_15H = new Date("2026-10-06T18:00:00Z");
/** Terça 19h BRT — janela de envio ABERTA, agente 8h-18h FECHADO. */
const TERCA_19H = new Date("2026-10-06T22:00:00Z");
/** Terça 23h BRT — janela de envio FECHADA (o gate anti-ban adia antes do roteador). */
const TERCA_23H = new Date("2026-10-07T02:00:00Z");
/** Quarta 8h BRT — a abertura da janela do agente 8h-18h. */
const QUARTA_8H = new Date("2026-10-07T11:00:00Z");
/** Quarta 12h BRT — dentro das duas janelas. */
const QUARTA_12H = new Date("2026-10-07T15:00:00Z");

const JANELA_8_18 = {
  timezone: "America/Sao_Paulo",
  start: "08:00",
  end: "18:00",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
};

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

const DO_CLIENTE = texto("inbound", "quero um orçamento de camiseta", 3);
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

const JOB_DO_TURNO = {
  id: JOB,
  organization_id: ORG,
  contact_id: CONTATO,
  kind: "inbound_turn",
  payload: {},
  attempts: 1,
  claimed_by: "w",
  claimed_at: TERCA_19H,
  /** Enfileirado às 19h — a guarda só procura decisão a partir daqui. */
  created_at: TERCA_19H,
};

interface Consulta {
  sql: string;
  params: unknown[];
}

/**
 * O banco fingido com o formato de CADA consulta que o turno faz — e, no meio
 * dele, a ÚNICA tabela que este arquivo mede: `ai_router_decisions`. Ela guarda
 * as linhas inseridas para que a passagem seguinte enxergue o que a anterior
 * gravou, exatamente como o Postgres de produção faz entre as duas execuções do
 * mesmo job.
 */
function bancoFingido() {
  const decisoes: unknown[][] = [];
  const consultas: Consulta[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      consultas.push({ sql, params: params ?? [] });
      if (sql.includes("insert into ai_router_decisions")) {
        decisoes.push(params ?? []);
        return { rows: [] };
      }
      if (sql.includes("from ai_router_decisions")) {
        return { rows: decisoes.length > 0 ? [{ existe: 1 }] : [] };
      }
      if (/from contacts where organization_id = \$1 and id = \$2/.test(sql)) {
        return { rows: [LINHA_DO_CONTATO] };
      }
      if (sql.includes("from messages") && /and id = \$3/.test(sql)) {
        return { rows: [DO_CLIENTE] };
      }
      if (sql.includes("from messages") && sql.includes("media_mime")) {
        // O produtor pede DESC e inverte — devolve DESC, como o banco.
        return { rows: [...HISTORICO].reverse() };
      }
      // A camada plataforma do playbook é obrigatória para o turno abrir.
      if (sql.includes("playbook_pointers")) {
        return { rows: [{ layer: "platform", version_id: "v1", content: "plataforma" }] };
      }
      return { rows: [] };
    }),
  };
  return { pool, decisoes, consultas };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** UMA passagem do turno — o que o worker faz a cada vez que pega este job. */
async function passagem(
  banco: ReturnType<typeof bancoFingido>,
  instante: Date,
  janela: unknown,
): Promise<Error | null> {
  try {
    await runAgentTurn(
      {
        log: logFalso(),
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
          config: { ...AGENTE, janelaDeAtendimento: janela },
          routerId: ROTEADOR,
          intentName: "orcamento",
          confidence: 0.9,
          outcome: "matched",
          destinationPipelineId: FUNIL,
          destinationStageId: ETAPA,
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

/** A guarda do job (`select 1 from ai_router_decisions ... job_id = $2`). */
const consultasDaGuarda = (banco: ReturnType<typeof bancoFingido>): Consulta[] =>
  banco.consultas.filter((c) => c.sql.includes("select 1 from ai_router_decisions"));

beforeEach(() => {
  vi.clearAllMocks();
  espias.funis.mockResolvedValue([]);
  espias.destino.mockResolvedValue({ status: "movido" });
});

describe("turno adiado pela janela do agente — o job grava UMA decisão", () => {
  it("19h (agente fechado) e 8h (reexecução): uma linha em ai_router_decisions", async () => {
    const banco = bancoFingido();

    // PASSAGEM 1 — 19h: janela de envio aberta, agente 8h-18h fechado. O turno
    // é adiado (o roteador já rodou e a decisão já foi gravada: é o defeito).
    const primeira = await passagem(banco, TERCA_19H, JANELA_8_18);
    expect(String(primeira?.message)).toMatch(/fora do horário de funcionamento/);
    expect(banco.decisoes).toHaveLength(1);

    // PASSAGEM 2 — 8h: o MESMO job volta a rodar. O roteador roda de novo, mas a
    // decisão já gravada é REUSADA: o job inteiro fica com UMA linha.
    const segunda = await passagem(banco, QUARTA_8H, JANELA_8_18);
    expect(String(segunda?.message)).toMatch(/config LLM/);
    expect(banco.decisoes, "o turno reagendado gravou a decisão duas vezes").toHaveLength(1);

    // A linha é deste job (é o `job_id` que a guarda consulta).
    expect(banco.decisoes[0]?.[7]).toBe(JOB);
    // E a reexecução de fato PASSOU pela guarda — sem esta consulta, a contagem
    // acima poderia estar verde por o turno ter morrido antes da gravação.
    const guardas = consultasDaGuarda(banco);
    expect(guardas).toHaveLength(2);
    expect(guardas[1]?.params).toEqual([ORG, JOB, TERCA_19H]);
  });

  it("a guarda limita a busca à criação do job (entra por índice com created_at)", async () => {
    const banco = bancoFingido();

    await passagem(banco, TERCA_19H, JANELA_8_18);

    // Sem o limite a consulta varre a tabela: não há índice com `job_id`, e os
    // que existem começam por `created_at` ou por (organization_id, created_at).
    const [guarda] = consultasDaGuarda(banco);
    expect(guarda?.sql).toContain("created_at >= $3");
    expect(guarda?.params[2], "a guarda perdeu o limite pela criação do job").toBe(
      JOB_DO_TURNO.created_at,
    );
  });

  it("o destino do card não é aplicado duas vezes no turno reagendado", async () => {
    const banco = bancoFingido();

    await passagem(banco, TERCA_19H, JANELA_8_18);
    expect(espias.destino).toHaveBeenCalledTimes(1);

    await passagem(banco, QUARTA_8H, JANELA_8_18);
    // A segunda chamada só devolveria `ja_no_destino`/`destino_ocupado`
    // (`destino-da-intencao.ts`): não move nem cria card de novo.
    expect(espias.destino, "o destino foi reaplicado na reexecução").toHaveBeenCalledTimes(1);
  });
});

describe("CONTROLES — o que já gravava uma linha segue gravando uma linha", () => {
  it("turno normal (agente ABERTO, 15h): uma linha, como sempre", async () => {
    const banco = bancoFingido();

    const erro = await passagem(banco, TERCA_15H, JANELA_8_18);

    expect(String(erro?.message)).toMatch(/config LLM/);
    expect(banco.decisoes).toHaveLength(1);
    expect(espias.destino).toHaveBeenCalledTimes(1);
  });

  it("22h/23h (janela anti-ban adia antes do roteador): uma linha, na reexecução", async () => {
    const banco = bancoFingido();

    // PASSAGEM 1 — 23h: o gate anti-ban adia ANTES do roteador. Nada é gravado,
    // então não há decisão a reusar.
    const primeira = await passagem(banco, TERCA_23H, null);
    expect(String(primeira?.message)).toMatch(/fora da janela anti-ban/);
    expect(banco.decisoes).toHaveLength(0);

    // PASSAGEM 2 — 12h: o job roda de verdade e grava a decisão dele.
    const segunda = await passagem(banco, QUARTA_12H, null);
    expect(String(segunda?.message)).toMatch(/config LLM/);
    expect(banco.decisoes, "a guarda calou um turno que nunca tinha gravado").toHaveLength(1);
    expect(espias.destino).toHaveBeenCalledTimes(1);
  });
});
