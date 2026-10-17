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
