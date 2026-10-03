/**
 * As seis capacidades de escalação, contra os handlers REAIS.
 *
 * Cobre o que o pacote prometia e não entregava: ver quem pode assumir, listar e
 * ler chamados, registrar, encerrar e devolver o atendimento — mais as recusas
 * (chamado fechado, conversa de outra organização).
 *
 * As transições de chamado rodam sobre `pg`: aqui o pool é um dublê que devolve
 * `rowCount`, o que prende o CONTRATO (0 linhas = recusa, nunca sucesso falso).
 * Que o `where` do statement realmente proteja o estado é coisa de Postgres de
 * verdade — está em `tests/invariants/escalacao-ciclo-humano.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import {
  crmAddCaseNote,
  crmCloseHumanCase,
  crmGetHumanCase,
  crmListAvailableAttendants,
  crmListHumanCases,
  crmResumeAiAttendance,
} from "@/lib/mcp/tools/escalacao";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const consultasNoPool: Array<{ sql: string; params: unknown[] }> = [];
let linhasAfetadas = 1;
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({
    query: (sql: string, params: unknown[]) => {
      consultasNoPool.push({ sql, params });
      return Promise.resolve({ rows: [], rowCount: linhasAfetadas });
    },
  }),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const CONV = "44444444-4444-4444-8444-444444444444";
const CHAMADO = "33333333-3333-4333-8333-333333333333";
const ANA = "11111111-1111-4111-8111-111111111111";
const BRUNO = "99999999-9999-4999-8999-999999999999";

/** Nomes vêm do `user_metadata.full_name` — é o único dado de usuário exposto (LGPD). */
const NOMES_DE_USUARIO: Record<string, string> = {
  [ANA]: "Ana Souza",
  [BRUNO]: "Bruno Lima",
};

interface Consulta {
  tabela: string;
  terminal: "maybeSingle" | "then";
}
type Resolver = (q: Consulta) => { data?: unknown; count?: number; error?: unknown };

function fazerSupabase(resolve: Resolver) {
  const from = (tabela: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      update: () => chain,
      insert: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve(resolve({ tabela, terminal: "maybeSingle" })),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ tabela, terminal: "then" })).then(res),
    };
    return chain;
  };
  return {
    from,
    rpc: () => Promise.resolve({ data: [{ id: CONV }], error: null }),
    // O lookup de NOME (issue #1539) fala com o endpoint admin do GoTrue. O
    // dublê responde com o full_name de `NOMES_DE_USUARIO` — é isso que faz o
    // `nome` da linha ser aferível, e não um null silencioso do catch.
    auth: {
      admin: {
        getUserById: (id: string) =>
          Promise.resolve({
            data: { user: { id, user_metadata: { full_name: NOMES_DE_USUARIO[id] ?? null } } },
            error: null,
          }),
      },
    },
  };
}

/**
 * Ctx de uma PESSOA operando (token de usuário), não do agente atendendo.
 * `crm_resume_ai_attendance` recusa ator de IA por regra dura, então o caminho
 * feliz dela precisa deste ator — e o teste do bloqueio usa o ctx padrão.
 */
function ctxDePessoa(resolve: Resolver): McpContext {
  return {
    ...fazerCtx(resolve, "manager"),
    actor: { type: "user", id: ANA, role: "manager" },
  } as McpContext;
}

function fazerCtx(resolve: Resolver, role: McpContext["role"] = "agent"): McpContext {
  return {
    organizationId: ORG,
    role,
    actor: { type: "ai_agent", id: "run_1", role: "agent", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: fazerSupabase(resolve) as any,
  } as McpContext;
}

// ---------------------------------------------------------------------------
// registro: declaração ↔ handler
// ---------------------------------------------------------------------------

describe("as seis capacidades chegam de fato ao agregador", () => {
  const AS_SEIS = [
    crmListAvailableAttendants,
    crmListHumanCases,
    crmGetHumanCase,
    crmAddCaseNote,
    crmCloseHumanCase,
    crmResumeAiAttendance,
  ];

  it("cada handler tem a declaração correspondente no catálogo", async () => {
    // `lib/mcp/tools/index.ts` tem a guarda 1:1, mas ela só roda ao IMPORTAR o
    // agregador fora de produção — e nenhum teste do repo o importava, então a
    // guarda nunca disparava. Handler sem declaração some da tela do humano;
    // declaração sem handler vira tool anunciada que estoura ao ser chamada.
    const { allTools } = await import("@/lib/mcp/tools");
    const nomesDeHandler = new Set(allTools.map((t) => t.name));
    const nomesDeCatalogo = new Set(TOOL_CATALOG.map((t) => t.name));

    for (const tool of AS_SEIS) {
      expect(nomesDeHandler.has(tool.name), `${tool.name} fora do agregador de handlers`).toBe(true);
      expect(nomesDeCatalogo.has(tool.name), `${tool.name} fora do catálogo`).toBe(true);
    }
  });

  it("todas entram no pacote de passar para uma pessoa", () => {
    for (const tool of AS_SEIS) {
      const entrada = TOOL_CATALOG.find((t) => t.name === tool.name);
      expect(entrada?.pacotes, `${tool.name} sem o pacote escalar`).toContain("escalar");
    }
  });

  it("só a de devolver o atendimento é crítica — as outras não pedem cerimônia à toa", () => {
    // `critico` NUNCA entra ligada por pacote (entraPorPacote): marcar demais
    // esvazia o pacote que o dono do negócio liga, marcar de menos liga sozinha
    // uma capacidade que não volta atrás.
    const criticas = AS_SEIS.map((t) => TOOL_CATALOG.find((c) => c.name === t.name))
      .filter((c) => c?.risco === "critico")
      .map((c) => c!.name)
      .sort();
    expect(criticas).toEqual(["crm_close_human_case", "crm_resume_ai_attendance"]);
  });
});

// ---------------------------------------------------------------------------
// crm_list_available_attendants
// ---------------------------------------------------------------------------

describe("crm_list_available_attendants", () => {
  /** Ana livre (2 de 5), Bruno lotado (5 de 5), Carla sem disponibilidade configurada. */
  const equipe: Resolver = (q) => {
    if (q.tabela === "user_organizations") {
      return {
        data: [
          { user_id: ANA, role: "agent" },
          { user_id: BRUNO, role: "agent" },
          { user_id: "viewer-1", role: "viewer" },
        ],
      };
    }
    if (q.tabela === "attendant_availability") {
      return {
        data: [
          { user_id: ANA, is_available: true, capacity: 5, schedule: {}, last_heartbeat_at: null, updated_at: null },
          { user_id: BRUNO, is_available: true, capacity: 5, schedule: {}, last_heartbeat_at: null, updated_at: null },
        ],
      };
    }
    if (q.tabela === "conversations") {
      return {
        data: [
          { assigned_to_user_id: ANA },
          { assigned_to_user_id: ANA },
          ...Array.from({ length: 5 }, () => ({ assigned_to_user_id: BRUNO })),
        ],
      };
    }
    return { data: [] };
  };

  it("só quem pode assumir agora: quem está sem folga fica de fora", async () => {
    const res = (await crmListAvailableAttendants.handler(
      { only_available: true },
      fazerCtx(equipe),
    )) as { attendants: Array<{ user_id: string; current_load: number }>; available_count: number };

    expect(res.attendants.map((a) => a.user_id)).toEqual([ANA]);
    expect(res.attendants[0]?.current_load).toBe(2);
    expect(res.available_count).toBe(1);
  });

  it("viewer não é atendente — não entra no roster", async () => {
    const res = (await crmListAvailableAttendants.handler(
      { only_available: false },
      fazerCtx(equipe),
    )) as { attendants: Array<{ user_id: string }>; total_count: number };
    expect(res.attendants.map((a) => a.user_id).sort()).toEqual([ANA, BRUNO].sort());
    expect(res.total_count).toBe(2);
  });

  it("não devolve e-mail nem telefone de atendente", async () => {
    const res = (await crmListAvailableAttendants.handler(
      { only_available: false },
      fazerCtx(equipe),
    )) as { attendants: Array<Record<string, unknown>> };
    for (const a of res.attendants) {
      expect(Object.keys(a)).not.toContain("email");
      expect(Object.keys(a)).not.toContain("phone");
    }
  });

  it("cada linha traz `nome` — a regra de roteamento se escreve por gente, não por UUID (#1539)", async () => {
    const res = (await crmListAvailableAttendants.handler(
      { only_available: false },
      fazerCtx(equipe),
    )) as { attendants: Array<{ user_id: string; nome: string | null }> };

    const porId = new Map(res.attendants.map((a) => [a.user_id, a.nome]));
    expect(porId.get(ANA)).toBe("Ana Souza");
    expect(porId.get(BRUNO)).toBe("Bruno Lima");
    // O nome vem SÓ de full_name: nenhum campo de e-mail viaja junto (LGPD).
    for (const a of res.attendants) {
      expect(Object.keys(a)).not.toContain("email");
    }
  });

  it("ninguém disponível: a resposta DIZ isso, em vez de devolver lista vazia muda", async () => {
    // Escalar para uma fila que ninguém vai puxar é pior que não escalar — o
    // cliente já foi avisado de que uma pessoa assumiria.
    const semNinguem: Resolver = (q) =>
      q.tabela === "user_organizations" ? { data: [{ user_id: ANA, role: "agent" }] } : { data: [] };
    const res = (await crmListAvailableAttendants.handler(
      { only_available: true },
      fazerCtx(semNinguem),
    )) as { available_count: number; next_action: string };
    expect(res.available_count).toBe(0);
    expect(res.next_action).toMatch(/Ninguém pode assumir agora/);
  });
});

// ---------------------------------------------------------------------------
// crm_list_human_cases / crm_get_human_case
// ---------------------------------------------------------------------------

/**
 * O mesmo dublê, registrando os `in` aplicados — é por eles que se vê se a
 * leitura do agente foi recortada por conversa (ela não pode ser).
 */
function supabaseQueRegistraIn(resolve: Resolver) {
  const ins: Array<[string, unknown]> = [];
  const from = (tabela: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: (coluna: string, valores: unknown) => {
        ins.push([coluna, valores]);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(resolve({ tabela, terminal: "maybeSingle" })),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ tabela, terminal: "then" })).then(res),
    };
    return chain;
  };
  return { ins, supabase: { from } };
}

/** O ctx padrão com um supabase escolhido a dedo. */
function comSupabase(supabase: unknown): McpContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...fazerCtx(() => ({ data: [] })), supabase: supabase as any } as McpContext;
}

const CHAMADO_ABERTO = {
  id: CHAMADO,
  title: "Desconto acima da alçada",
  summary: "Cliente quer 20%",
  blocker: "Alçada",
  status: "awaiting_human",
  opened_at: "2026-08-04T11:00:00Z",
  source: "agent",
  closed_at: null,
  conversation_id: CONV,
  conversations: { contacts: { name: "Fulano", phone_number: "+5531999" } },
};

describe("crm_list_human_cases", () => {
  it("achata o contato e devolve o total de abertos", async () => {
    const res = (await crmListHumanCases.handler(
      { state: "abertos", limit: 20 },
      fazerCtx((q) => (q.tabela === "agent_cases" ? { data: [CHAMADO_ABERTO], count: 3 } : { data: [] })),
    )) as { cases: Array<{ contact_name: string | null; status: string }>; open_count: number };

    expect(res.cases).toHaveLength(1);
    expect(res.cases[0]?.contact_name).toBe("Fulano");
    expect(res.cases[0]?.status).toBe("awaiting_human");
    expect(res.open_count).toBe(3);
  });

  it("o agente NÃO perde alcance: a leitura não é recortada por conversa", async () => {
    // A tela passou a recortar a fila pelas conversas que a RLS mostra àquele
    // atendente. Aqui não pode: `ctx.supabase` é admin por contrato, o agente
    // abriu esses casos e acompanha a fila inteira. Se alguém trocar o `"todas"`
    // de `lib/mcp/tools/escalacao.ts` por um conjunto, o `in("conversation_id")`
    // aparece e este caso fica vermelho.
    const { ins, supabase } = supabaseQueRegistraIn((q) =>
      q.tabela === "agent_cases" ? { data: [CHAMADO_ABERTO], count: 3 } : { data: [] },
    );

    await crmListHumanCases.handler({ state: "abertos", limit: 20 }, comSupabase(supabase));

    // Calibração: a sonda VÊ `in` (o filtro de status sempre passa por ela), de
    // modo que a ausência do outro é medição e não cegueira.
    expect(ins.map(([coluna]) => coluna)).toContain("status");
    expect(ins.map(([coluna]) => coluna)).not.toContain("conversation_id");
  });
});

describe("crm_get_human_case", () => {
  const comTimeline: Resolver = (q) => {
    if (q.tabela === "agent_cases") {
      return q.terminal === "maybeSingle" ? { data: CHAMADO_ABERTO } : { data: [CHAMADO_ABERTO] };
    }
    if (q.tabela === "agent_case_events") {
      return {
        data: [
          {
            id: "ev-1",
            case_id: CHAMADO,
            kind: "human_replied",
            actor_kind: "human",
            actor_user_id: ANA,
            human_action: "resolved",
            body: "Aprovei 15% de desconto.",
            created_at: "2026-08-04T12:00:00Z",
          },
        ],
      };
    }
    return { data: [] };
  };

  it("devolve a timeline E o resumo de continuidade — não só o registro cru", async () => {
    const res = (await crmGetHumanCase.handler({ case_id: CHAMADO }, fazerCtx(comTimeline))) as {
      events: unknown[];
      human_continuity: { had_human_attendance: boolean; summary: string };
    };
    expect(res.events).toHaveLength(1);
    expect(res.human_continuity.had_human_attendance).toBe(true);
    // O texto QUE A PESSOA ESCREVEU, não o rótulo da ação: é o que faz o agente
    // retomar sem contradizer o que já foi combinado.
    expect(res.human_continuity.summary).toContain("Aprovei 15% de desconto.");
  });

  it("chamado de outra organização não é encontrado", async () => {
    await expect(
      crmGetHumanCase.handler({ case_id: CHAMADO }, fazerCtx(() => ({ data: null }))),
    ).rejects.toThrow(/case_not_found/);
  });
});

// ---------------------------------------------------------------------------
// crm_add_case_note / crm_close_human_case
// ---------------------------------------------------------------------------

describe("crm_add_case_note", () => {
  it("registra como agente — nunca se passa por pessoa", async () => {
    consultasNoPool.length = 0;
    linhasAfetadas = 1;
    const res = (await crmAddCaseNote.handler(
      { case_id: CHAMADO, note: "O cliente respondeu que aceita 12%." },
      fazerCtx(() => ({ data: null })),
    )) as { recorded: boolean };

    expect(res.recorded).toBe(true);
    const sql = consultasNoPool.at(-1)!.sql;
    expect(sql).toContain("'agent_noted'");
    expect(sql).toContain("'agent'");
    expect(sql).not.toContain("human_replied");
    expect(consultasNoPool.at(-1)!.params).toContain("O cliente respondeu que aceita 12%.");
  });

  it("chamado já fechado recusa em vez de fingir que registrou", async () => {
    linhasAfetadas = 0;
    await expect(
      crmAddCaseNote.handler(
        { case_id: CHAMADO, note: "tarde demais" },
        fazerCtx(() => ({ data: null })),
      ),
    ).rejects.toThrow(/case_not_open/);
    linhasAfetadas = 1;
  });

  it("nota vazia é recusada pelo schema", () => {
    expect(crmAddCaseNote.inputSchema.note.safeParse("   ").success).toBe(false);
  });
});

describe("crm_close_human_case", () => {
  it("desfecho vira o estado certo e o evento leva o texto", async () => {
    consultasNoPool.length = 0;
    linhasAfetadas = 1;
    const res = (await crmCloseHumanCase.handler(
      { case_id: CHAMADO, outcome: "resolvido", note: "Desconto aprovado e comunicado." },
      fazerCtx(() => ({ data: null })),
    )) as { status: string; outcome: string };

    expect(res).toMatchObject({ status: "resolved", outcome: "resolvido" });
    expect(consultasNoPool.at(-1)!.params).toContain("resolved");
    expect(consultasNoPool.at(-1)!.params).toContain("Desconto aprovado e comunicado.");
  });

  it("'sem_necessidade' fecha como cancelado, não como resolvido", async () => {
    consultasNoPool.length = 0;
    linhasAfetadas = 1;
    const res = (await crmCloseHumanCase.handler(
      { case_id: CHAMADO, outcome: "sem_necessidade", note: "O cliente desistiu." },
      fazerCtx(() => ({ data: null })),
    )) as { status: string };
    expect(res.status).toBe("cancelled");
    expect(consultasNoPool.at(-1)!.params).toContain("cancelled");
  });

  it("chamado já fechado recusa", async () => {
    linhasAfetadas = 0;
    await expect(
      crmCloseHumanCase.handler(
        { case_id: CHAMADO, outcome: "resolvido", note: "de novo" },
        fazerCtx(() => ({ data: null })),
      ),
    ).rejects.toThrow(/case_not_open/);
    linhasAfetadas = 1;
  });
});

// ---------------------------------------------------------------------------
// crm_resume_ai_attendance
// ---------------------------------------------------------------------------

describe("crm_resume_ai_attendance", () => {
  it("devolve o atendimento COM o contexto do que a pessoa fez", async () => {
    const resolve: Resolver = (q) => {
      if (q.tabela === "conversations" && q.terminal === "maybeSingle") {
        return {
          data: {
            id: CONV,
            contact_id: null,
            status: "claimed",
            assigned_to_user_id: null,
            assignee_kind: null,
            bot_silenced_until: "infinity",
          },
        };
      }
      if (q.tabela === "agent_cases") return { data: [CHAMADO_ABERTO] };
      if (q.tabela === "agent_case_events") {
        return {
          data: [
            {
              case_id: CHAMADO,
              human_action: "need_lead_info",
              body: "Pedir o CNPJ para emitir a nota.",
              created_at: "2026-08-04T12:00:00Z",
            },
          ],
        };
      }
      return { data: [] };
    };

    const res = (await crmResumeAiAttendance.handler(
      { conversation_id: CONV },
      ctxDePessoa(resolve),
    )) as {
      resumed: boolean;
      human_continuity: { summary: string; pending_with_customer: string | null };
    };

    expect(res.resumed).toBe(true);
    expect(res.human_continuity.summary).toContain("Pedir o CNPJ para emitir a nota.");
    expect(res.human_continuity.pending_with_customer).toBe("Pedir o CNPJ para emitir a nota.");
  });

  it("conversa de outra organização não é encontrada", async () => {
    await expect(
      crmResumeAiAttendance.handler({ conversation_id: CONV }, ctxDePessoa(() => ({ data: null }))),
    ).rejects.toThrow(/conversation_not_found/);
  });

  it("o AGENTE não desfaz a própria passagem — regra dura 2, dita no handler", async () => {
    // O ctx padrão daqui é `ai_agent` (o mesmo que o runtime monta). A recusa é
    // explícita e ensina o caminho certo, em vez de devolver um erro de papel.
    await expect(
      crmResumeAiAttendance.handler({ conversation_id: CONV }, fazerCtx(() => ({ data: null }))),
    ).rejects.toThrow(/resume_requires_person/);
  });

  it("é alcançável por papel — a regra é o ator, não o ranking", () => {
    // `lib/ai/runtime/agent.ts` grava role 'agent' FIXO e `ensureRole` compara
    // por ROLE_RANK: exigir 'manager' aqui não seria regra, seria capacidade
    // inalcançável por qualquer agente publicado, com o modelo recebendo
    // "Role 'agent' insufficient" e seguindo a conversa como se nada fosse.
    expect(crmResumeAiAttendance.requiresRole).toBe("agent");
    expect(crmResumeAiAttendance.requiresScope).toBe("mcp:write");
  });
});
