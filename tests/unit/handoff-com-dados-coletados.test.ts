import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A passagem com DADOS COLETADOS — o caminho sem ferramenta do modelo.
 *
 * Um fluxo determinístico (coleta campo a campo, um por turno) encerra em
 * handoff: quem assume precisa receber os campos que já foram perguntados —
 * e receber NA PASSAGEM (lida sob `fn_can_view_conversation`), nunca no corpo
 * da Central (que a rota entrega a QUALQUER `agent`). O motivo é o canônico
 * `verificacao_manual`: o cliente não pediu uma pessoa, um fluxo coletou
 * dados e passou para verificação humana — o rótulo tem de dizer o que
 * houve, porque é a primeira frase de quem abre a conversa.
 *
 * Sem campos (ou com todos em branco), o caminho é o de antes, byte a byte:
 * nenhuma passagem é gravada — o invariant `escalacao-ciclo-humano` é
 * arquivo CONGELADO que chama `performHumanHandoff` com a assinatura antiga.
 */

vi.mock("@/lib/atendimento/fronteira-server", () => ({ guardServiceEffect: vi.fn(async () => {}) }));
vi.mock("@/lib/leads/agent-activity", () => ({
  emitAgentActivityForContact: vi.fn(async () => ({ routed: true })),
}));
vi.mock("@/lib/agent-engine/cron/scheduler", () => ({ cancelPendingCronsForLead: vi.fn(async () => {}) }));

import { performHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";

const consultas: Array<{ sql: string; params: unknown[] }> = [];

/** Pool dublê: grava as consultas e devolve vazio — o suficiente para o caminho. */
const db = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }),
};

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };

beforeEach(() => {
  consultas.length = 0;
  db.query.mockClear();
});

async function passar(optsExtra: Record<string, unknown>): Promise<void> {
  await performHumanHandoff(
    db as never,
    { tenantId: "org1", leadId: "cont1", conversationId: "conv1" },
    {
      reason: "report_readiness",
      conversationSummary: "resumo",
      log: log as never,
      ...optsExtra,
    } as never,
  );
}

/** As colunas do INSERT, na mesma ordem de `COLUNAS_DA_PASSAGEM`. */
const COLUNAS = [
  "organization_id",
  "contact_id",
  "conversation_id",
  "caso_id",
  "motor",
  "origem",
  "motivo_codigo",
  "title",
  "body",
  "notes",
  "content",
  "tentativas",
  "cliente_avisado",
  "aviso_motivo_codigo",
];

function linhaDaPassagem(): Record<string, unknown> {
  const insert = consultas.find((c) => /insert into passagens_de_atendimento/.test(c.sql));
  expect(insert, "a passagem não foi gravada").toBeTruthy();
  return Object.fromEntries(COLUNAS.map((c, i) => [c, insert!.params[i]]));
}

function gravouPassagem(): boolean {
  return consultas.some((c) => /insert into passagens_de_atendimento/.test(c.sql));
}

describe("handoff com dados coletados (sem ferramenta do modelo)", () => {
  it("grava UMA passagem: motivo verificacao_manual, origem runtime_nativo, campos no body", async () => {
    await passar({ camposColetados: { nome: "Maria", exame: "Hemograma" } });
    const linha = linhaDaPassagem();
    expect(linha.origem).toBe("runtime_nativo");
    expect(linha.motivo_codigo).toBe("verificacao_manual");
    expect(String(linha.body)).toContain("• nome: Maria");
    expect(String(linha.body)).toContain("• exame: Hemograma");
    expect(String(linha.title)).toBe("Dados coletados: nome, exame");
  });

  it("sem campos coletados: NENHUMA passagem — o caminho legado byte a byte", async () => {
    await passar({});
    expect(gravouPassagem()).toBe(false);
  });

  it("campos todos em branco também não abrem passagem (coleta sem resultado)", async () => {
    await passar({ camposColetados: { nome: "   " } });
    expect(gravouPassagem()).toBe(false);
  });

  it("com passagem declarada (caminho da ferramenta do modelo), os campos NÃO abrem uma segunda linha", async () => {
    await passar({
      camposColetados: { nome: "Maria" },
      passagem: {
        origem: "ferramenta_do_modelo",
        motivoCodigo: "requested_human",
        briefing: { body: "b", title: null, notes: null, content: null, tentativas: [] },
      },
    });
    const inserts = consultas.filter((c) => /insert into passagens_de_atendimento/.test(c.sql));
    expect(inserts.length).toBe(1);
    // Índice 6 = motivo_codigo, na ordem de COLUNAS_DA_PASSAGEM.
    expect(inserts[0]!.params[6]).toBe("requested_human");
  });

  it("o aviso da Central continua CURTO — os campos não vão ao corpo entregue a qualquer agent", async () => {
    await passar({ camposColetados: { nome: "Maria" } });
    const inbox = consultas.find((c) => /insert into agent_inbox_items/.test(c.sql));
    expect(inbox, "o aviso da Central não saiu").toBeTruthy();
    expect(String(inbox!.params[2])).not.toContain("Maria");
    // O corpo legado é `Motivo: <reason>.` — o motivo cru, em qualquer idioma.
    expect(String(inbox!.params[2])).toContain("report_readiness");
  });

  it("a ordem dos efeitos se mantém: passagem antes do aviso da Central", async () => {
    await passar({ camposColetados: { nome: "Maria" } });
    const idxPassagem = consultas.findIndex((c) => /insert into passagens_de_atendimento/.test(c.sql));
    const idxAviso = consultas.findIndex((c) => /insert into agent_inbox_items/.test(c.sql));
    expect(idxPassagem).toBeGreaterThanOrEqual(0);
    expect(idxAviso).toBeGreaterThan(idxPassagem);
  });
});

/**
 * ═══ O RETRY NO-OP E O AVISO NA LINHA — portados do #3063 ═══
 *
 * O gancho de extensão (#3076) fecha o caminho (c3) com `idempotenciaDaPassagem`
 * = a mensagem que ele reivindicou. Sem o recibo, um retry do MESMO turno
 * gravava duas passagens para o mesmo fato — e a segunda aparecia para quem
 * assumiu como se o cliente tivesse pedido duas vezes.
 */
describe("(c3) com chave de idempotência (portado do #3063)", () => {
  const clienteConsultas: Array<{ sql: string; params: unknown[] }> = [];

  function poolComConexao(reciboGravado: string | null) {
    clienteConsultas.length = 0;
    const cliente = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        clienteConsultas.push({ sql, params });
        if (/select metadata->'passagem_verificacao_manual'->>'msg'/.test(sql)) {
          return { rows: [{ msg: reciboGravado }], rowCount: 1 };
        }
        if (/insert into passagens_de_atendimento/.test(sql)) {
          // O insert do registrarPassagem devolve a linha gravada.
          return { rows: [{ id: "p1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    return {
      ...db,
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        consultas.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(async () => cliente),
    };
  }

  beforeEach(() => {
    clienteConsultas.length = 0;
  });

  it("sem recibo: grava a linha e o recibo na MESMA transação, na ordem begin→lock→lookup→insert→recibo→commit", async () => {
    const pool = poolComConexao(null);
    await performHumanHandoff(
      pool as never,
      { tenantId: "org1", leadId: "cont1", conversationId: "conv1" },
      {
        reason: "verificacao_manual",
        conversationSummary: "resumo",
        camposColetados: { nome: "Maria" },
        idempotenciaDaPassagem: "m1",
        log: log as never,
      } as never,
    );
    const sqls = clienteConsultas.map((c) => c.sql.trim().split(/\s+/)[0]);
    const marcos = clienteConsultas.map((c) => c.sql);
    const posBegin = marcos.findIndex((s) => /^begin$/.test(s.trim()));
    const posLock = marcos.findIndex((s) => /pg_advisory_xact_lock/.test(s));
    const posLookup = marcos.findIndex((s) => /passagem_verificacao_manual.*->>'msg'/.test(s));
    const posInsert = marcos.findIndex((s) => /insert into passagens_de_atendimento/.test(s));
    const posRecibo = marcos.findIndex((s) => /jsonb_build_object\(\$3, jsonb_build_object\('msg'/.test(s));
    const posCommit = marcos.findIndex((s) => /^commit$/.test(s.trim()));
    expect(sqls.length).toBeGreaterThan(0);
    for (const [nome, pos] of [
      ["begin", posBegin],
      ["lock", posLock],
      ["lookup", posLookup],
      ["insert", posInsert],
      ["recibo", posRecibo],
      ["commit", posCommit],
    ] as const) {
      expect(pos, `passo ausente: ${nome}`).toBeGreaterThanOrEqual(0);
    }
    expect(posBegin).toBeLessThan(posLock);
    expect(posLock).toBeLessThan(posLookup);
    expect(posLookup).toBeLessThan(posInsert);
    expect(posInsert).toBeLessThan(posRecibo);
    expect(posRecibo).toBeLessThan(posCommit);
    // O lock é POR CONVERSA, com o motivo no nome.
    const lock = clienteConsultas[posLock]!;
    expect(String(lock.params[0])).toBe("org1:conv1:verificacao_manual");
    // O recibo guarda a MENSAGEM reivindicada.
    expect(clienteConsultas[posRecibo]!.params[3]).toBe("m1");
  });

  it("⭐ retry da MESMA mensagem: lê o recibo e NÃO grava linha nem recibo de novo", async () => {
    const pool = poolComConexao("m1");
    await performHumanHandoff(
      pool as never,
      { tenantId: "org1", leadId: "cont1", conversationId: "conv1" },
      {
        reason: "verificacao_manual",
        conversationSummary: "resumo",
        camposColetados: { nome: "Maria" },
        idempotenciaDaPassagem: "m1",
        log: log as never,
      } as never,
    );
    expect(clienteConsultas.some((c) => /insert into passagens_de_atendimento/.test(c.sql))).toBe(false);
    expect(clienteConsultas.some((c) => /jsonb_build_object\(\$3, jsonb_build_object\('msg'/.test(c.sql))).toBe(
      false,
    );
    expect(clienteConsultas.some((c) => /^rollback$/m.test(c.sql.trim()) || /rollback/.test(c.sql))).toBe(true);
  });

  it("mensagem NOVA (recibo de outra) grava o fato novo", async () => {
    const pool = poolComConexao("m0");
    await performHumanHandoff(
      pool as never,
      { tenantId: "org1", leadId: "cont1", conversationId: "conv1" },
      {
        reason: "verificacao_manual",
        conversationSummary: "resumo",
        camposColetados: { nome: "Maria" },
        idempotenciaDaPassagem: "m1",
        log: log as never,
      } as never,
    );
    expect(clienteConsultas.some((c) => /insert into passagens_de_atendimento/.test(c.sql))).toBe(true);
  });

  it("sem chave (chamador legado) o caminho é o de sempre: INSERT solto do pool, sem transação", async () => {
    const pool = poolComConexao(null);
    await performHumanHandoff(
      pool as never,
      { tenantId: "org1", leadId: "cont1", conversationId: "conv1" },
      {
        reason: "verificacao_manual",
        conversationSummary: "resumo",
        camposColetados: { nome: "Maria" },
        log: log as never,
      } as never,
    );
    expect(pool.connect).not.toHaveBeenCalled();
    expect(gravouPassagem()).toBe(true);
  });

  it("⭐ o avisoAoLead do chamador vira LINHA na passagem do (c3): gravado ≠ avisado", async () => {
    const pool = poolComConexao(null);
    await performHumanHandoff(
      pool as never,
      { tenantId: "org1", leadId: "cont1", conversationId: "conv1" },
      {
        reason: "verificacao_manual",
        conversationSummary: "resumo",
        camposColetados: { nome: "Maria" },
        idempotenciaDaPassagem: "m1",
        avisoAoLead: { avisado: true },
        log: log as never,
      } as never,
    );
    const insert = clienteConsultas.find((c) => /insert into passagens_de_atendimento/.test(c.sql));
    expect(insert, "a passagem não foi gravada").toBeTruthy();
    // Posições 12/13 na ordem de COLUNAS_DA_PASSAGEM: cliente_avisado/aviso_motivo_codigo.
    expect(insert!.params[12]).toBe(true);
  });

  it("⭐ o log final usa o vocabulário da LINHA (verificacao_manual/runtime_nativo), não 'nao_declarado'", async () => {
    log.info.mockClear();
    const pool = poolComConexao(null);
    await performHumanHandoff(
      pool as never,
      { tenantId: "org1", leadId: "cont1", conversationId: "conv1" },
      {
        reason: "verificacao_manual",
        conversationSummary: "resumo",
        camposColetados: { nome: "Maria" },
        log: log as never,
      } as never,
    );
    const final = log.info.mock.calls.find(([msg]) => /handoff humano aplicado/.test(String(msg)));
    expect(final, "o log final não saiu").toBeTruthy();
    expect(final![1]).toMatchObject({ motivo_codigo: "verificacao_manual", origem: "runtime_nativo" });
  });
});
