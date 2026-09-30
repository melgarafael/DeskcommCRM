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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// env.ts valida process.env no import; corta os chains client→env (os handlers só
// recebem o ctx.supabase stub, nunca criam client real).
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
  isServiceRoleConfigured: () => false,
}));
vi.mock("@/lib/api/auth-dual", () => ({ resolveAuthDual: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));

import {
  crmListConversations,
  crmGetConversation,
  crmGetConversationHistory,
} from "@/lib/mcp/tools/conversations";
import { GET as listLeads } from "@/app/api/v1/leads/route";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
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
    .sort((a, b) => a.awaiting_since.localeCompare(b.awaiting_since) || a.id.localeCompare(b.id))
    .map((r) => r.id);
}

interface Q {
  table: string;
  select: string | null;
  terminal: "maybeSingle" | "then";
  eqs: Array<[string, unknown]>;
  limit?: number;
}
type Resolver = (q: Q) => { data?: unknown; error?: unknown };

function makeSupabase(resolve: Resolver) {
  const from = (table: string) => {
    const q: Q = { table, select: null, terminal: "then", eqs: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (cols: string) => {
        q.select = cols;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        q.eqs.push([column, value]);
        return chain;
      },
      is: () => chain,
      in: () => chain,
      or: () => chain,
      contains: () => chain,
      ilike: () => chain,
      order: () => chain,
      limit: (value: number) => {
        q.limit = value;
        return chain;
      },
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
            data:
              id in USER_NAMES
                ? { user: { user_metadata: { full_name: USER_NAMES[id] } } }
                : { user: null },
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
      convRow({
        id: r.id,
        status: "open",
        assigned_to_user_id: null,
        last_inbound_at: r.last_inbound_at,
      }),
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
    const rows = [
      convRow({
        id: CONV_OLD,
        status: "claimed",
        assigned_to_user_id: USER_B,
        assignee_kind: "user",
        tags: ["x"],
      }),
    ];
    const res = (await crmListConversations.handler(
      { limit: 10 } as Parameters<typeof crmListConversations.handler>[0],
      makeCtx((q) => (q.select === "id" ? { data: [], error: null } : { data: rows, error: null })),
    )) as { conversations: Array<Record<string, unknown>> };
    const c = res.conversations[0]!;
    // antigos:
    for (const k of [
      "id",
      "contact_id",
      "channel",
      "status",
      "assigned_to_user_id",
      "last_message_preview",
      "last_message_at",
      "unread_count",
      "is_group",
    ]) {
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

describe("leitura de contexto externo", () => {
  it("filtra o contato no banco antes da paginação e preserva o cursor", async () => {
    const wanted = "dddddddd-0000-4000-8000-000000000001";
    const rows = [
      convRow({ id: CONV_NEW, status: "closed" }),
      convRow({ id: CONV_MID, contact_id: wanted, status: "closed" }),
      convRow({ id: CONV_OLD, contact_id: wanted, status: "closed" }),
    ];
    const ctx = makeCtx((q) => {
      expect(q.eqs).toContainEqual(["organization_id", ORG]);
      const filtered = rows.filter((row) => q.eqs.every(([key, value]) => row[key] === value));
      return { data: filtered.slice(0, q.limit), error: null };
    });
    const result = (await crmListConversations.handler({ contact_id: wanted, limit: 1 }, ctx)) as {
      conversations: Array<{ id: string }>;
      has_more: boolean;
      cursor: string | null;
    };
    expect(result.conversations.map((row) => row.id)).toEqual([CONV_MID]);
    expect(result.has_more).toBe(true);
    expect(result.cursor).toEqual(expect.any(String));
  });

  it.each(["Quero conversar amanhã.", null])(
    "entrega a transcrição (%s) sem endereço de mídia nem metadados privados",
    async (transcript) => {
      const ctx = makeCtx((q) => {
        expect(q.table).toBe("messages");
        expect(q.select?.split(", ")).toContain("media_derived_text");
        expect(q.eqs).toContainEqual(["organization_id", ORG]);
        expect(q.eqs).toContainEqual(["conversation_id", CONV_OLD]);
        return {
          data: [
            {
              id: "aaaaaaaa-0000-4000-8000-000000000010",
              direction: "inbound",
              type: "audio",
              body: "[audio]",
              media_derived_text: transcript,
              media_url: "https://private.invalid/audio.ogg",
              media_storage_path: "private/audio.ogg",
              metadata: { token: "private" },
              sent_via: "external_device",
              sent_at: new Date(now).toISOString(),
              status: "received",
            },
          ],
          error: null,
        };
      });
      const result = (await crmGetConversationHistory.handler(
        { conversation_id: CONV_OLD, limit: 20 },
        ctx,
      )) as {
        messages: Array<Record<string, unknown>>;
        has_more: boolean;
      };
      expect(result.messages[0]).toMatchObject({ body: "[audio]", media_derived_text: transcript });
      expect(result.messages[0]).not.toHaveProperty("media_url");
      expect(result.messages[0]).not.toHaveProperty("media_storage_path");
      expect(result.messages[0]).not.toHaveProperty("metadata");
      expect(result.has_more).toBe(false);
    },
  );
});

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

describe("GET leads — leitura autenticada e isolamento", () => {
  beforeEach(() => {
    vi.mocked(resolveAuthDual).mockReset();
    vi.mocked(checkRateLimit).mockReset();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      limit: 60,
      window_sec: 60,
    });
  });

  function authorize(resolve: Resolver) {
    const ctx = makeCtx(resolve);
    vi.mocked(resolveAuthDual).mockResolvedValue({
      ok: true,
      organizationId: ORG,
      actor: ctx.actor,
      supabase: ctx.supabase,
      via: "token",
      apiTokenId: "tok",
      scopes: ["mcp:read"],
    });
  }

  it("usa a organização autenticada em leads e contatos, sem aceitar org da query", async () => {
    const contactId = "dddddddd-0000-4000-8000-000000000001";
    authorize((q) => {
      expect(q.eqs).toContainEqual(["organization_id", ORG]);
      return {
        data:
          q.table === "contacts"
            ? [{ id: contactId, name: "Contato de teste", phone_number: "+5500000000000" }]
            : [leadRow({ contact_id: contactId })],
        error: null,
      };
    });
    const response = await listLeads(
      new NextRequest("http://localhost/api/v1/leads?organization_id=foreign"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0].contact.id).toBe(contactId);
    expect(body.meta).toEqual({ cursor: null, has_more: false });
    expect(resolveAuthDual).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: "agent", scope: "mcp:read" }),
    );
    expect(checkRateLimit).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("recusa autenticação ou escopo (%i) sem ler o banco", async (status) => {
    vi.mocked(resolveAuthDual).mockResolvedValue({
      ok: false,
      response: new Response(null, { status }),
    });
    expect((await listLeads(new NextRequest("http://localhost/api/v1/leads"))).status).toBe(status);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it.each(["limit=0", "limit=101", "status=invalid", "cursor="])(
    "valida %s antes de consultar",
    async (query) => {
      authorize(() => {
        throw new Error("não deve consultar");
      });
      expect(
        (await listLeads(new NextRequest(`http://localhost/api/v1/leads?${query}`))).status,
      ).toBe(422);
    },
  );

  it("recusa excesso do token antes de consumir a cota da organização", async () => {
    authorize(() => {
      throw new Error("não deve consultar");
    });
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 61,
      limit: 60,
      window_sec: 60,
    });
    const response = await listLeads(new NextRequest("http://localhost/api/v1/leads"));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it("não expõe erro interno ou credenciais do banco", async () => {
    authorize(() => ({ data: null, error: { message: "private-database-detail" } }));
    const response = await listLeads(new NextRequest("http://localhost/api/v1/leads"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-database-detail");
  });
});

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
