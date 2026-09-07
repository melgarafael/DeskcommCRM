/**
 * O canal ARQUIVADO nos três caminhos que o religam — e o caminho de volta.
 *
 * A etapa anterior ensinou o sistema inteiro a ignorar canal arquivado: o
 * webhook descarta, o ingest não cria conversa, os seletores não oferecem e o
 * envio recusa. Só que ninguém ensinou o contrário — `grep "archived_at: null"`
 * voltava vazio no repo todo. O efeito é o pior estado possível: quem reconecta
 * escreve status, credencial e número, a tela diz "conectado", e o canal segue
 * arquivado, invisível e mudo.
 *
 * Aqui os três caminhos que resolvem uma sessão para RELIGAR são dirigidos de
 * verdade (handler real, dublê que aplica os filtros e guarda o estado), cada um
 * com o desfecho que lhe cabe:
 *   - canal oficial → RESSUSCITA (a credencial nova chegou validada);
 *   - reconectar por QR → RECUSA (subir a sessão devolveria um canal surdo, e não
 *     há o que reconectar: o aparelho já foi deslogado);
 *   - onboarding → RESSUSCITA (o nome da sessão é derivado do org e nunca muda;
 *     recusar fecharia o onboarding para sempre).
 *
 * O dublê simula também o clone que subiu o código sem a migration 0106: lá a
 * coluna não existe, e um caminho de volta que a exigisse quebraria a reconexão
 * inteira — por um motivo que nem existe naquele banco.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import type { AuthUser } from "@/lib/auth/types";
import { CHANNEL_PROVIDER_META, CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient } from "@/lib/waha/client";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  requireAuth: vi.fn(),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn() }));
vi.mock("@/lib/channels/meta/validate-credentials", () => ({ validateMetaCredentials: vi.fn() }));
vi.mock("@/lib/waha/client", () => ({
  getWahaClient: vi.fn(),
  wahaFriendlyError: (m: string) => m,
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "44444444-4444-4444-8444-444444444444";
const ARQUIVADO_EM = "2026-08-01T10:00:00.000Z";
const NOME_SESSAO = "org_22222222";

type Linha = Record<string, unknown>;

interface Escrita {
  tipo: "update" | "insert";
  table: string;
  patch: Linha;
  /** Falhou antes de tocar a linha (é o que o banco sem a coluna faz). */
  recusada: boolean;
}

interface Registro {
  escritas: Escrita[];
  linhas: Linha[];
}

interface DbOpts {
  sessions?: Linha[];
  /**
   * Clone que subiu o código sem a migration 0106. Qualquer consulta que NOMEIE
   * `archived_at` falha — no filtro/select com o 42703 do Postgres, no corpo de
   * uma escrita com o PGRST204 do PostgREST, que resolve as colunas do corpo
   * contra o schema cache antes de montar o UPDATE.
   */
  semColunaArquivada?: boolean;
  /** Erro do banco na n-ésima escrita (1-based), como o PostgREST devolveria. */
  writeError?: (n: number) => { code?: string; message: string } | null;
}

function canalOficial(over: Linha = {}): Linha {
  return {
    id: CANAL,
    organization_id: ORG,
    provider: CHANNEL_PROVIDER_META,
    waha_session_name: null,
    meta_phone_number_id: "999",
    meta_token_encrypted: null,
    display_name: "Canal oficial",
    phone_number: null,
    status: "STOPPED",
    archived_at: null,
    ...over,
  };
}

function canalQr(over: Linha = {}): Linha {
  return {
    id: CANAL,
    organization_id: ORG,
    provider: CHANNEL_PROVIDER_WAHA,
    waha_session_name: NOME_SESSAO,
    display_name: "Vendas",
    phone_number: "+5531999998888",
    status: "WORKING",
    archived_at: null,
    ...over,
  };
}

const SEM_COLUNA_LEITURA = {
  code: "42703",
  message: 'column channel_sessions_1.archived_at does not exist',
};
const SEM_COLUNA_ESCRITA = {
  code: "PGRST204",
  message: "Could not find the 'archived_at' column of 'channel_sessions' in the schema cache",
};

function makeDb(opts: DbOpts = {}): Registro {
  const linhas: Linha[] = opts.sessions ?? [];
  const registro: Registro = { escritas: [], linhas };
  let nEscritas = 0;

  class Q implements PromiseLike<unknown> {
    private filtros: Array<[string, unknown]> = [];
    private colunas = "";
    private unica = false;

    constructor(
      private readonly table: string,
      private readonly op: "select" | "update" | "insert",
      private readonly patch: Linha | null = null,
    ) {}

    select(cols?: string): this {
      this.colunas = cols ?? "";
      return this;
    }
    eq(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    in(col: string, val: unknown[]): this {
      this.filtros.push([col, val]); return this;
    }
    is(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    order(): this {
      return this;
    }
    limit(): this {
      return this;
    }
    maybeSingle(): this {
      this.unica = true;
      return this;
    }
    single(): this {
      this.unica = true;
      return this;
    }

    /** O banco sem a coluna recusa QUALQUER menção a ela — leitura ou escrita. */
    private semColuna(): { code: string; message: string } | null {
      if (opts.semColunaArquivada !== true) return null;
      if (this.op === "select") {
        const citada =
          this.colunas.includes("archived_at") ||
          this.filtros.some(([c]) => c === "archived_at");
        return citada ? SEM_COLUNA_LEITURA : null;
      }
      return this.patch && "archived_at" in this.patch ? SEM_COLUNA_ESCRITA : null;
    }

    private casam(): Linha[] {
      return linhas.filter((l) => this.filtros.every(([c, v]) => Array.isArray(v) ? v.includes(l[c]) : (l[c] ?? null) === v));
    }

    private executar(): { data: unknown; error: unknown } {
      const ausente = this.semColuna();

      if (this.op === "select") {
        if (ausente) return { data: null, error: ausente };
        const achadas = this.casam();
        return { data: this.unica ? (achadas[0] ?? null) : achadas, error: null };
      }

      nEscritas += 1;
      const erro = ausente ?? opts.writeError?.(nEscritas) ?? null;
      registro.escritas.push({
        tipo: this.op === "insert" ? "insert" : "update",
        table: this.table,
        patch: this.patch ?? {},
        recusada: erro !== null,
      });
      if (erro) return { data: null, error: erro };

      if (this.op === "insert") {
        const nova = { id: "canal-novo", ...(this.patch ?? {}) };
        linhas.push(nova);
        return { data: nova, error: null };
      }
      for (const l of this.casam()) Object.assign(l, this.patch);
      return { data: null, error: null };
    }

    then<R1 = unknown, R2 = never>(
      onOk?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
      onErr?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(this.executar()).then(onOk, onErr);
    }
  }

  const client = {
    rpc: async (fn: string, args: Linha) => {
      if (fn === "fn_reserve_channel_connection") {
        let channel = linhas.find(l => l.organization_id === args.p_org && l.waha_session_name === NOME_SESSAO);
        if (!channel) {
          channel = canalQr({ id: CANAL, status: "STARTING", phone_number: null }); linhas.push(channel);
          registro.escritas.push({ tipo: "insert", table: "channel_sessions", patch: channel, recusada: false });
        }
        return { data: { replay: false, channel: { ...channel }, receipt_id: CANAL, lease_token: USER }, error: null };
      }
      if (fn === "fn_finish_channel_connection") {
        if (args.p_status === "remote_created") return { data: {}, error: null };
        const channel = linhas.find(l => l.organization_id === args.p_org && l.id === CANAL);
        if (!channel) return { data: null, error: { message: "missing" } };
        if (channel.archived_at) channel.phone_number = null;
        Object.assign(channel, { status: args.p_status, archived_at: null });
        return { data: { ...channel }, error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => ({
      select: (cols?: string) => new Q(table, "select").select(cols),
      update: (patch: Linha) => new Q(table, "update", patch),
      insert: (patch: Linha) => new Q(table, "insert", patch),
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
  const org = { orgId: ORG, name: "Org", role: "admin" as const };
  vi.mocked(requireAuth).mockResolvedValue(user);
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue(org);
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user, org });
}

function transporteOk() {
  const cliente = {
    createSession: vi.fn(async (name: string) => ({ created: false, session: { name, status: "STOPPED" } })),
    startExistingSession: vi.fn(async (name: string) => ({ name, status: "STARTING" })),
    stopSession: vi.fn(async () => undefined),
    logoutSession: vi.fn(async () => undefined),
    startSession: vi.fn(async () => ({ status: "STARTING" })),
    getSessionQr: vi.fn(async () => ({ status: "STARTING" })),
  };
  vi.mocked(getWahaClient).mockReturnValue(cliente as never);
  return cliente;
}

const patchDe = (r: Registro, i = 0): Linha => r.escritas[i]?.patch ?? {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(encryptWebhookSecret).mockResolvedValue("cifra-nova" as never);
  vi.mocked(validateMetaCredentials).mockResolvedValue({
    ok: true,
    displayPhoneNumber: "55 31 99999-8888",
    verifiedName: "Loja",
  } as never);
});

const corpoOficial = {
  phone_number_id: "1234567890",
  waba_id: "9876543210",
  token: "EAA-token-de-teste-com-mais-de-vinte-caracteres",
};
const reqOficial = () =>
  new NextRequest("http://localhost/api/v1/channels/official", {
    method: "POST",
    body: JSON.stringify(corpoOficial),
    headers: { "content-type": "application/json" },
  });

describe("POST /api/v1/channels/official — reconectar é ressuscitar", () => {
  it("⭐ canal oficial EXCLUÍDO volta ATIVO: a linha deixa de estar arquivada", async () => {
    authOk();
    const db = makeDb({ sessions: [canalOficial({ archived_at: ARQUIVADO_EM })] });
    const { POST } = await import("@/app/api/v1/channels/official/route");
    const res = await POST(reqOficial());

    expect(res.status).toBe(200);
    // Não basta o patch dizer: a linha em si tem que sair arquivada.
    expect(db.linhas[0]?.archived_at).toBeNull();
    expect(db.linhas[0]?.status).toBe("WORKING");
    expect(db.linhas[0]?.meta_token_encrypted).toBe("cifra-nova");
    expect(db.linhas[0]?.phone_number).toBe("+5531999998888");
  });

  it("ressuscita a MESMA linha — nunca uma segunda linha oficial na org", async () => {
    authOk();
    const db = makeDb({ sessions: [canalOficial({ archived_at: ARQUIVADO_EM })] });
    const { POST } = await import("@/app/api/v1/channels/official/route");
    await POST(reqOficial());

    expect(db.escritas.map((e) => e.tipo)).toEqual(["update"]);
    expect(db.linhas).toHaveLength(1);
  });

  it("canal que já estava ativo: atualiza normalmente e NÃO inventa uma ressurreição", async () => {
    authOk();
    const db = makeDb({ sessions: [canalOficial({ status: "WORKING" })] });
    const { POST } = await import("@/app/api/v1/channels/official/route");
    const res = await POST(reqOficial());

    expect(res.status).toBe(200);
    expect(db.linhas[0]?.meta_token_encrypted).toBe("cifra-nova");
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.reactivated" }),
    );
  });

  it("org sem canal oficial: insere (o caminho de volta não engoliu o de ida)", async () => {
    authOk();
    const db = makeDb({ sessions: [] });
    const { POST } = await import("@/app/api/v1/channels/official/route");
    const res = await POST(reqOficial());

    expect(res.status).toBe(200);
    expect(db.escritas.map((e) => e.tipo)).toEqual(["insert"]);
  });

  /**
   * ⭐ Um caminho de volta que EXIGISSE a coluna trocaria um defeito por outro
   * pior: o clone sem a 0100 pararia de conectar o canal oficial — e lá nada
   * está arquivado, então a coluna nem faria falta.
   */
  it("clone sem a migration 0106: a conexão FUNCIONA, repetindo sem a coluna", async () => {
    authOk();
    const db = makeDb({
      sessions: [canalOficial({ status: "STOPPED" })],
      semColunaArquivada: true,
    });
    const { POST } = await import("@/app/api/v1/channels/official/route");
    const res = await POST(reqOficial());

    expect(res.status).toBe(200);
    expect(db.escritas.map((e) => e.recusada)).toEqual([true, false]);
    expect(patchDe(db, 0)).toHaveProperty("archived_at", null);
    expect(patchDe(db, 1)).not.toHaveProperty("archived_at");
    expect(db.linhas[0]?.status).toBe("WORKING");
  });

  it("erro de verdade do banco não vira 200 mentiroso", async () => {
    authOk();
    makeDb({
      sessions: [canalOficial({ archived_at: ARQUIVADO_EM })],
      writeError: () => ({ code: "42501", message: "permission denied" }),
    });
    const { POST } = await import("@/app/api/v1/channels/official/route");
    expect((await POST(reqOficial())).status).toBe(500);
  });
});

describe("GET /api/v1/channels/official — a tela não chama de conectado o que foi excluído", () => {
  const req = () => new NextRequest("http://localhost/api/v1/channels/official");

  it("⭐ canal oficial EXCLUÍDO: `connected: false` e nenhuma URL de webhook", async () => {
    authOk();
    makeDb({ sessions: [canalOficial({ archived_at: ARQUIVADO_EM, webhook_path_token: "tok" })] });
    const { GET } = await import("@/app/api/v1/channels/official/route");
    const body = await (await GET(req())).json();

    // A URL rotacionada no arquivamento já não recebe nada: mostrá-la seria
    // mandar o operador colar na Meta um endereço morto.
    expect(body.data.connected).toBe(false);
    expect(body.data.webhook).toBeNull();
    expect(body.data.phoneNumberId).toBeNull();
  });

  it("canal oficial ativo continua aparecendo como conectado", async () => {
    authOk();
    makeDb({ sessions: [canalOficial({ webhook_path_token: "tok", meta_token_encrypted: "x" })] });
    const { GET } = await import("@/app/api/v1/channels/official/route");
    const body = await (await GET(req())).json();

    expect(body.data.connected).toBe(true);
    expect(body.data.hasToken).toBe(true);
    expect(body.data.webhook.callbackUrl).toContain("tok");
  });

  it("clone sem a migration 0106: a tela continua enxergando o canal", async () => {
    authOk();
    makeDb({
      sessions: [canalOficial({ webhook_path_token: "tok" })],
      semColunaArquivada: true,
    });
    const { GET } = await import("@/app/api/v1/channels/official/route");
    expect((await (await GET(req())).json()).data.connected).toBe(true);
  });
});

describe("POST /api/v1/channel-sessions/[id]/reconnect — canal excluído não volta pelo transporte", () => {
  const ctx = () => ({ params: Promise.resolve({ id: CANAL }) });
  const req = () =>
    new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL}/reconnect`, {
      method: "POST",
    });

  it("⭐ canal ARQUIVADO → 409 e o transporte nem é acionado", async () => {
    authOk();
    const db = makeDb({ sessions: [canalQr({ archived_at: ARQUIVADO_EM })] });
    const waha = transporteOk();
    const { POST } = await import("@/app/api/v1/channel-sessions/[id]/reconnect/route");
    const res = await POST(req(), ctx());

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("channel_archived");
    // O defeito era este: sessão de pé no transporte + webhook descartando tudo.
    expect(waha.startSession).not.toHaveBeenCalled();
    expect(waha.stopSession).not.toHaveBeenCalled();
    expect(db.escritas).toEqual([]);
  });

  it("canal ativo reconecta normalmente (a guarda não engoliu o caminho bom)", async () => {
    authOk();
    const db = makeDb({ sessions: [canalQr({ status: "FAILED" })] });
    const waha = transporteOk();
    const { POST } = await import("@/app/api/v1/channel-sessions/[id]/reconnect/route");
    const res = await POST(req(), ctx());

    expect(res.status).toBe(200);
    expect(waha.stopSession).toHaveBeenCalledWith(NOME_SESSAO);
    expect(waha.startSession).toHaveBeenCalledWith(NOME_SESSAO);
    expect(db.linhas[0]?.status).toBe("STARTING");
  });

  it("clone sem a migration 0106: reconectar continua funcionando", async () => {
    authOk();
    makeDb({ sessions: [canalQr({ status: "FAILED" })], semColunaArquivada: true });
    const waha = transporteOk();
    const { POST } = await import("@/app/api/v1/channel-sessions/[id]/reconnect/route");
    const res = await POST(req(), ctx());

    expect(res.status).toBe(200);
    expect(waha.startSession).toHaveBeenCalledWith(NOME_SESSAO);
  });

  /**
   * ⭐ O canal OFICIAL não tem sessão no transporte (`waha_session_name` NULL por
   * CHECK). O tipo aqui afirmava `string` por cast, e o `null` seguia inteiro
   * até a URL: `POST /api/sessions/null/stop`. O erro que voltava era do
   * transporte, então a tela culpava o serviço de WhatsApp por uma pergunta que
   * nunca fez sentido fazer.
   */
  it("⭐ canal OFICIAL → 422, e o transporte não é acionado com `null` no lugar do nome", async () => {
    authOk();
    const db = makeDb({ sessions: [canalOficial()] });
    const waha = transporteOk();
    const { POST } = await import("@/app/api/v1/channel-sessions/[id]/reconnect/route");
    const res = await POST(req(), ctx());

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("channel_without_session");
    expect(waha.stopSession).not.toHaveBeenCalled();
    expect(waha.startSession).not.toHaveBeenCalled();
    expect(db.escritas).toEqual([]);
  });

  it("sem auth não chega no banco nem no transporte", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const db = makeDb({ sessions: [canalQr({ archived_at: ARQUIVADO_EM })] });
    const waha = transporteOk();
    const { POST } = await import("@/app/api/v1/channel-sessions/[id]/reconnect/route");

    expect((await POST(req(), ctx())).status).toBe(401);
    expect(db.escritas).toEqual([]);
    expect(waha.startSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/onboarding/whatsapp/session — retomar o pareamento ressuscita", () => {
  const req = () =>
    new Request("http://localhost/api/v1/onboarding/whatsapp/session", { method: "POST", headers: { "Idempotency-Key": USER } });

  it("⭐ linha arquivada com o mesmo nome de sessão volta ATIVA após confirmar o transporte", async () => {
    authOk();
    const db = makeDb({
      sessions: [canalQr({ archived_at: ARQUIVADO_EM, status: "STOPPED" })],
    });
    const waha = transporteOk();
    const { POST } = await import("@/app/api/v1/onboarding/whatsapp/session/route");
    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(db.linhas[0]?.archived_at).toBeNull();
    expect(db.linhas[0]?.status).toBe("STARTING");
    // O número só se sabe depois do escaneamento — e o health check só preenche
    // o campo quando ele está vazio, então guardar o antigo o congelaria errado.
    expect(db.linhas[0]?.phone_number).toBeNull();
    expect(waha.startExistingSession).toHaveBeenCalledWith(NOME_SESSAO);
  });

  it("linha ATIVA é reaproveitada sem escrita nenhuma", async () => {
    authOk();
    const db = makeDb({ sessions: [canalQr()] });
    transporteOk();
    const { POST } = await import("@/app/api/v1/onboarding/whatsapp/session/route");
    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(db.escritas).toEqual([]);
    expect(db.linhas[0]?.phone_number).toBe("+5531999998888");
  });

  it("org sem linha nenhuma: cria a sessão do onboarding", async () => {
    authOk();
    const db = makeDb({ sessions: [] });
    transporteOk();
    const { POST } = await import("@/app/api/v1/onboarding/whatsapp/session/route");

    expect((await POST(req())).status).toBe(200);
    expect(db.escritas.map((e) => e.tipo)).toEqual(["insert"]);
  });
});

describe("GET /api/v1/channel-sessions/[id]/qr — o QR é o ato de religar", () => {
  const ctx = () => ({ params: Promise.resolve({ id: CANAL }) });
  const req = () => new Request(`http://localhost/api/v1/channel-sessions/${CANAL}/qr`);
  const fetchSpy = () => vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    process.env.WAHA_API_BASE_URL = "http://waha.local";
    process.env.WAHA_API_KEY = "chave-de-teste";
  });

  it("⭐ canal ARQUIVADO → 409 e o WAHA nem é consultado", async () => {
    authOk();
    makeDb({ sessions: [canalQr({ archived_at: ARQUIVADO_EM })] });
    const chamou = fetchSpy();
    const { GET } = await import("@/app/api/v1/channel-sessions/[id]/qr/route");
    const res = await GET(req(), ctx());

    // 409 e não 404: o canal ESTÁ na org — foi excluído.
    expect(res.status).toBe(409);
    expect(res.headers.get("x-channel-state")).toBe("archived");
    // O ponto do conserto: a recusa é NOSSA, não emprestada do 404 do WAHA.
    expect(chamou).not.toHaveBeenCalled();
    chamou.mockRestore();
  });

  it("canal ativo continua servindo o QR (a guarda não matou o pareamento)", async () => {
    authOk();
    makeDb({ sessions: [canalQr({ status: "SCAN_QR_CODE" })] });
    const chamou = fetchSpy().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const { GET } = await import("@/app/api/v1/channel-sessions/[id]/qr/route");
    const res = await GET(req(), ctx());

    expect(res.status).toBe(200);
    expect(chamou).toHaveBeenCalledWith(
      expect.stringContaining(`/api/${NOME_SESSAO}/auth/qr`),
      expect.anything(),
    );
    chamou.mockRestore();
  });

  it("⭐ canal OFICIAL → 409, sem pedir `/api/null/auth/qr` ao transporte", async () => {
    authOk();
    makeDb({ sessions: [canalOficial()] });
    const chamou = fetchSpy();
    const { GET } = await import("@/app/api/v1/channel-sessions/[id]/qr/route");
    const res = await GET(req(), ctx());

    // Ele não tem QR por natureza — e o 404 que o transporte devolveria para
    // `null` é indistinguível de "o QR ainda não ficou pronto", que é o estado
    // em que a tela fica insistindo.
    expect(res.status).toBe(409);
    expect(res.headers.get("x-channel-state")).toBe("no-session");
    expect(chamou).not.toHaveBeenCalled();
    chamou.mockRestore();
  });

  it("clone sem a migration 0106: o QR continua aparecendo", async () => {
    authOk();
    makeDb({ sessions: [canalQr()], semColunaArquivada: true });
    const chamou = fetchSpy().mockResolvedValue(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const { GET } = await import("@/app/api/v1/channel-sessions/[id]/qr/route");

    expect((await GET(req(), ctx())).status).toBe(200);
    expect(chamou).toHaveBeenCalled();
    chamou.mockRestore();
  });
});

/**
 * ⭐ OS DOIS CAMINHOS DE VOLTA, NA MESMA RÉGUA.
 *
 * `channel.reactivated` nasceu com o texto "reconexão do canal oficial, retomada
 * do pareamento" — e por um tempo valeu só para o primeiro: o oficial auditava
 * porque o handler lembrou, o onboarding ressuscitava calado. Um caso por rota
 * não pega isso; a régua precisa ser a MESMA lista percorrida duas vezes, senão
 * o caminho que ninguém escreveu continua sendo o que ninguém cobre.
 *
 * A tabela é a fonte: caminho novo que ressuscite entra aqui, e enquanto não
 * entrar, quem apagar a auditoria de QUALQUER um dos dois vê vermelho.
 */
describe("toda ressurreição é auditada — nenhuma nasce muda", () => {
  const CAMINHOS = [
    {
      nome: "conectar o canal oficial",
      arquivado: () => canalOficial({ archived_at: ARQUIVADO_EM }),
      vivo: () => canalOficial({ status: "WORKING" }),
      chamar: async () => {
        const { POST } = await import("@/app/api/v1/channels/official/route");
        return POST(reqOficial());
      },
    },
    {
      nome: "retomar o pareamento pelo onboarding",
      arquivado: () => canalQr({ archived_at: ARQUIVADO_EM, status: "STOPPED" }),
      vivo: () => canalQr(),
      chamar: async () => {
        const { POST } = await import("@/app/api/v1/onboarding/whatsapp/session/route");
        return POST(
          new Request("http://localhost/api/v1/onboarding/whatsapp/session", { method: "POST", headers: { "Idempotency-Key": USER } }),
        );
      },
    },
  ];

  it.each(CAMINHOS)("$nome registra channel.reactivated com ator e canal", async (caminho) => {
    authOk();
    const db = makeDb({ sessions: [caminho.arquivado()] });
    transporteOk();

    const res = await caminho.chamar();

    // Não-vacuidade: o evento só vale se a linha REALMENTE voltou — auditoria
    // sobre uma volta que não aconteceu seria o defeito ao contrário.
    expect(res.status).toBe(200);
    expect(db.linhas[0]?.archived_at).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.reactivated",
        organizationId: ORG,
        actorUserId: USER,
        resourceType: "channel_session",
        resourceId: CANAL,
      }),
    );
  });

  it.each(CAMINHOS)("$nome não emite evento sobre canal que já estava vivo", async (caminho) => {
    authOk();
    makeDb({ sessions: [caminho.vivo()] });
    transporteOk();

    expect((await caminho.chamar()).status).toBe(200);
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.reactivated" }),
    );
  });
});

describe("reactivateChannelSession — o desarquivamento mora num lugar só", () => {
  const ator = { userId: USER, requestId: "req-1" };

  it("desarquiva no MESMO update que aplica o patch (sem janela de estado misto)", async () => {
    const db = makeDb({ sessions: [canalQr({ archived_at: ARQUIVADO_EM })] });
    const client = await createClient();
    const r = await reactivateChannelSession(
      client,
      { organizationId: ORG, channelSessionId: CANAL, archivedAt: ARQUIVADO_EM },
      { status: "WORKING" },
      ator,
    );

    expect(r.error).toBeNull();
    expect(r.reactivated).toBe(true);
    expect(db.escritas).toHaveLength(1);
    expect(patchDe(db, 0)).toEqual({ status: "WORKING", archived_at: null });
    expect(db.linhas[0]?.archived_at).toBeNull();
  });

  it("filtra por organização E por id — o admin não dispensa a tenancy", async () => {
    const db = makeDb({
      sessions: [canalQr({ organization_id: "outra-org", archived_at: ARQUIVADO_EM })],
    });
    const client = await createClient();
    await reactivateChannelSession(
      client,
      { organizationId: ORG, channelSessionId: CANAL, archivedAt: ARQUIVADO_EM },
      { status: "WORKING" },
      ator,
    );

    expect(db.linhas[0]?.archived_at).toBe(ARQUIVADO_EM);
  });

  it("banco sem a coluna: repete sem ela e avisa que o schema está velho", async () => {
    const db = makeDb({ sessions: [canalQr()], semColunaArquivada: true });
    const client = await createClient();
    const r = await reactivateChannelSession(
      client,
      // Clone sem a 0100: o chamador leu pelo fallback e não tem o estado
      // anterior. Nada está arquivado lá, então nada ressuscita — e o evento
      // que não descreve nada não é emitido.
      { organizationId: ORG, channelSessionId: CANAL, archivedAt: undefined },
      { status: "WORKING" },
      ator,
    );

    expect(r.error).toBeNull();
    expect(r.schemaOutdated).toBe(true);
    expect(r.reactivated).toBe(false);
    expect(db.linhas[0]?.status).toBe("WORKING");
    expect(audit).not.toHaveBeenCalled();
  });

  /**
   * ⭐ Auditoria de uma volta que o banco NEGOU seria pior que auditoria
   * nenhuma: quem investiga um canal mudo acharia o momento em que ele "voltou"
   * e pararia de procurar.
   */
  it("erro que NÃO é coluna ausente sobe — não vira sucesso silencioso nem evento", async () => {
    makeDb({
      sessions: [canalQr({ archived_at: ARQUIVADO_EM })],
      writeError: () => ({ code: "42501", message: "permission denied" }),
    });
    const client = await createClient();
    const r = await reactivateChannelSession(
      client,
      { organizationId: ORG, channelSessionId: CANAL, archivedAt: ARQUIVADO_EM },
      { status: "WORKING" },
      ator,
    );

    expect(r.error?.code).toBe("42501");
    expect(r.reactivated).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });
});

/**
 * A última resolução operacional que ainda enxergava canal excluído.
 *
 * O GET desta mesma rota já filtrava (a tela some com a conexão excluída), e o
 * PUT continuava aceitando gravar teto diário e knobs de anti-ban nela. O
 * desfecho não é só inútil: é configuração viva pendurada num canal que não
 * envia mais, esperando confundir quem for investigar o próximo envio que não
 * saiu — e, se o canal um dia voltar, os limites de outra época voltam com ele.
 */
describe("PUT /api/v1/ai/pacing — knobs não se gravam em canal excluído", () => {
  const put = (corpo: Record<string, unknown>) =>
    new NextRequest("http://localhost/api/v1/ai/pacing", {
      method: "PUT",
      body: JSON.stringify({ channel_session_id: CANAL, ...corpo }),
      headers: { "content-type": "application/json" },
    });

  it("⭐ canal ARQUIVADO → 404 e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({
      sessions: [canalQr({ archived_at: ARQUIVADO_EM, daily_message_limit: 250 })],
    });
    const { PUT } = await import("@/app/api/v1/ai/pacing/route");
    const res = await PUT(put({ daily_message_limit: 300 }));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("session_not_found");
    expect(db.escritas).toEqual([]);
    expect(db.linhas[0]?.daily_message_limit).toBe(250);
  });

  it("canal ATIVO continua salvando (a guarda não matou a tela de anti-ban)", async () => {
    authOk();
    const db = makeDb({ sessions: [canalQr({ daily_message_limit: 250 })] });
    const { PUT } = await import("@/app/api/v1/ai/pacing/route");
    const res = await PUT(put({ daily_message_limit: 300 }));

    expect(res.status).toBe(200);
    expect(db.linhas[0]?.daily_message_limit).toBe(300);
  });
});

describe("metaSessionForOrg — a tela de templates não fala por um canal excluído", () => {
  const WABA = "waba-123";

  it("⭐ canal oficial ARQUIVADO não é a sessão oficial da org", async () => {
    makeDb({ sessions: [canalOficial({ archived_at: ARQUIVADO_EM, meta_waba_id: WABA })] });
    const { metaSessionForOrg } = await import("@/lib/channels/meta/session");
    // Sem isto a tela seguia nomeando a WABA do canal excluído e o botão de
    // sincronizar continuava puxando templates dela: o token do env não foi
    // revogado junto com o da linha, então a chamada ia mesmo.
    expect(await metaSessionForOrg(ORG)).toBeNull();
  });

  it("canal oficial ativo continua sendo a sessão da org", async () => {
    makeDb({ sessions: [canalOficial({ meta_waba_id: WABA })] });
    const { metaSessionForOrg } = await import("@/lib/channels/meta/session");
    expect(await metaSessionForOrg(ORG)).toMatchObject({ id: CANAL, wabaId: WABA });
  });

  it("clone sem a migration 0106: continua achando a sessão (nada está arquivado lá)", async () => {
    makeDb({ sessions: [canalOficial({ meta_waba_id: WABA })], semColunaArquivada: true });
    const { metaSessionForOrg } = await import("@/lib/channels/meta/session");
    expect(await metaSessionForOrg(ORG)).toMatchObject({ id: CANAL, wabaId: WABA });
  });
});

/**
 * A PORTA DE ENTRADA da plataforma, e a única das irmãs que ninguém guardava.
 *
 * `metaSessionByWebhookToken` é quem decide se uma entrega da Meta vira contato,
 * conversa e mensagem. O filtro de arquivado existe nela desde a etapa anterior —
 * e a suíte inteira (1972 casos) passava com ele apagado. Filtro sem teste é
 * filtro que o próximo "cleanup" leva, e a perda é silenciosa: mensagem entrando
 * num canal que o operador excluiu, num inbox onde ele nem consegue responder.
 *
 * A rotação do `webhook_path_token` no arquivamento mata a URL ANTIGA; o que
 * impede a URL NOVA (que está na própria linha arquivada) de funcionar é este
 * filtro, e mais nada.
 */
describe("metaSessionByWebhookToken — a entrega da plataforma para no canal excluído", () => {
  const TOKEN = "tok-de-webhook-longo";

  it("⭐ canal oficial ARQUIVADO: o token não resolve sessão nenhuma", async () => {
    makeDb({
      sessions: [canalOficial({ archived_at: ARQUIVADO_EM, webhook_path_token: TOKEN })],
    });
    const { metaSessionByWebhookToken } = await import("@/lib/channels/meta/session");
    expect(await metaSessionByWebhookToken(TOKEN)).toBeNull();
  });

  it("canal oficial ativo: o token resolve (a guarda não fechou a porta boa)", async () => {
    makeDb({ sessions: [canalOficial({ webhook_path_token: TOKEN, meta_waba_id: "waba-9" })] });
    const { metaSessionByWebhookToken } = await import("@/lib/channels/meta/session");
    expect(await metaSessionByWebhookToken(TOKEN)).toMatchObject({ id: CANAL, wabaId: "waba-9" });
  });

  it("clone sem a migration 0106: a entrega continua chegando", async () => {
    makeDb({
      sessions: [canalOficial({ webhook_path_token: TOKEN })],
      semColunaArquivada: true,
    });
    const { metaSessionByWebhookToken } = await import("@/lib/channels/meta/session");
    expect(await metaSessionByWebhookToken(TOKEN)).toMatchObject({ id: CANAL });
  });
});
