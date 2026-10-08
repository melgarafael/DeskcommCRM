/**
 * AS LEITURAS INDEPENDENTES DO TURNO CORREM JUNTAS — E AS DEPENDENTES, DEPOIS.
 *
 * O banco é remoto (o instalador usa Supabase em nuvem), então cada `await` em
 * série antes do modelo é um RTT de rede que o cliente espera de "digitando…"
 * apagado. A regressão é invisível: trocar um `Promise.all` por dois `await`
 * deixa o comportamento certo e o turno mais lento. Por isso a régua aqui é a
 * PROFUNDIDADE observada num pool fingido que anota início e fim de cada
 * consulta — não o texto da fonte.
 *
 * Três propriedades, nas duas direções:
 *   - o que não depende de nada corre junto (os quatro trilhos da abertura, as
 *     quatro leituras do contexto, as três da memória do lead);
 *   - o que depende continua depois de quem o alimenta (playbook depois da
 *     prospecção; o contexto inteiro depois do contato; o histórico depois da
 *     conversa resolvida);
 *   - nunca mais de 4 consultas em voo por turno. É o formato das trilhas, não
 *     um encaixe no pool: 8 turnos juntos pedem até 32 leituras sobre as 10
 *     conexões do default do pg, e o pg enfileira o excesso. O teto guarda que
 *     o paralelismo não cresça sem alguém decidir DB_POOL_MAX junto.
 *
 * O turno roda de verdade (`runAgentTurn`) até a primeira chamada de modelo, que
 * para por falta de configuração de LLM na org — é o ponto de parada desejado:
 * todas as leituras medidas vêm antes dele.
 */
import { describe, expect, it } from "vitest";

import { runAgentTurn } from "@/lib/agent-engine/agent/inbound-turn";
import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "55555555-5555-4555-8555-555555555555";

/** Nome legível de cada leitura, pelo SQL. A ordem importa: o mais específico primeiro. */
const LEITURAS: Array<[string, (sql: string) => boolean]> = [
  ["prospeccao", (s) => s.includes("prospecting_candidates")],
  ["playbook", (s) => s.includes("playbook_pointers")],
  ["skills", (s) => s.includes("skill_pointers")],
  ["memoria_doc", (s) => s.includes("org_memory_pointers")],
  ["memoria_entradas", (s) => s.includes("org_memory_entries")],
  ["checkpoint", (s) => s.includes("from lead_checkpoints")],
  ["lead_state", (s) => s.includes("from lead_state")],
  ["mensagem_do_job", (s) => s.includes("from messages") && /and id = \$3/.test(s)],
  ["historico", (s) => s.includes("from messages") && s.includes("media_mime")],
  ["contato", (s) => /from contacts where organization_id = \$1 and id = \$2/.test(s)],
  ["conversa", (s) => s.includes("from conversations") && s.includes("is_group = false")],
  ["desfechos", (s) => s.includes("from demandas")],
  ["decisao", (s) => s.includes("crm_lead_activities")],
  ["proposta", (s) => s.includes("crm_proposals")],
  ["indice_notas", (s) => s.includes("select id, headline from lead_notes")],
  ["compromissos", (s) => s.includes("calendar_app")],
  ["ids_notas", (s) => s.includes("select id from lead_notes")],
];

const LINHA_DO_CONTATO = {
  name: "Cliente", display_name: null, email: null, phone_number: "5511999999999", tags: [],
  is_blocked: false, is_personal: false, source: "whatsapp", consent: null, is_anonymized: false,
};

/**
 * Pool fingido que anota, em ordem, o início e o fim de cada consulta. Cada uma
 * leva um tique de relógio: sem isso, tudo terminaria antes da próxima começar
 * e a sonda mediria só a ordem das chamadas, nunca a sobreposição.
 */
function poolQueAnota(opts: { decisaoFalha?: boolean } = {}) {
  const eventos: Array<{ nome: string; tipo: "inicio" | "fim" }> = [];
  let emVoo = 0;
  let maxEmVoo = 0;
  const query = async (sql: string) => {
    const nome = LEITURAS.find(([, casa]) => casa(sql))?.[0] ?? `outra: ${sql.replace(/\s+/g, " ").slice(0, 40)}`;
    eventos.push({ nome, tipo: "inicio" });
    emVoo += 1;
    maxEmVoo = Math.max(maxEmVoo, emVoo);
    try {
      await new Promise((r) => setTimeout(r, 2));
      if (nome === "decisao" && opts.decisaoFalha) throw new Error("conexão caiu");
      if (nome === "playbook") return { rows: [{ layer: "platform", version_id: "v1", content: "plataforma" }] };
      if (nome === "contato") return { rows: [LINHA_DO_CONTATO] };
      if (nome === "conversa") return { rows: [{ id: CONVERSA }] };
      return { rows: [] };
    } finally {
      emVoo -= 1;
      eventos.push({ nome, tipo: "fim" });
    }
  };
  const posicao = (nome: string, tipo: "inicio" | "fim"): number => {
    const i = eventos.findIndex((e) => e.nome === nome && e.tipo === tipo);
    if (i === -1) throw new Error(`a leitura "${nome}" não aconteceu`);
    return i;
  };
  return {
    db: { query },
    eventos,
    maxEmVoo: () => maxEmVoo,
    /** Todas estavam em voo ao mesmo tempo: a última começou antes de a primeira acabar. */
    juntas: (...nomes: string[]) =>
      Math.max(...nomes.map((n) => posicao(n, "inicio"))) < Math.min(...nomes.map((n) => posicao(n, "fim"))),
    /** `a` só começou depois de `b` terminar. */
    depois: (a: string, b: string) => posicao(a, "inicio") > posicao(b, "fim"),
  };
}

const deps = {
  log: { info() {}, warn() {}, error() {}, debug() {} },
  llmCfg: {},
  crmCfg: {},
  knobs: { maxSteps: 1 },
  clock: () => new Date("2026-10-06T15:00:00Z"),
};

async function turnoAteOModelo(pool: ReturnType<typeof poolQueAnota>) {
  const job = {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: ORG,
    contact_id: CONTATO,
    kind: "inbound_turn",
    payload: {},
    attempts: 1,
    claimed_by: "w",
    claimed_at: new Date(),
  };
  await expect(
    runAgentTurn(deps as never, job as never, pool.db as never, { workerId: "w" }, {
      resolvedAgent: {
        config: {
          agentId: "agente-1", versionId: "v1", operationMode: "automatic", pausedAt: null,
          systemPrompt: "persona", toolIds: [], casesEnabled: false,
          historyMessageWindow: 20, historyTokenWindow: 1000,
        },
        routerId: null, intentName: null, confidence: null, outcome: "fallback",
      },
      channelSessionId: "44444444-4444-4444-8444-444444444444",
      conversationId: CONVERSA,
      inboundMessageId: "66666666-6666-4666-8666-666666666666",
      buildOpening: () => "",
    } as never),
    // O ponto de parada: a primeira chamada de modelo. Todas as leituras medidas vêm antes.
  ).rejects.toThrow(/config LLM/);
}

describe("turno inbound — leituras da abertura", () => {
  it("os quatro trilhos da abertura correm juntos", async () => {
    const pool = poolQueAnota();
    await turnoAteOModelo(pool);
    expect(pool.juntas("prospeccao", "skills", "memoria_doc", "checkpoint")).toBe(true);
  });

  it("dentro de cada trilho, a segunda leitura espera a primeira — o playbook espera a prospecção", async () => {
    const pool = poolQueAnota();
    await turnoAteOModelo(pool);
    // A camada do agente leva o contexto da campanha: sem ele, o playbook sairia errado.
    expect(pool.depois("playbook", "prospeccao")).toBe(true);
    expect(pool.depois("memoria_entradas", "memoria_doc")).toBe(true);
    expect(pool.depois("lead_state", "checkpoint")).toBe(true);
    expect(pool.depois("mensagem_do_job", "skills")).toBe(true);
  });

  it("o contexto do lead começa pelo contato e só então abre as quatro leituras juntas", async () => {
    const pool = poolQueAnota();
    await turnoAteOModelo(pool);
    for (const leitura of ["historico", "desfechos", "decisao", "proposta"]) {
      expect(pool.depois(leitura, "contato"), leitura).toBe(true);
    }
    expect(pool.juntas("historico", "desfechos", "decisao", "proposta")).toBe(true);
  });

  it("a memória do lead (índice, compromissos, ids) corre junta", async () => {
    const pool = poolQueAnota();
    await turnoAteOModelo(pool);
    expect(pool.juntas("indice_notas", "compromissos", "ids_notas")).toBe(true);
  });

  it("nunca mais de 4 consultas em voo no turno", async () => {
    const pool = poolQueAnota();
    await turnoAteOModelo(pool);
    expect(pool.maxEmVoo()).toBeLessThanOrEqual(4);
    // Controle: sem paralelismo nenhum o máximo seria 1, e o teto acima passaria por vazio.
    expect(pool.maxEmVoo()).toBeGreaterThan(1);
  });
});

describe("getLeadContext — sem a conversa do job", () => {
  const INPUT = { tenantId: ORG, leadId: CONTATO, conversationId: null, fuso: "America/Sao_Paulo" };
  const KNOBS = { historyLimit: 20, maxTokens: 1000 };

  it("histórico e desfechos esperam a conversa resolvida; decisão e proposta não", async () => {
    const pool = poolQueAnota();
    const r = await getLeadContext(pool.db as never, {} as never, INPUT, KNOBS);
    expect(r.ok).toBe(true);
    expect(pool.depois("historico", "conversa")).toBe(true);
    expect(pool.depois("desfechos", "conversa")).toBe(true);
    expect(pool.juntas("conversa", "decisao", "proposta")).toBe(true);
    expect(pool.juntas("historico", "desfechos")).toBe(true);
    expect(pool.maxEmVoo()).toBeLessThanOrEqual(4);
  });

  it("falha da decisão continua derrubando o contexto, como em série", async () => {
    const pool = poolQueAnota({ decisaoFalha: true });
    await expect(getLeadContext(pool.db as never, {} as never, INPUT, KNOBS)).rejects.toThrow(
      "conexão caiu",
    );
  });
});
