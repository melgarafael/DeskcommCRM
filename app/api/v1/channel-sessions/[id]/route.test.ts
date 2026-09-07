/**
 * A rota que EXCLUI um canal — a única deste módulo que destrói coisa.
 *
 * O dublê aplica os filtros `eq`/`is` de verdade e conta as linhas de verdade,
 * como o de `app/api/v1/pipelines/**`. Um stub de contagem fixa deixaria "canal
 * de outra organização → 404" e "o roteador de IA impede o hard delete" passarem
 * mesmo com o `eq("organization_id", …)` apagado da rota: mediria o dublê.
 *
 * Ele também registra CADA escrita com seus filtros e a ORDEM das chamadas ao
 * transporte, porque três garantias aqui são sobre a emissão em si — "nenhuma
 * escrita quando é 404", "revoga ANTES de mexer no banco" e "arquivar não apaga".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient } from "@/lib/waha/client";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/waha/client", () => ({
  getWahaClient: vi.fn(),
  wahaFriendlyError: (m: string) => m,
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";

type Linha = Record<string, unknown>;

interface Escrita {
  tipo: "update" | "delete";
  table: string;
  patch: Linha | null;
  filtros: Array<[string, unknown]>;
}

interface Registro {
  escritas: Escrita[];
  /** Ordem observável de TUDO que tem efeito colateral (transporte + banco). */
  eventos: string[];
}

interface DbOpts {
  /** Linhas de `channel_sessions`. Default: um canal pareado por QR, da ORG. */
  sessions?: Linha[];
  /** Demais tabelas, por nome — é o que a contagem de impacto lê. */
  rows?: Record<string, Linha[]>;
  readError?: (table: string) => { code?: string; message: string } | null;
  /** Erro do banco na n-ésima escrita (1-based), como o PostgREST devolveria. */
  writeError?: (n: number, table: string) => { code?: string; message: string } | null;
}

function canal(over: Linha = {}): Linha {
  return {
    id: CANAL,
    organization_id: ORG,
    provider: "waha",
    waha_session_name: "org_2222_abc",
    display_name: "Comercial",
    phone_number: "+5531999998888",
    status: "WORKING",
    archived_at: null,
    ...over,
  };
}

function makeDb(opts: DbOpts = {}): Registro {
  const registro: Registro = { escritas: [], eventos: [] };
  const tabelas: Record<string, Linha[]> = {
    channel_sessions: opts.sessions ?? [canal()],
    ...(opts.rows ?? {}),
  };
  let nEscritas = 0;

  class Q implements PromiseLike<unknown> {
    private filtros: Array<[string, unknown]> = [];
    private inclusoes: Array<[string, unknown[]]> = [];
    private limite: number | undefined;
    private ordenacao: { col: string; ascending: boolean } | undefined;
    private head = false;
    private contar = false;
    private single = false;

    constructor(
      private readonly table: string,
      private readonly op: "select" | "update" | "delete",
      private readonly patch: Linha | null = null,
    ) {}

    select(_cols?: string, o?: { count?: string; head?: boolean }): this {
      this.head = o?.head === true;
      this.contar = o?.count !== undefined;
      return this;
    }
    eq(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    is(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    in(col: string, values: unknown[]): this {
      this.inclusoes.push([col, values]);
      return this;
    }
    order(col: string, options?: { ascending?: boolean }): this {
      this.ordenacao = { col, ascending: options?.ascending !== false };
      return this;
    }
    limit(n: number): this {
      this.limite = n;
      return this;
    }
    maybeSingle(): this {
      this.single = true;
      return this;
    }

    private casam(): Linha[] {
      const linhas = tabelas[this.table] ?? [];
      return linhas.filter((l) => this.filtros.every(([c, v]) => (l[c] ?? null) === v)
        && this.inclusoes.every(([c, values]) => values.includes(l[c])));
    }

    private executar(): { data: unknown; error: unknown; count?: number } {
      if (this.op === "select") {
        const error = opts.readError?.(this.table);
        if (error) return { data: null, error };
        let achadas = this.casam();
        const order = this.ordenacao;
        if (order) achadas.sort((a, b) => String(a[order.col]).localeCompare(String(b[order.col])) * (order.ascending ? 1 : -1));
        if (this.limite !== undefined) achadas = achadas.slice(0, this.limite);
        if (this.contar) return { data: null, error: null, count: achadas.length };
        if (this.head) return { data: null, error: null };
        return { data: this.single ? (achadas[0] ?? null) : achadas, error: null };
      }

      nEscritas += 1;
      const erro = opts.writeError?.(nEscritas, this.table) ?? null;
      registro.escritas.push({
        tipo: this.op,
        table: this.table,
        patch: this.patch,
        filtros: this.filtros,
      });
      registro.eventos.push(`${this.op}:${this.table}`);
      if (erro) return { data: null, error: erro };

      const alvo = this.casam();
      if (this.op === "delete") {
        tabelas[this.table] = (tabelas[this.table] ?? []).filter((l) => !alvo.includes(l));
      } else {
        for (const l of alvo) Object.assign(l, this.patch);
      }
      return { data: null, error: null };
    }

    then<R1 = unknown, R2 = never>(
      onOk?: ((v: { data: unknown; error: unknown; count?: number }) => R1 | PromiseLike<R1>) | null,
      onErr?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(this.executar()).then(onOk, onErr);
    }
  }

  const client = {
    from: (table: string) => ({
      select: (cols?: string, o?: { count?: string; head?: boolean }) =>
        new Q(table, "select").select(cols, o),
      update: (patch: Linha) => new Q(table, "update", patch),
      delete: () => new Q(table, "delete"),
    }),
  };

  vi.mocked(createClient).mockResolvedValue(client as never);
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return registro;
}

function authOk(): void {
  const user: AuthUser = {
    id: USER,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG, name: "Org", role: "admin" },
  });
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG, name: "Org", role: "admin" });
}

/** Transporte do canal pareado por QR, registrando a ordem junto com o banco. */
function wahaOk(registro: Registro) {
  const cliente = {
    logoutSession: vi.fn(async () => {
      registro.eventos.push("waha:logout");
    }),
    deleteSession: vi.fn(async () => {
      registro.eventos.push("waha:delete");
    }),
    getVerifiedSession: vi.fn(async () => ({ name: "org_2222_abc", status: "WORKING", me: { id: "5531999998888@c.us" } })),
  };
  vi.mocked(getWahaClient).mockReturnValue(cliente as never);
  return cliente;
}

const ctx = (id = CANAL) => ({ params: Promise.resolve({ id }) });
const reqDelete = (id = CANAL) =>
  new NextRequest(`http://localhost/api/v1/channel-sessions/${id}`, { method: "DELETE" });
const reqGet = (qs = "", id = CANAL) =>
  new NextRequest(`http://localhost/api/v1/channel-sessions/${id}${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/v1/channel-sessions/[id]", () => {
  it("exige admin", async () => {
    authOk();
    const db = makeDb();
    wahaOk(db);
    const { DELETE } = await import("./route");
    await DELETE(reqDelete(), ctx());
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("admin");
  });

  it("sem auth → repassa a resposta, sem escrever nem revogar", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const db = makeDb();
    const waha = wahaOk(db);
    const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(401);
    expect(db.escritas).toEqual([]);
    expect(waha.logoutSession).not.toHaveBeenCalled();
  });

  it("canal VIRGEM → apaga a linha e emite channel.deleted", async () => {
    authOk();
    const db = makeDb();
    wahaOk(db);
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).data.archived).toBe(false);
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]).toMatchObject({ tipo: "delete", table: "channel_sessions" });
    expect(db.escritas[0]?.filtros).toContainEqual(["organization_id", ORG]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.deleted" }));
  });

  it("revoga no transporte ANTES de tocar no banco", async () => {
    authOk();
    const db = makeDb();
    wahaOk(db);
    const { DELETE } = await import("./route");
    await DELETE(reqDelete(), ctx());
    // Ordem inversa deixaria sessão órfã ativa no transporte, recebendo webhook
    // de um canal que a UI já não mostra.
    expect(db.eventos).toEqual(["waha:logout", "waha:delete", "delete:channel_sessions"]);
  });

  it("canal COM CONVERSAS → arquiva, NÃO apaga, e emite channel.archived", async () => {
    authOk();
    const db = makeDb({
      rows: { conversations: [{ id: "c1", organization_id: ORG, channel_session_id: CANAL }] },
    });
    wahaOk(db);
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).data.archived).toBe(true);
    expect(db.escritas.map((e) => e.tipo)).toEqual(["update"]);
    expect(db.escritas[0]?.patch).toMatchObject({ status: "STOPPED" });
    expect(db.escritas[0]?.patch?.archived_at).toEqual(expect.any(String));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.archived" }));
  });

  /**
   * ⭐ `ai_routers.channel_session_id` é ON DELETE CASCADE, não RESTRICT: pela
   * régua das "três FKs que bloqueiam", este canal é virgem — e o DELETE levava o
   * roteador e os `ai_router_members` dele sem uma palavra, com o toast dizendo só
   * "Canal excluído".
   */
  it("canal com ROTEADOR DE IA → arquiva; o roteador continua de pé", async () => {
    authOk();
    const db = makeDb({
      rows: {
        ai_routers: [{ id: "r1", organization_id: ORG, channel_session_id: CANAL }],
      },
    });
    wahaOk(db);
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.archived).toBe(true);
    expect(body.data.impact.configuration.ai_routers).toBe(1);
    expect(db.escritas.map((e) => e.tipo)).toEqual(["update"]);
  });

  it("ajuste anti-ban do operador (channel_knobs) também impede o hard delete", async () => {
    authOk();
    const db = makeDb({
      rows: { channel_knobs: [{ organization_id: ORG, channel_session_id: CANAL }] },
    });
    wahaOk(db);
    const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(200);
    expect(db.escritas.map((e) => e.tipo)).toEqual(["update"]);
  });

  it("dependência de OUTRA organização não conta — a contagem é por tenant", async () => {
    authOk();
    const db = makeDb({
      rows: { ai_routers: [{ id: "r1", organization_id: OUTRA_ORG, channel_session_id: CANAL }] },
    });
    wahaOk(db);
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());
    expect((await res.json()).data.archived).toBe(false);
    expect(db.escritas.map((e) => e.tipo)).toEqual(["delete"]);
  });

  /**
   * ⭐ `meta_phone_number_id` é a coluna do ramo oficial da união; `waha_session_name`
   * é NULL nele por CHECK. Uma guarda `if (waha && session.waha_session_name)` some
   * inteira aqui: a linha era arquivada, a plataforma continuava entregando no
   * webhook, e o inbox recebia mensagem de um canal "excluído".
   */
  it("canal OFICIAL → revoga credencial e rotaciona o webhook, sem falar com o transporte", async () => {
    authOk();
    const db = makeDb({
      sessions: [
        canal({
          provider: "meta_cloud",
          waha_session_name: null,
          meta_phone_number_id: "123456",
          webhook_path_token: "tokenantigo",
        }),
      ],
      rows: { conversations: [{ id: "c1", organization_id: ORG, channel_session_id: CANAL }] },
    });
    const waha = wahaOk(db);
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());

    expect(res.status).toBe(200);
    expect(waha.logoutSession).not.toHaveBeenCalled();
    const patch = db.escritas[0]?.patch as Linha;
    expect(patch.meta_token_encrypted).toBeNull();
    expect(patch.webhook_path_token).toEqual(expect.any(String));
    expect(patch.webhook_path_token).not.toBe("tokenantigo");
  });

  it("canal oficial NÃO exige o transporte no ar", async () => {
    authOk();
    makeDb({
      sessions: [
        canal({ provider: "meta_cloud", waha_session_name: null, meta_phone_number_id: "123456" }),
      ],
    });
    vi.mocked(getWahaClient).mockReturnValue(null);
    const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(200);
  });

  /** Falha FECHADA: 200 sem revogar prometia uma desconexão que não aconteceu. */
  it("canal por QR sem o transporte no ar → 503 e NENHUMA escrita", async () => {
    authOk();
    const db = makeDb();
    vi.mocked(getWahaClient).mockReturnValue(null);
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());

    expect(res.status).toBe(503);
    expect(db.escritas).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("transporte recusa a revogação → 502, preserva canal e registra FAILED", async () => {
    authOk();
    const db = makeDb();
    const waha = wahaOk(db);
    waha.logoutSession.mockRejectedValue(new Error("waha_logout_500"));
    const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(502);
    expect(waha.logoutSession).toHaveBeenCalledWith("org_2222_abc");
    expect(waha.deleteSession).not.toHaveBeenCalled();
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]).toMatchObject({ tipo: "update", table: "channel_sessions",
      patch: { status: "FAILED", status_reason: "connection_repair_required" } });
    expect(db.escritas[0]?.patch).not.toHaveProperty("archived_at");
    expect(db.escritas[0]?.filtros).toContainEqual(["organization_id", ORG]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("lease vigente da mesma org e canal bloqueia exclusão sem efeito", async () => {
    authOk();
    const db = makeDb({ rows: { channel_connection_requests: [
      { id: "expired", organization_id: ORG, channel_session_id: CANAL, state: "processing", lease_until: new Date(Date.now() - 60000).toISOString() },
      { id: "busy", organization_id: ORG, channel_session_id: CANAL, state: "processing", lease_until: new Date(Date.now() + 60000).toISOString() },
    ] } });
    const waha = wahaOk(db); const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());
    expect(res.status).toBe(409);expect((await res.json()).error.code).toBe("connection_in_progress");
    expect(db.escritas).toEqual([]);expect(waha.logoutSession).not.toHaveBeenCalled();expect(waha.deleteSession).not.toHaveBeenCalled();
  });

  it.each(["other_tenant", "other_channel", "failed", "expired"])("recibo %s não bloqueia a exclusão autorizada", async (scenario) => {
    authOk();
    const receipt = { id: "r1", organization_id: scenario === "other_tenant" ? OUTRA_ORG : ORG,
      channel_session_id: scenario === "other_channel" ? USER : CANAL,
      state: scenario === "failed" ? "failed" : "processing",
      lease_until: new Date(Date.now() + (scenario === "expired" ? -60000 : 60000)).toISOString() };
    const db = makeDb({ rows: { channel_connection_requests: [receipt] } });
    const waha = wahaOk(db);const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(200);
    expect(waha.logoutSession).toHaveBeenCalledWith("org_2222_abc");expect(waha.deleteSession).toHaveBeenCalledWith("org_2222_abc");
  });

  it("erro ao consultar reserva retorna503 sem revogar nem escrever", async () => {
    authOk();const db = makeDb({ readError: (table) => table === "channel_connection_requests" ? { message: "DB unavailable" } : null });
    const waha = wahaOk(db);const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(503);
    expect(db.escritas).toEqual([]);expect(waha.logoutSession).not.toHaveBeenCalled();expect(waha.deleteSession).not.toHaveBeenCalled();
  });

  it("canal de outra organização → 404, nenhuma escrita, nenhuma revogação", async () => {
    authOk();
    const db = makeDb({ sessions: [canal({ organization_id: OUTRA_ORG })] });
    const waha = wahaOk(db);
    const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(404);
    expect(db.escritas).toEqual([]);
    expect(waha.logoutSession).not.toHaveBeenCalled();
  });

  it("erro do banco no arquivamento → 500 (não vira 200 mentiroso)", async () => {
    authOk();
    const db = makeDb({
      rows: { messages: [{ id: "m1", organization_id: ORG, channel_session_id: CANAL }] },
      writeError: () => ({ code: "42501", message: "permission denied" }),
    });
    wahaOk(db);
    const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(500);
  });
});

describe("GET /api/v1/channel-sessions/[id]", () => {
  it("erro de identidade/transporte não publica status nem grava saúde", async () => {
    authOk();const db = makeDb();const waha = wahaOk(db);
    waha.getVerifiedSession.mockRejectedValue(new Error("session_identity_mismatch"));
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx());
    expect(res.status).toBe(502);expect((await res.json()).error.code).toBe("connection_status_failed");
    expect(waha.getVerifiedSession).toHaveBeenCalledWith("org_2222_abc");expect(db.escritas).toEqual([]);
  });

  it("?impact=1 devolve o preflight — o diálogo sabe o desfecho ANTES do clique", async () => {
    authOk();
    const db = makeDb({
      rows: {
        conversations: [{ id: "c1", organization_id: ORG, channel_session_id: CANAL }],
        ai_routers: [{ id: "r1", organization_id: ORG, channel_session_id: CANAL }],
      },
    });
    wahaOk(db);
    const { GET } = await import("./route");
    const body = await (await GET(reqGet("?impact=1"), ctx())).json();

    expect(body.data.deletion_impact).toEqual({
      outcome: "archive",
      history: { conversations: 1, messages: 0, agent_versions: 0 },
      configuration: { ai_routers: 1, channel_knobs: 0, before_send_traces: 0 },
    });
  });

  it("sem ?impact=1 não paga as contagens — a rota é pollada esperando o QR", async () => {
    authOk();
    const db = makeDb();
    wahaOk(db);
    const { GET } = await import("./route");
    const body = await (await GET(reqGet(), ctx())).json();
    expect(body.data.deletion_impact).toBeUndefined();
  });

  /**
   * ⭐ O update do health check tinha o `error` DESCARTADO: a linha nova ficava
   * sem telefone e nada na tela dizia por quê.
   */
  it("número já usado por outro canal ativo → regrava sem o telefone e NOMEIA o conflito", async () => {
    authOk();
    const db = makeDb({
      sessions: [canal({ phone_number: null })],
      writeError: (n) => (n === 1 ? { code: "23505", message: "duplicate key" } : null),
    });
    wahaOk(db);
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.phone_number_conflict).toBe(true);
    expect(body.data.phone_number).toBeNull();
    expect(db.escritas).toHaveLength(2);
    expect(db.escritas[1]?.patch).not.toHaveProperty("phone_number");
  });

  it("erro de banco que NÃO é conflito de número → 500, nunca engolido", async () => {
    authOk();
    const db = makeDb({
      sessions: [canal({ phone_number: null })],
      writeError: () => ({ code: "42501", message: "permission denied" }),
    });
    wahaOk(db);
    const { GET } = await import("./route");
    expect((await GET(reqGet(), ctx())).status).toBe(500);
    // Uma tentativa só: 42501 não é conflito de número, então não há o que regravar.
    expect(db.escritas).toHaveLength(1);
  });

  it("canal OFICIAL não consulta o transporte — ele não tem sessão lá", async () => {
    authOk();
    const db = makeDb({
      sessions: [
        canal({ provider: "meta_cloud", waha_session_name: null, meta_phone_number_id: "123456" }),
      ],
    });
    const waha = wahaOk(db);
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx());

    expect(res.status).toBe(200);
    expect(waha.getVerifiedSession).not.toHaveBeenCalled();
    expect((await res.json()).data.waha_configured).toBe(false);
  });
});
