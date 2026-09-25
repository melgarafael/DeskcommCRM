/**
 * G6-03 — as 4 tools de leitura expõem governança (spec 13 §3.1).
 *
 * Prova, contra os handlers REAIS (ctx.supabase stub):
 *  - campos ADITIVOS presentes (assignee_kind, assigned_to_user_name, tags,
 *    queue_position; owner_user_name, stage, tags) por tool;
 *  - shape ANTIGO intacto (nada renomeado/removido — consumidor atual não quebra);
 *  - fixtures dos 3 estados: atribuída (user), na fila, IA atendendo;
 *  - COERÊNCIA da queue_position: o número da tool = a posição na MESMA ordem que
 *    o inbox (G5-03 / gov-5d): awaiting_since ASC, id ASC — computada de forma
 *    independente e comparada;
 *  - LGPD: só id + nome do usuário no payload; nunca email/telefone/metadata.
 */
import { describe, expect, it, vi } from "vitest";

// env.ts valida process.env no import; corta os chains client→env (os handlers só
// recebem o ctx.supabase stub, nunca criam client real).
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
  isServiceRoleConfigured: () => false,
}));

import {
  crmListConversations,
  crmGetConversation,
} from "@/lib/mcp/tools/conversations";
import { crmListLeads, crmGetLead } from "@/lib/mcp/tools/leads";
import type { McpContext } from "@/lib/mcp/types";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER_A = "11111111-1111-4111-8111-111111111111"; // Alice
const USER_B = "33333333-3333-4333-8333-333333333333"; // Bob
const STAGE_1 = "55555555-5555-4555-8555-555555555551";

const USER_NAMES: Record<string, string> = { [USER_A]: "Alice", [USER_B]: "Bob" };

// Fila: 3 conversas com tempos de espera conhecidos (oldest = pos 1).
const CONV_OLD = "aaaaaaaa-0000-4000-8000-000000000001";
const CONV_MID = "aaaaaaaa-0000-4000-8000-000000000002";
const CONV_NEW = "aaaaaaaa-0000-4000-8000-000000000003";
// Fila: 3 conversas com tempos de espera conhecidos (oldest = pos 1). A coluna
// da espera é o awaiting_since (`ORDEM_DA_ESPERA`); o CONV_OLD guarda o
// last_inbound_at mais NOVO de propósito, para que a ordem emule a régua viva e
// não a antiga (que dava a ele a ÚLTIMA posição).
const now = Date.now();
const QUEUE_ROWS = [
  {
    id: CONV_NEW,
    awaiting_since: new Date(now - 2 * 60_000).toISOString(),
    last_inbound_at: new Date(now - 2 * 60_000).toISOString(),
  },
  {
    id: CONV_OLD,
    awaiting_since: new Date(now - 30 * 60_000).toISOString(),
    last_inbound_at: new Date(now).toISOString(),
  },
  {
    id: CONV_MID,
    awaiting_since: new Date(now - 10 * 60_000).toISOString(),
    last_inbound_at: new Date(now - 10 * 60_000).toISOString(),
  },
];

/** Ordem canônica do inbox (G5-03): awaiting_since ASC, id ASC. */
function inboxOrder(rows: Array<{ id: string; awaiting_since: string }>): string[] {
  return [...rows]
    .sort(
      (a, b) =>
        a.awaiting_since.localeCompare(b.awaiting_since) || a.id.localeCompare(b.id),
    )
    .map((r) => r.id);
}

interface Q {
  table: string;
  select: string | null;
  terminal: "maybeSingle" | "then";
}
type Resolver = (q: Q) => { data?: unknown; error?: unknown };

function makeSupabase(resolve: Resolver) {
  const from = (table: string) => {
    const q: Q = { table, select: null, terminal: "then" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (cols: string) => {
        q.select = cols;
        return chain;
      },
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      or: () => chain,
      contains: () => chain,
      ilike: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(resolve({ ...q, terminal: "maybeSingle" })),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ ...q, terminal: "then" })).then(res),
    };
    return chain;
  };
  return {
    from,
    auth: {
      admin: {
        getUserById: (id: string) =>
          Promise.resolve({
            data: id in USER_NAMES ? { user: { user_metadata: { full_name: USER_NAMES[id] } } } : { user: null },
            error: null,
          }),
      },
    },
  };
}

function makeCtx(resolve: Resolver): McpContext {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "run_1", role: "agent", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: makeSupabase(resolve) as any,
  } as McpContext;
}

// Row de conversa mínima com os campos que os handlers/tools leem.
function convRow(over: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: over.id,
    organization_id: ORG,
    contact_id: "c0000000-0000-4000-8000-000000000001",
    channel_session_id: "s0000000-0000-4000-8000-000000000001",
    channel: "whatsapp",
    status: "open",
    status_changed_at: new Date(now).toISOString(),
    assigned_to_user_id: null,
    assignee_kind: null,
    assigned_at: null,
    last_inbound_at: new Date(now).toISOString(),
    last_outbound_at: null,
    last_message_at: new Date(now).toISOString(),
    last_message_preview: "oi",
    unread_count_for_assignee: 0,
    is_group: false,
    group_chat_id: null,
    tags: [],
    metadata: {},
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    ...over,
  };
  /**
   * `comando_da_conversa` é CALCULADO pelo banco (migration 0203) e chega junto
   * com a linha — `isInQueue` do MCP o lê para decidir se busca as posições.
   *
   * O dublê o DERIVA pela regra canônica em vez de cravar um valor: cravar faria
   * este arquivo ficar verde no dia em que a regra mudasse e o produto errasse,
   * que é o defeito que o espelho SQL↔TS existe para impedir. Aqui ele custa uma
   * linha e mantém o dublê honesto de graça.
   */
  return {
    ...base,
    comando_da_conversa: comandoDaConversa(
      {
        status: String(base.status),
        assigned_to_user_id: (base.assigned_to_user_id as string | null) ?? null,
        bot_silenced_until: (base.bot_silenced_until as string | null) ?? null,
        force_human: false,
        is_blocked: false,
        automaticoDaOrg: true,
      },
      new Date(now),
    ).comando.quem,
  };
}

/** Resolver de conversas: getQueuePositions (select "id") devolve a fila na ordem do inbox. */
function convResolver(single: Record<string, unknown> | null): Resolver {
  return (q) => {
    if (q.table === "conversations" && q.select === "id") {
      // Emula o ORDER BY do banco: retorna a fila JÁ ordenada (inbox order)…
      //
      // …E O FILTRO. Desde a migration 0203 `getQueuePositions` pede
      // `comando_da_conversa in comandosDaFila(...)`, então uma conversa que o
      // AUTOMÁTICO está conduzindo não volta desta consulta — e é por isso que
      // ela não ganha `queue_position`. Um dublê que devolvesse a lista inteira
      // afirmaria o contrário do produto e deixaria o caso "IA atendendo, sem
      // posição" verde pelo motivo errado.
      const naFila = single === null || single.comando_da_conversa === "aguardando";
      const ordered = inboxOrder(QUEUE_ROWS)
        .filter((id) => naFila || id !== single?.id)
        .map((id) => ({ id }));
      return { data: ordered, error: null };
    }
    if (q.table === "conversations" && q.terminal === "maybeSingle") {
      return { data: single, error: null };
    }
    return { data: single ? [single] : [], error: null };
  };
}

// ---------------------------------------------------------------------------
// crm_get_conversation — 3 estados
// ---------------------------------------------------------------------------

describe("crm_get_conversation — governança + shape", () => {
  it("ATRIBUÍDA (user): assignee_kind='user', nome do atendente, sem queue_position", async () => {
    const row = convRow({
      id: CONV_OLD,
      status: "claimed",
      assigned_to_user_id: USER_A,
      assignee_kind: "user",
      assigned_at: new Date(now).toISOString(),
      tags: ["prioridade"],
    });
    const res = (await crmGetConversation.handler(
      { conversation_id: CONV_OLD },
      makeCtx(convResolver(row)),
    )) as Record<string, unknown>;

    expect(res.assignee_kind).toBe("user");
    expect(res.assigned_to_user_id).toBe(USER_A);
    expect(res.assigned_to_user_name).toBe("Alice");
    expect(res.tags).toEqual(["prioridade"]);
    expect(res.queue_position).toBeNull(); // tem dono ⇒ fora da fila
    // shape antigo intacto:
    expect(res.id).toBe(CONV_OLD);
    expect(res.status).toBe("claimed");
    expect(res.contact_id).toBeDefined();
    expect(res.channel).toBe("whatsapp");
  });

  it("NA FILA: assignee_kind=null, sem nome, queue_position preenchida", async () => {
    // O FIXTURE GANHOU O SILÊNCIO, e a mudança não é cosmética.
    //
    // Até a migration 0203, "na fila" era `open` + sem dono — e era justamente
    // esse par que punha na fila tudo que o robô estava atendendo (medido na VPS:
    // 83 na aba, 47 delas comandadas pelo automático). Sob a régua nova, `open` +
    // sem dono + sem trava É O AUTOMÁTICO. Para estar esperando uma pessoa, a
    // conversa precisa ter sido escalada — que é o que `bot_silenced_until` diz.
    const row = convRow({
      id: CONV_MID,
      status: "open",
      assigned_to_user_id: null,
      bot_silenced_until: "infinity",
    });
    const res = (await crmGetConversation.handler(
      { conversation_id: CONV_MID },
      makeCtx(convResolver(row)),
    )) as Record<string, unknown>;

    expect(res.assignee_kind).toBeNull();
    expect(res.assigned_to_user_id).toBeNull();
    expect(res.assigned_to_user_name).toBeNull();
    // CONV_MID (10 min) é a 2ª mais antiga ⇒ posição 2.
    expect(res.queue_position).toBe(inboxOrder(QUEUE_ROWS).indexOf(CONV_MID) + 1);
    expect(res.queue_position).toBe(2);
  });

  it("IA ATENDENDO: assignee_kind='ai', sem nome, sem queue_position", async () => {
    const row = convRow({
      id: CONV_NEW,
      status: "ai_handling",
      assigned_to_user_id: null,
      assignee_kind: "ai",
    });
    const res = (await crmGetConversation.handler(
      { conversation_id: CONV_NEW },
      makeCtx(convResolver(row)),
    )) as Record<string, unknown>;

    expect(res.assignee_kind).toBe("ai");
    expect(res.assigned_to_user_name).toBeNull();
    expect(res.queue_position).toBeNull(); // status != 'open' ⇒ fora da fila

    // LGPD: nenhum campo de PII do usuário além do nome (id) vaza no payload.
    const keys = Object.keys(res);
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("phone");
    expect(keys).not.toContain("user_metadata");
  });
});

// ---------------------------------------------------------------------------
// crm_list_conversations — coerência da queue_position com o inbox (G5-03)
// ---------------------------------------------------------------------------

describe("crm_list_conversations — coerência queue_position ↔ inbox", () => {
  it("as 3 conversas na fila recebem a posição da ordem do inbox (awaiting_since ASC, id ASC)", async () => {
    // Handler de list retorna as 3 conversas da fila.
    const rows = QUEUE_ROWS.map((r) =>
      convRow({ id: r.id, status: "open", assigned_to_user_id: null, last_inbound_at: r.last_inbound_at }),
    );
    const resolve: Resolver = (q) => {
      if (q.table === "conversations" && q.select === "id") {
        return { data: inboxOrder(QUEUE_ROWS).map((id) => ({ id })), error: null };
      }
      return { data: rows, error: null }; // list (then)
    };
    const res = (await crmListConversations.handler(
      { limit: 10 } as Parameters<typeof crmListConversations.handler>[0],
      makeCtx(resolve),
    )) as { conversations: Array<Record<string, unknown>> };

    const posById = new Map(res.conversations.map((c) => [c.id as string, c.queue_position]));
    const expectedOrder = inboxOrder(QUEUE_ROWS); // independente do tool

    // Cada conversa: a posição da tool bate com a posição na ordem do inbox.
    for (let i = 0; i < expectedOrder.length; i++) {
      expect(posById.get(expectedOrder[i]!)).toBe(i + 1);
    }
    // A mais antiga (30 min) é posição 1; a mais nova (2 min) é a última.
    expect(posById.get(CONV_OLD)).toBe(1);
    expect(posById.get(CONV_NEW)).toBe(3);
  });

  it("shape aditivo: campos antigos preservados, novos presentes", async () => {
    const rows = [convRow({ id: CONV_OLD, status: "claimed", assigned_to_user_id: USER_B, assignee_kind: "user", tags: ["x"] })];
    const res = (await crmListConversations.handler(
      { limit: 10 } as Parameters<typeof crmListConversations.handler>[0],
      makeCtx((q) =>
        q.select === "id" ? { data: [], error: null } : { data: rows, error: null },
      ),
    )) as { conversations: Array<Record<string, unknown>> };
    const c = res.conversations[0]!;
    // antigos:
    for (const k of ["id", "contact_id", "channel", "status", "assigned_to_user_id", "last_message_preview", "last_message_at", "unread_count", "is_group"]) {
      expect(c).toHaveProperty(k);
    }
    // novos:
    expect(c.assignee_kind).toBe("user");
    expect(c.assigned_to_user_name).toBe("Bob");
    expect(c.tags).toEqual(["x"]);
    expect(c).toHaveProperty("queue_position");
  });
});

// ---------------------------------------------------------------------------
// crm_get_lead / crm_list_leads — owner_user_name, stage, tags
// ---------------------------------------------------------------------------

function leadRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "d0000000-0000-4000-8000-000000000001",
    organization_id: ORG,
    pipeline_id: "e0000000-0000-4000-8000-000000000001",
    stage_id: STAGE_1,
    title: "Pedido #1",
    status: "open",
    owner_user_id: null,
    tags: [],
    value_cents: null,
    currency: "BRL",
    position_in_stage: 1000,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    ...over,
  };
}

function leadResolver(rows: Array<Record<string, unknown>>): Resolver {
  return (q) => {
    if (q.table === "crm_stages") {
      return { data: [{ id: STAGE_1, name: "Qualificação" }], error: null };
    }
    if (q.table === "crm_leads" && q.terminal === "maybeSingle") {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  };
}

describe("crm_get_lead / crm_list_leads — governança + shape", () => {
  it("get: com owner ⇒ owner_user_name + stage{id,name} + tags; shape antigo intacto", async () => {
    const row = leadRow({ owner_user_id: USER_A, tags: ["vip", "recorrente"] });
    const res = (await crmGetLead.handler(
      { lead_id: row.id as string },
      makeCtx(leadResolver([row])),
    )) as { lead: Record<string, unknown> };

    expect(res.lead.owner_user_id).toBe(USER_A);
    expect(res.lead.owner_user_name).toBe("Alice");
    expect(res.lead.stage).toEqual({ id: STAGE_1, name: "Qualificação" });
    expect(res.lead.tags).toEqual(["vip", "recorrente"]);
    // antigos preservados:
    expect(res.lead.stage_id).toBe(STAGE_1);
    expect(res.lead.status).toBe("open");
    expect(res.lead.pipeline_id).toBeDefined();
    expect(res.lead.title).toBe("Pedido #1");
  });

  it("list: sem owner (fila) ⇒ owner_user_name=null, stage ainda resolvido", async () => {
    const row = leadRow({ owner_user_id: null, tags: [] });
    const res = (await crmListLeads.handler(
      { limit: 20 } as Parameters<typeof crmListLeads.handler>[0],
      makeCtx(leadResolver([row])),
    )) as { leads: Array<Record<string, unknown>> };

    const lead = res.leads[0]!;
    expect(lead.owner_user_id).toBeNull();
    expect(lead.owner_user_name).toBeNull();
    expect(lead.stage).toEqual({ id: STAGE_1, name: "Qualificação" });
    // LGPD: nenhum campo de PII do owner além do nome.
    const keys = Object.keys(lead);
    expect(keys).not.toContain("owner_email");
    expect(keys).not.toContain("owner_phone");
  });
});
