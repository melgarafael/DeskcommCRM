import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3804, item 3 — o handoff do motor da IA entrega a conversa a quem é o dono.
 *
 * Este teste bate na PORTA DE ENTRADA de verdade (`performHumanHandoff`), com um
 * pool dublê que responde como o banco responderia. É ele que separa "a regra
 * está escrita" de "a passagem usa a regra": o dublê só registra o que o código
 * pediu, então uma chamada a `fn_conversation_assign` que não existe é uma
 * conversa que continua sem dono em produção.
 *
 * Os quatro lados opostos moram aqui, um por `describe`:
 *   • organização sem a configuração  → nada muda;
 *   • ninguém qualificado             → o fallback decide (e o aviso da Central
 *                                       continua nascendo: ninguém fica no silêncio);
 *   • candidato recusado              → o próximo elo da cadeia recebe;
 *   • passagem feita por uma PESSOA   → o dono da conversa não muda.
 */

vi.mock("@/lib/atendimento/fronteira-server", () => ({ guardServiceEffect: vi.fn(async () => {}) }));
vi.mock("@/lib/leads/agent-activity", () => ({
  emitAgentActivityForContact: vi.fn(async () => ({ routed: true })),
}));
vi.mock("@/lib/agent-engine/cron/scheduler", () => ({ cancelPendingCronsForLead: vi.fn(async () => {}) }));

import { performHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";

const ORG = "99999999-9999-4999-8999-999999999999";
const CONTATO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONVERSA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESPONSAVEL = "11111111-1111-4111-8111-111111111111";
const CARTEIRA = "22222222-2222-4222-8222-222222222222";
const FALLBACK = "33333333-3333-4333-8333-333333333333";

interface Estado {
  settings?: unknown;
  /** Linha de `conversations` (dono atual). */
  conversa?: { assigned_to_user_id: string | null; assignee_kind: string | null; contact_id: string | null };
  negocio?: { owner_user_id: string | null; owner_kind: string | null } | null;
  contato?: { carteira_user_id: string | null } | null;
  /** Papel de cada pessoa; `null` = fora da equipe. */
  papeis?: Record<string, string | null>;
  erroAoLerVinculo?: string;
  erroAoAtribuir?: string;
}

type Chamada = { sql: string; params: unknown[] };

function banco(estado: Estado = {}) {
  const chamadas: Chamada[] = [];
  const papeis = estado.papeis ?? {
    [RESPONSAVEL]: "agent",
    [CARTEIRA]: "agent",
    [FALLBACK]: "agent",
  };
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      chamadas.push({ sql, params });
      if (/select settings from organizations/i.test(sql)) {
        return { rows: estado.settings === undefined ? [] : [{ settings: estado.settings }], rowCount: 1 };
      }
      if (/from conversations/i.test(sql) && /assigned_to_user_id, assignee_kind, contact_id/i.test(sql)) {
        const linha =
          estado.conversa === undefined
            ? { assigned_to_user_id: null, assignee_kind: "agent", contact_id: CONTATO }
            : estado.conversa;
        return { rows: linha === null ? [] : [linha], rowCount: linha === null ? 0 : 1 };
      }
      if (/from crm_leads/i.test(sql)) {
        const linha =
          estado.negocio === undefined
            ? { owner_user_id: RESPONSAVEL, owner_kind: "user" }
            : estado.negocio;
        return { rows: linha === null ? [] : [linha], rowCount: linha === null ? 0 : 1 };
      }
      if (/from contacts/i.test(sql)) {
        const linha =
          estado.contato === undefined ? { carteira_user_id: CARTEIRA } : estado.contato;
        return { rows: linha === null ? [] : [linha], rowCount: linha === null ? 0 : 1 };
      }
      if (/from user_organizations/i.test(sql)) {
        if (estado.erroAoLerVinculo) throw new Error(estado.erroAoLerVinculo);
        const papel = papeis[String(params[1])];
        return { rows: papel === undefined || papel === null ? [] : [{ role: papel }], rowCount: 1 };
      }
      if (/fn_conversation_assign/i.test(sql)) {
        if (estado.erroAoAtribuir) throw new Error(estado.erroAoAtribuir);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return { db, chamadas };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };

beforeEach(() => {
  log.info.mockClear();
  log.warn.mockClear();
});

function passar(
  db: ReturnType<typeof banco>["db"],
  origem: "pedido_explicito" | "caso_escalado" | "ferramenta_do_modelo" = "pedido_explicito",
) {
  return performHumanHandoff(
    db as never,
    { tenantId: ORG, leadId: CONTATO, conversationId: CONVERSA },
    {
      reason: "requested_human",
      conversationSummary: "resumo",
      passagem: {
        origem,
        motivoCodigo: "requested_human",
        briefing: { body: "resumo", title: null, notes: null, content: null, tentativas: [] },
      },
      log: log as never,
    } as never,
  );
}

function atribuicoes(chamadas: Chamada[]): unknown[][] {
  return chamadas.filter((c) => /fn_conversation_assign/i.test(c.sql)).map((c) => c.params);
}

function enfileiramentos(chamadas: Chamada[]): number {
  return chamadas.filter((c) => /fn_request_channel_routing/i.test(c.sql)).length;
}

function aberturaDaCentral(chamadas: Chamada[]): boolean {
  return chamadas.some((c) => /insert into agent_inbox_items/i.test(c.sql));
}

const CONFIG_NEGOCIO_E_CARTEIRA = {
  modo: "destino",
  destinos: ["responsavel_do_negocio", "dono_da_carteira"],
  fallback: { modo: "fixo", user_id: FALLBACK },
};

const settingsCom = (config: unknown) => ({
  atendimento: { destino_do_handoff: config },
});

describe("handoff da IA — organização SEM a configuração (o comportamento de hoje)", () => {
  it("não lê negócio, contato nem vínculo, e NÃO atribui a ninguém", async () => {
    const { db, chamadas } = banco({ settings: { crm: { cliente_pela_venda: true } } });
    await passar(db);

    expect(atribuicoes(chamadas)).toEqual([]);
    expect(enfileiramentos(chamadas)).toBe(0);
    // Nada de leitura das tabelas que só existem no caminho novo: o handoff de
    // hoje toca exatamente as mesmas linhas de antes.
    const leuNegocioOuContato = chamadas.some(
      (c) => /from crm_leads/i.test(c.sql) || /from contacts/i.test(c.sql) || /from user_organizations/i.test(c.sql),
    );
    expect(leuNegocioOuContato).toBe(false);
    // A passagem em si continua acontecendo (force_human, silêncio, Central).
    expect(aberturaDaCentral(chamadas)).toBe(true);
  });

  it("modo `fixo` gravado na chave é 'não configurado': a conversa segue a fila", async () => {
    const { db, chamadas } = banco({
      settings: settingsCom({ modo: "fixo", user_id: FALLBACK }),
    });
    await passar(db);

    expect(atribuicoes(chamadas)).toEqual([]);
    expect(enfileiramentos(chamadas)).toBe(0);
  });
});

describe("handoff da IA — a conversa vai para o dono configurado (GREEN)", () => {
  it("responsável do negócio recebe pela porta única da atribuição (reason 'handoff')", async () => {
    const { db, chamadas } = banco({ settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA) });
    await passar(db, "ferramenta_do_modelo");

    expect(atribuicoes(chamadas)).toEqual([[ORG, CONVERSA, RESPONSAVEL]]);
    expect(enfileiramentos(chamadas)).toBe(0);
    // A trilha é a de sempre: a função grava o evento na mesma transação.
    expect(chamadas.filter((c) => /fn_conversation_assign/i.test(c.sql))[0]?.sql).toContain("'handoff'");
  });

  it("sem responsável no negócio, o dono da carteira recebe", async () => {
    const { db, chamadas } = banco({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      negocio: null,
    });
    await passar(db);

    expect(atribuicoes(chamadas)).toEqual([[ORG, CONVERSA, CARTEIRA]]);
  });
});

describe("handoff da IA — candidato recusado cai no próximo elo", () => {
  it("responsável `viewer` é recusado e a carteira recebe", async () => {
    const { db, chamadas } = banco({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      papeis: { [RESPONSAVEL]: "viewer", [CARTEIRA]: "agent", [FALLBACK]: "agent" },
    });
    await passar(db);

    expect(atribuicoes(chamadas)).toEqual([[ORG, CONVERSA, CARTEIRA]]);
  });

  it("responsável que saiu da equipe é recusado e a carteira recebe", async () => {
    const { db, chamadas } = banco({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      papeis: { [RESPONSAVEL]: null, [CARTEIRA]: "manager", [FALLBACK]: "agent" },
    });
    await passar(db);

    expect(atribuicoes(chamadas)).toEqual([[ORG, CONVERSA, CARTEIRA]]);
  });

  it("vínculo indeterminado não atribui no escuro", async () => {
    const { db, chamadas } = banco({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      erroAoLerVinculo: "timeout",
    });
    await passar(db);

    expect(atribuicoes(chamadas)).toEqual([]);
  });
});

describe("handoff da IA — ninguém qualificado, o fallback decide", () => {
  it("fallback pessoa fixa recebe quando nem negócio nem carteira servem", async () => {
    const { db, chamadas } = banco({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      negocio: null,
      contato: { carteira_user_id: null },
    });
    await passar(db);

    expect(atribuicoes(chamadas)).toEqual([[ORG, CONVERSA, FALLBACK]]);
  });

  it("fallback rodízio põe a conversa na distribuição do canal", async () => {
    const { db, chamadas } = banco({
      settings: settingsCom({
        modo: "destino",
        destinos: ["dono_da_carteira"],
        fallback: { modo: "rodizio" },
      }),
      contato: { carteira_user_id: null },
    });
    await passar(db);

    expect(atribuicoes(chamadas)).toEqual([]);
    expect(enfileiramentos(chamadas)).toBe(1);
  });

  it("nem o fallback serve: a passagem acontece e a Central recebe o aviso — nada de silêncio", async () => {
    const { db, chamadas } = banco({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      negocio: null,
      contato: { carteira_user_id: null },
      papeis: { [RESPONSAVEL]: "agent", [CARTEIRA]: "agent", [FALLBACK]: "viewer" },
    });
    await passar(db);

    expect(atribuicoes(chamadas)).toEqual([]);
    expect(enfileiramentos(chamadas)).toBe(0);
    // A conversa fica na fila humana com o aviso aberto — o mesmo desfecho de hoje.
    expect(aberturaDaCentral(chamadas)).toBe(true);
  });
});

describe("handoff feito por uma PESSOA (operator turn) não muda de dono", () => {
  it("origem `caso_escalado` (o 'Assumir eu') não entrega nem lê a configuração", async () => {
    const { db, chamadas } = banco({ settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA) });
    await passar(db, "caso_escalado");

    expect(atribuicoes(chamadas)).toEqual([]);
    const leuSettings = chamadas.some((c) => /select settings from organizations/i.test(c.sql));
    expect(leuSettings).toBe(false);
  });

  it("conversa que já é de uma pessoa não é reatribuída pela configuração", async () => {
    const { db, chamadas } = banco({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      conversa: { assigned_to_user_id: CARTEIRA, assignee_kind: "user", contact_id: CONTATO },
    });
    await passar(db, "ferramenta_do_modelo");

    expect(atribuicoes(chamadas)).toEqual([]);
  });
});
