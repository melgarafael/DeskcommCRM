/**
 * TODA PASSAGEM VIRA UMA LINHA — E A SEGUNDA NÃO É DESCARTADA EM SILÊNCIO.
 *
 * ## Os dois defeitos que este arquivo guarda
 *
 * 1. **O registro.** Havia dois motores de passagem para humano e nenhum deles
 *    guardava o porquê, o que a IA já tinha tentado nem a fala do cliente. O
 *    motor A montava um resumo que morria no corpo do aviso da Central; o motor
 *    B abria o aviso SEM resumo nenhum. Quem assumia relia a conversa inteira, e
 *    o cliente repetia o que já tinha dito.
 * 2. **O descarte.** O aviso da Central deduplicava com `where not exists` puro.
 *    Medido: o sentimento dispara primeiro (sem contexto), o pedido explícito do
 *    cliente chega depois (com contexto) — e o segundo sumia. A informação mais
 *    rica era exatamente a que se perdia.
 *
 * ## Por que pool falso, e não banco
 *
 * Porque o que se mede aqui é **qual SQL sai e em que ordem**, e isso é caro
 * demais de provar num turno inteiro. O molde é o de
 * `tests/unit/handoff-por-orcamento.test.ts`, que já exercita a escolta do
 * orçamento assim. O que só o banco prova (RLS, cascata, o gatilho de
 * reconhecimento) tem arquivo próprio em `tests/invariants/`.
 *
 * ## O controle negativo declarado
 *
 * Remover o `registrarPassagem` do motor B derruba o caso "os dois motores
 * gravam" **e deixa o e2e verde**, porque a jornada em tela exercita o motor A.
 * É a prova de que este arquivo cobre um buraco que a tela não enxerga.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { performHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { montarBriefingDaPassagem } from "@/lib/escalacao/briefing-da-passagem";

// ── O motor do CRM. Ele fala supabase-js, então o dublê é outro — e é por isso
//    que os dois motores precisam estar no MESMO arquivo: o defeito que esta
//    entrega fecha é justamente eles terem divergido sem ninguém medir.
const inseridos: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
const atualizados: Array<{ tabela: string; valores: Record<string, unknown> }> = [];
const abertoNaCentral: { valor: { id: string; body: string } | null } = { valor: null };

vi.mock("@/lib/ai/handoff/aviso-ao-lead", () => ({
  avisarLeadDoCrm: vi.fn(async () => ({ avisado: true })),
}));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: vi.fn(async () => ({
    permite: true,
    motivo: "autorizado",
    bloqueioPorAllowlist: false,
  })),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const from = (tabela: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        update: (valores: Record<string, unknown>) => {
          atualizados.push({ tabela, valores });
          return chain;
        },
        insert: (linha: Record<string, unknown>) => {
          inseridos.push({ tabela, linha });
          return Promise.resolve({ data: null, error: null });
        },
        eq: () => chain,
        gt: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          if (tabela === "conversations") {
            return Promise.resolve({
              data: {
                id: CONVERSA,
                organization_id: ORG,
                contact_id: LEAD,
                last_handoff_at: null,
                last_handoff_reason: null,
                last_outbound_at: null,
              },
              error: null,
            });
          }
          if (tabela === "agent_inbox_items") {
            return Promise.resolve({ data: abertoNaCentral.valor, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (r: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(r),
      };
      return chain;
    };
    return {
      from,
      rpc: () => Promise.resolve({ error: null }),
      channel: () => ({ send: async () => undefined }),
      removeChannel: async () => undefined,
    };
  },
}));

// Importado DEPOIS dos `vi.mock` por clareza de leitura — o hoisting do vitest
// os aplica de qualquer jeito, mas quem lê de cima para baixo precisa ver a
// ordem que o módulo enxerga.
import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

function poolFalso() {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, chamadas };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const BRIEFING = montarBriefingDaPassagem({
  checkpoint: {
    commitments: ["enviar o orçamento"],
    objections: [],
    next_action: "ligar amanhã",
    rolling_summary: "O cliente quer remarcar a entrega.",
  },
  pendentesDoCliente: ["dá pra mudar pra sexta?"],
  motivo: { codigo: "requested_human" },
});

function passagemPadrao() {
  return { origem: "pedido_explicito", motivoCodigo: "requested_human", briefing: BRIEFING } as const;
}

/** Só o statement que insere a linha da passagem. */
function insertDaPassagem(chamadas: Array<{ sql: string; params: unknown[] }>) {
  return chamadas.find((c) => c.sql.includes("insert into passagens_de_atendimento"));
}

describe("o motor de conversa grava a passagem", () => {
  it("toda passagem com origem declarada vira UMA linha", async () => {
    const { pool, chamadas } = poolFalso();
    const log = logFalso();

    await performHumanHandoff(
      pool,
      { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA },
      {
        reason: "requested_human",
        conversationSummary: BRIEFING.body,
        passagem: passagemPadrao(),
        avisoAoLead: { avisado: true },
        log: log as never,
      },
    );

    const insert = insertDaPassagem(chamadas);
    expect(insert, "passagem sem linha é passagem que ninguém consegue reconstruir").toBeDefined();
    // As colunas viajam na ordem de `COLUNAS_DA_PASSAGEM`; o que importa aqui é
    // que os fatos chegaram, não a posição de cada um.
    expect(insert?.params).toContain(ORG);
    expect(insert?.params).toContain(CONVERSA);
    expect(insert?.params).toContain("pedido_explicito");
    expect(insert?.params).toContain("requested_human");
    expect(insert?.params).toContain("engine");
    expect(
      insert?.params.some((p) => typeof p === "string" && p.includes("quer remarcar")),
      "o contexto acumulado não chegou à linha — quem assume lê o quê?",
    ).toBe(true);
  });

  it("a fala LITERAL do cliente vai para a coluna dela, não só para o texto", async () => {
    const { pool, chamadas } = poolFalso();
    await performHumanHandoff(
      pool,
      { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA },
      {
        reason: "requested_human",
        conversationSummary: BRIEFING.body,
        passagem: passagemPadrao(),
        log: logFalso() as never,
      },
    );
    const insert = insertDaPassagem(chamadas);
    expect(insert?.params).toContain("dá pra mudar pra sexta?");
  });

  it("o insert acontece DEPOIS de a trava do contato ser armada", async () => {
    // Não é gosto de ordem: a linha da passagem é o REGISTRO de um efeito que já
    // aconteceu. Gravá-la antes de o efeito existir criaria fato para uma
    // passagem que pode nem acontecer (o update seguinte falha e o job retenta).
    const { pool, chamadas } = poolFalso();
    await performHumanHandoff(
      pool,
      { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA },
      {
        reason: "requested_human",
        conversationSummary: BRIEFING.body,
        passagem: passagemPadrao(),
        log: logFalso() as never,
      },
    );
    const iTrava = chamadas.findIndex((c) => c.sql.includes("set force_human = true"));
    const iPassagem = chamadas.findIndex((c) =>
      c.sql.includes("insert into passagens_de_atendimento"),
    );
    expect(iTrava).toBeGreaterThanOrEqual(0);
    expect(iPassagem).toBeGreaterThan(iTrava);
  });

  it("chamador sem `passagem` não grava linha — e ainda abre o aviso", async () => {
    // GUARDA DE VACUIDADE do caso acima: se a linha nascesse sempre, o primeiro
    // caso seria verde por construção e não mediria nada.
    const { pool, chamadas } = poolFalso();
    await performHumanHandoff(
      pool,
      { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA },
      { reason: "requested_human", conversationSummary: "resumo", log: logFalso() as never },
    );
    expect(insertDaPassagem(chamadas)).toBeUndefined();
    expect(
      chamadas.some((c) => c.sql.includes("agent_inbox_items")),
      "sem aviso, a passagem é invisível para o time",
    ).toBe(true);
  });
});

describe("o aviso da Central: adendo em vez de descarte", () => {
  it("o statement do aviso ATUALIZA o item aberto em vez de só desistir", async () => {
    const { pool, chamadas } = poolFalso();
    await performHumanHandoff(
      pool,
      { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA },
      {
        reason: "requested_human",
        conversationSummary: BRIEFING.body,
        passagem: passagemPadrao(),
        log: logFalso() as never,
      },
    );
    const aviso = chamadas.find((c) => c.sql.includes("agent_inbox_items"));
    expect(aviso).toBeDefined();
    const sql = (aviso?.sql ?? "").replace(/\s+/gu, " ");
    expect(
      sql,
      "sem o update, a segunda passagem da mesma conversa é descartada em silêncio",
    ).toContain("update agent_inbox_items");
    expect(sql).toContain("insert into agent_inbox_items");
  });

  it("a chave do aviso é a CONVERSA, não o contato", async () => {
    // Com `contact`, um cliente com duas conversas abertas rendia UM aviso só —
    // e o destino da Central era o contato, não o lugar onde se responde.
    const { pool, chamadas } = poolFalso();
    await performHumanHandoff(
      pool,
      { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA },
      {
        reason: "requested_human",
        conversationSummary: BRIEFING.body,
        passagem: passagemPadrao(),
        log: logFalso() as never,
      },
    );
    const aviso = chamadas.find((c) => c.sql.includes("agent_inbox_items"));
    const sql = (aviso?.sql ?? "").replace(/\s+/gu, " ");
    expect(sql).toContain("'conversation'");
    expect(sql).not.toContain("'contact'");
    expect(aviso?.params, "o aviso aponta para a conversa").toContain(CONVERSA);
  });

  it("o corpo do aviso é CURTO: motivo em português e nada da conversa", async () => {
    // A rota da Central lê os avisos com o client de serviço e entrega `body` a
    // qualquer `agent` — inclusive a quem a visibilidade de conversa não deixaria
    // abrir aquele atendimento. Enquanto o resumo morava ali, a Central era uma
    // porta lateral para o texto da conversa.
    const { pool, chamadas } = poolFalso();
    await performHumanHandoff(
      pool,
      { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA },
      {
        reason: "requested_human",
        conversationSummary: BRIEFING.body,
        passagem: passagemPadrao(),
        avisoAoLead: { avisado: true },
        log: logFalso() as never,
      },
    );
    const aviso = chamadas.find((c) => c.sql.includes("agent_inbox_items"));
    const corpo = String(aviso?.params?.[2] ?? "");
    expect(corpo).toContain("O cliente pediu para falar com uma pessoa");
    expect(corpo, "rótulo visível é contrato").toContain("JÁ FOI avisado");
    expect(corpo, "código de constraint não é texto para uma pessoa ler").not.toContain(
      "requested_human",
    );
    expect(corpo, "o conteúdo da conversa vazou para a Central").not.toContain("quer remarcar");
    expect(corpo).toContain("Abra a conversa para ver o contexto.");
  });

  it("aviso na fila NÃO afirma entrega — e tem frase própria", async () => {
    const { pool, chamadas } = poolFalso();
    await performHumanHandoff(
      pool,
      { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA },
      {
        reason: "requested_human",
        conversationSummary: BRIEFING.body,
        passagem: passagemPadrao(),
        avisoAoLead: {
          avisado: false,
          porque: "na_fila_canal_fora",
          motivoCodigo: "na_fila_canal_fora",
        },
        log: logFalso() as never,
      },
    );
    const aviso = chamadas.find((c) => c.sql.includes("agent_inbox_items"));
    const corpo = String(aviso?.params?.[2] ?? "");
    expect(corpo).not.toContain("JÁ FOI avisado");
    expect(corpo).toContain("ficou na fila");
  });
});

describe("o motor do CRM grava a passagem", () => {
  beforeEach(() => {
    inseridos.length = 0;
    atualizados.length = 0;
    abertoNaCentral.valor = null;
  });

  it("o segundo motor também vira linha — com `motor: crm` e a origem declarada", async () => {
    // ESTE é o caso que a sabotagem "remover registrarPassagem do motor B"
    // derruba, e que o e2e em tela NÃO derruba, porque a jornada de tela
    // exercita o motor de conversa. É o buraco que a tela não enxerga.
    const r = await triggerHandoff({
      conversationId: CONVERSA,
      organizationId: ORG,
      reason: "low_sentiment",
      origem: "sentimento",
    });

    expect(r.triggered).toBe(true);
    const linha = inseridos.find((i) => i.tabela === "passagens_de_atendimento");
    expect(linha, "o motor do CRM abria o aviso sem resumo nenhum — e continua abrindo").toBeDefined();
    expect(linha?.linha.motor).toBe("crm");
    expect(linha?.linha.origem).toBe("sentimento");
    expect(linha?.linha.motivo_codigo).toBe("low_sentiment");
    expect(linha?.linha.cliente_avisado).toBe(true);
  });

  it("o aviso deste motor também aponta para a CONVERSA", async () => {
    await triggerHandoff({
      conversationId: CONVERSA,
      organizationId: ORG,
      reason: "low_sentiment",
      origem: "sentimento",
    });
    const aviso = inseridos.find((i) => i.tabela === "agent_inbox_items");
    expect(aviso?.linha.ref_kind).toBe("conversation");
    expect(aviso?.linha.ref_id).toBe(CONVERSA);
    expect(String(aviso?.linha.body)).toContain("O cliente demonstrou irritação");
    expect(String(aviso?.linha.body), "código cru na tela de quem opera").not.toContain(
      "low_sentiment",
    );
  });

  it("D11: irritação percebida pelo Jev é dita à equipe — no resumo e no aviso", async () => {
    await triggerHandoff({
      conversationId: CONVERSA,
      organizationId: ORG,
      reason: "low_sentiment",
      origem: "sentimento",
      metadata: { sentiment_score: 0, sentiment_engine: "jev" },
    });
    const passagem = inseridos.find((i) => i.tabela === "passagens_de_atendimento");
    const aviso = inseridos.find((i) => i.tabela === "agent_inbox_items");
    expect(String(passagem?.linha.body)).toContain("O cliente demonstrou irritação na conversa (percebido pelo Jev)");
    expect(String(aviso?.linha.body)).toContain("O cliente demonstrou irritação na conversa (percebido pelo Jev)");
  });

  it("D11: sem o Jev na medição, nenhuma marca (controle)", async () => {
    await triggerHandoff({
      conversationId: CONVERSA,
      organizationId: ORG,
      reason: "low_sentiment",
      origem: "sentimento",
      metadata: { sentiment_score: 0, sentiment_engine: "llm" },
    });
    const aviso = inseridos.find((i) => i.tabela === "agent_inbox_items");
    expect(String(aviso?.linha.body)).toContain("O cliente demonstrou irritação");
    expect(String(aviso?.linha.body)).not.toContain("Jev");
  });

  it("com aviso JÁ aberto, a segunda passagem vira ADENDO — não é descartada", async () => {
    abertoNaCentral.valor = { id: "aviso-1", body: "O cliente demonstrou irritação na conversa" };
    await triggerHandoff({
      conversationId: CONVERSA,
      organizationId: ORG,
      reason: "requested_human",
      origem: "legado_pedido",
    });
    expect(
      inseridos.filter((i) => i.tabela === "agent_inbox_items"),
      "dois avisos abertos para a mesma conversa",
    ).toHaveLength(0);
    const adendo = atualizados.find((u) => u.tabela === "agent_inbox_items");
    expect(adendo, "a informação MAIS RICA era justamente a que se perdia").toBeDefined();
    expect(String(adendo?.valores.body)).toContain("O cliente demonstrou irritação na conversa");
    expect(String(adendo?.valores.body)).toContain("O cliente pediu para falar com uma pessoa");
    // E a linha da passagem nasce assim mesmo: o aviso deduplica, o FATO não.
    expect(inseridos.filter((i) => i.tabela === "passagens_de_atendimento")).toHaveLength(1);
  });
});
