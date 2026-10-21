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

/**
 * O RECIBO: o que `conversations.metadata.passagem_verificacao_manual.msg`
 * devolveria. O dublê finge exatamente as duas statements do recibo (leitura e
 * gravação); todo o resto cai no default vazio — o INSERT real é o que interessa.
 */
let recibo: string | null = null;

async function executar(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> {
  consultas.push({ sql, params });
  if (/->>'msg' as msg/.test(sql)) {
    return { rows: [{ msg: recibo }], rowCount: recibo === null ? 0 : 1 };
  }
  if (/jsonb_build_object\(\$3,\s*jsonb_build_object\('msg'/.test(sql)) {
    recibo = String(params[3]); // $4 = a chave da tentativa
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

const liberacoes = vi.fn();

/** Pool dublê: grava as consultas e devolve vazio — o suficiente para o caminho. */
const db = {
  query: vi.fn(executar),
  connect: vi.fn(async () => ({ query: executar, release: liberacoes })),
};

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };

beforeEach(() => {
  consultas.length = 0;
  recibo = null;
  db.query.mockClear();
  db.connect.mockClear();
  liberacoes.mockClear();
  log.info.mockClear();
  log.warn.mockClear();
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
 * A metade "idempotente" do #2885 — a nota 3 do mantenedor no PR #3052.
 *
 * O fluxo de consulta pode re-executar um turno interrompido, e o handoff
 * insere uma linha a cada chamada. O guard é o RECIBO na MESMA transação do
 * INSERT, debaixo de advisory lock: um lookup solto antes do insert NÃO
 * bastaria — sem o lock, duas chamadas simultâneas liam "sem recibo" ao mesmo
 * tempo e gravavam duas linhas. Daí o teste de ordem: begin → lock → lookup →
 * insert → recibo → commit.
 */
describe("idempotência da passagem: recibo por tentativa", () => {
  it("retry da MESMA tentativa não duplica a linha — e o resto do handoff segue", async () => {
    await passar({ camposColetados: { nome: "Maria" }, idempotenciaDaPassagem: "msg-1" });
    await passar({ camposColetados: { nome: "Maria" }, idempotenciaDaPassagem: "msg-1" });

    const inserts = consultas.filter((c) => /insert into passagens_de_atendimento/.test(c.sql));
    expect(inserts, "o retry duplicou a linha da passagem").toHaveLength(1);

    // Os efeitos NÃO somem no retry: o aviso da Central sai nas duas chamadas
    // (o dedup é do banco, por `where not exists`, como sempre).
    const avisos = consultas.filter((c) => /insert into agent_inbox_items/.test(c.sql));
    expect(avisos).toHaveLength(2);

    // O log final continua dizendo o vocabulário da LINHA que existe…
    const info = log.info.mock.calls.filter((c) => String(c[0]).startsWith("handoff humano aplicado"));
    expect(info[info.length - 1]?.[1]).toMatchObject({
      motivo_codigo: "verificacao_manual",
      origem: "runtime_nativo",
    });
    // …e o pulo é dito, não silencioso.
    expect(log.info.mock.calls.some((c) => String(c[0]).includes("não duplica"))).toBe(true);
  });

  it("tentativa NOVA (outra mensagem) é fato novo e grava a linha nova", async () => {
    await passar({ camposColetados: { nome: "Maria" }, idempotenciaDaPassagem: "msg-1" });
    await passar({ camposColetados: { nome: "Maria" }, idempotenciaDaPassagem: "msg-2" });
    const inserts = consultas.filter((c) => /insert into passagens_de_atendimento/.test(c.sql));
    expect(inserts).toHaveLength(2);
  });

  it("insert e recibo numa transação só, com advisory lock ANTES do lookup (concorrência)", async () => {
    await passar({ camposColetados: { nome: "Maria" }, idempotenciaDaPassagem: "msg-1" });
    const idx = (re: RegExp): number => consultas.findIndex((c) => re.test(c.sql));
    const iBegin = idx(/^begin$/);
    const iLock = idx(/pg_advisory_xact_lock/);
    const iLeitura = idx(/->>'msg' as msg/);
    const iInsert = idx(/insert into passagens_de_atendimento/);
    const iRecibo = idx(/jsonb_build_object\(\$3,\s*jsonb_build_object\('msg'/);
    const iCommit = idx(/^commit$/);
    // O lock vem ANTES de qualquer leitura: é ele que faz o lookup PROVAR
    // alguma coisa sob concorrência real.
    expect(iBegin).toBeGreaterThanOrEqual(0);
    expect(iLock).toBeGreaterThan(iBegin);
    expect(iLeitura).toBeGreaterThan(iLock);
    expect(iInsert).toBeGreaterThan(iLeitura);
    expect(iRecibo).toBeGreaterThan(iInsert);
    expect(iCommit).toBeGreaterThan(iRecibo);
    expect(liberacoes).toHaveBeenCalledTimes(1);
    // E o recibo fica gravado: a segunda chamada lê msg-1 e pula.
    expect(recibo).toBe("msg-1");
  });

  it("sem chave: comportamento de sempre — duas chamadas, duas linhas, sem recibo", async () => {
    await passar({ camposColetados: { nome: "Maria" } });
    await passar({ camposColetados: { nome: "Maria" } });
    const inserts = consultas.filter((c) => /insert into passagens_de_atendimento/.test(c.sql));
    expect(inserts).toHaveLength(2);
    expect(consultas.some((c) => /pg_advisory_xact_lock/.test(c.sql))).toBe(false);
    expect(consultas.some((c) => /jsonb_build_object\(\$3,\s*jsonb_build_object\('msg'/.test(c.sql))).toBe(false);
    expect(recibo).toBeNull();
  });
});

/**
 * As notas 1 e 2 do mantenedor no PR #3052.
 *
 * (1) O log final diz o vocabulário da LINHA que este chamador gravou — não o
 *     do "caminho antigo" enquanto a linha diz outra coisa; o vocabulário
 *     legado permanece nos caminhos em que ele ainda é verdade.
 * (2) `avisoAoLead` do chamador vira LINHA na passagem do (c3), como na
 *     passagem declarada — gravar o desfecho não é notificar ninguém.
 */
describe("notas do mantenedor: log coerente e avisoAoLead registrado", () => {
  it("o log final diz verificacao_manual/runtime_nativo — o vocabulário da linha gravada", async () => {
    await passar({ camposColetados: { nome: "Maria" } });
    const info = log.info.mock.calls.filter((c) => String(c[0]).startsWith("handoff humano aplicado"));
    expect(info).toHaveLength(1);
    expect(info[0]?.[1]).toMatchObject({ motivo_codigo: "verificacao_manual", origem: "runtime_nativo" });
  });

  it("passagem declarada: o log registra o motivo declarado (o caminho antigo, intacto)", async () => {
    await passar({
      passagem: {
        origem: "ferramenta_do_modelo",
        motivoCodigo: "requested_human",
        briefing: { body: "b", title: null, notes: null, content: null, tentativas: [] },
      },
    });
    const info = log.info.mock.calls.filter((c) => String(c[0]).startsWith("handoff humano aplicado"));
    expect(info[0]?.[1]).toMatchObject({
      motivo_codigo: "requested_human",
      origem: "ferramenta_do_modelo",
    });
  });

  it("sem passagem declarada nem campos: o vocabulário legado (nao_declarado) permanece", async () => {
    await passar({});
    const info = log.info.mock.calls.filter((c) => String(c[0]).startsWith("handoff humano aplicado"));
    expect(info[0]?.[1]).toMatchObject({ motivo_codigo: "nao_declarado", origem: "nao_declarada" });
  });

  it("avisoAoLead do chamador vira LINHA no (c3), como no declarado — sem novo aviso a ninguém", async () => {
    await passar({
      camposColetados: { nome: "Maria" },
      avisoAoLead: { avisado: false, porque: "sem_telefone", motivoCodigo: "sem_telefone" },
    });
    const linha = linhaDaPassagem();
    expect(linha.cliente_avisado).toBe(false);
    expect(linha.aviso_motivo_codigo).toBe("sem_telefone");
    // Gravar o desfecho na linha não é NOTIFICAR: o aviso da Central é o
    // mesmo statement de sempre, uma vez só.
    const avisos = consultas.filter((c) => /insert into agent_inbox_items/.test(c.sql));
    expect(avisos).toHaveLength(1);
  });
});

/**
 * A entrega do fluxo de consulta de laudo (o gate `laudos` antes do modelo).
 *
 * O closure em `inbound-turn.ts` passa o desfecho do envio da mensagem de
 * estado como `avisoAoLead`: `avisado: true` quando a mensagem SAIU pelo
 * canal. Aqui se prova o que esse fato vira na linha da passagem — e que ele
 * NÃO vira mensagem nenhuma: `performHumanHandoff` recebe pool, sem canal;
 * toda statement capturada é banco, e insert em `messages` (o corpo que o
 * paciente recebe) não existe neste caminho. O envio em si é UM por turno,
 * provado no teste de patologia de `report-readiness.test.ts`
 * (`envios).toEqual([VERIFICAR_EQUIPE])`).
 */
describe("a entrega do fluxo grava o desfecho do aviso e não manda mensagem", () => {
  it("mensagem de estado saiu: cliente_avisado true na linha, um aviso da Central, zero mensagens novas", async () => {
    await passar({
      camposColetados: { nome: "Maria", data: "12/10" },
      avisoAoLead: { avisado: true },
    });
    const linha = linhaDaPassagem();
    expect(linha.motivo_codigo).toBe("verificacao_manual");
    expect(linha.cliente_avisado).toBe(true);
    expect(linha.aviso_motivo_codigo).toBeFalsy();
    // O único aviso é o da Central (inbox do humano), uma vez só.
    const avisos = consultas.filter((c) => /insert into agent_inbox_items/.test(c.sql));
    expect(avisos).toHaveLength(1);
    // Nenhum statement escreve em messages — o caminho não manda mensagem.
    const mandouMensagem = consultas.filter((c) => /insert into messages/i.test(c.sql));
    expect(mandouMensagem).toHaveLength(0);
  });
});
