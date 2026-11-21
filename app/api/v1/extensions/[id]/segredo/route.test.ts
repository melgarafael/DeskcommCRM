import { randomBytes, randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Girar o segredo de um módulo `connected` (spec 33, F2, tarefa 4 e emenda 3).
 *
 * O que este arquivo prova, com o serviço REAL e só o banco substituído por um dublê que anota tudo o
 * que é gravado:
 * - o segredo em claro sai UMA vez, na resposta, com `Cache-Control: no-store`;
 * - o texto do segredo (nem o valor antigo) não aparece em NENHUMA gravação, auditoria, log ou RPC;
 * - girar revoga o token vivo de cada organização da instalação e de nenhuma outra;
 * - a assinatura feita com o segredo antigo reprova depois de girar e a do novo passa;
 * - só quem administra a instalação (sessão) gira; módulo declarativo, removido e sem chave de cifra
 *   recusam sem gravar nada.
 */

type Linha = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  env: { AI_CRED_AES_KEY: "" },
  admin: null as unknown,
  user: null as unknown,
  platform: null as unknown,
  suporte: null as unknown,
  audit: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        maybeSingle: () => Promise.resolve({ data: mocks.platform, error: null }),
      };
      return builder;
    },
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => mocks.user,
  mfaEmDividaEstrita: async () => false,
  sessionAal: async () => "aal2",
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => mocks.suporte }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit, auditForOrganizations: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: mocks.warn, error: mocks.error, info: vi.fn() },
}));

const CHAVE = randomBytes(32).toString("base64");
const ADMIN = randomUUID();
const INSTALACAO = randomUUID();
const OUTRA_INSTALACAO = randomUUID();
const ARTEFATO = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORG_C = randomUUID();

interface Cenario {
  profile?: string;
  removida?: boolean;
  semInstalacao?: boolean;
  segredoAtual?: string;
  upsertError?: boolean;
  revokeError?: boolean;
  tokens?: Array<{ organization_id: string; extension_installation_id: string; revoked_at: string | null }>;
}

function banco(cenario: Cenario, cifrar: (segredo: string) => string) {
  const upserts: Array<{ table: string; row: Linha; options: Linha | undefined }> = [];
  const gravacoes: unknown[] = [];
  const rpcs: Array<{ name: string; args: Linha }> = [];
  const filtrosDeTokens: Array<Array<[string, unknown]>> = [];
  const segredos = new Map<string, Linha>();
  if (cenario.segredoAtual) {
    segredos.set(INSTALACAO, { installation_id: INSTALACAO, ciphertext: cifrar(cenario.segredoAtual) });
  }
  const tokens = cenario.tokens ?? [];
  return {
    upserts,
    gravacoes,
    rpcs,
    filtrosDeTokens,
    segredos,
    from(table: string) {
      const filtros: Array<[string, unknown]> = [];
      const builder = {
        select: () => builder,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return builder;
        },
        is: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          filtrosDeTokens.push(filtros);
          const dados = tokens.filter(
            (token) =>
              filtros.every(([c, v]) => c === "revoked_at" || (token as Linha)[c] === v) &&
              token.revoked_at === null,
          );
          return Promise.resolve({ data: dados, error: null });
        },
        maybeSingle: () => {
          if (table === "extension_installations") {
            return Promise.resolve({
              data: cenario.semInstalacao
                ? null
                : {
                    id: INSTALACAO,
                    artifact_id: ARTEFATO,
                    removed_at: cenario.removida ? "2026-11-01T00:00:00.000Z" : null,
                  },
              error: null,
            });
          }
          if (table === "extension_artifacts") {
            return Promise.resolve({
              data: { manifest: { profile: cenario.profile ?? "connected" } },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        upsert: (row: Linha, options?: Linha) => {
          upserts.push({ table, row, options });
          gravacoes.push({ table, row, options });
          if (cenario.upsertError) {
            return Promise.resolve({ data: null, error: { code: "XX000", message: "falhou" } });
          }
          segredos.set(String(row.installation_id), row);
          return Promise.resolve({ data: null, error: null });
        },
        insert: (row: Linha) => {
          gravacoes.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        update: (row: Linha) => {
          gravacoes.push({ table, row });
          return builder;
        },
      };
      return builder;
    },
    rpc(name: string, args: Linha) {
      rpcs.push({ name, args });
      return Promise.resolve(
        cenario.revokeError ? { data: null, error: { code: "XX000", message: "falhou" } } : { data: null, error: null },
      );
    },
  };
}

type Rota = typeof import("./route");
type Modulo = typeof import("@/lib/extensions/segredo-do-modulo");

async function carregar(chave: string): Promise<{ rota: Rota; seg: Modulo }> {
  mocks.env.AI_CRED_AES_KEY = chave;
  vi.resetModules();
  return { rota: await import("./route"), seg: await import("@/lib/extensions/segredo-do-modulo") };
}

function pedido(headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/v1/extensions/${INSTALACAO}/segredo`, {
    method: "POST",
    headers,
  });
}
const contexto = { params: Promise.resolve({ id: INSTALACAO }) };

function usuario(overrides: Linha = {}) {
  return { id: ADMIN, email: "a@b.c", is_platform_admin: true, support: null, idioma: "pt-BR", ...overrides };
}

async function girar(cenario: Cenario = {}, chave = CHAVE) {
  const { rota, seg } = await carregar(chave);
  const db = banco(cenario, (s) => (chave ? seg.cifrarSegredo(s) : s));
  mocks.admin = db;
  const res = await rota.POST(pedido(), contexto);
  return { res, db, seg, corpo: (await res.json()) as { data?: { secret: string; rotated_at: string }; error?: { code: string; message: string } } };
}

/** Tudo o que o dublê viu sair do servidor, numa string só, para procurar um texto que não pode estar lá. */
function tudoQueFoiGravado(db: ReturnType<typeof banco>): string {
  return JSON.stringify({
    gravacoes: db.gravacoes,
    rpcs: db.rpcs,
    audit: mocks.audit.mock.calls,
    warn: mocks.warn.mock.calls,
    error: mocks.error.mock.calls,
  });
}

beforeEach(() => {
  mocks.user = usuario();
  mocks.platform = { scope: "full", mfa_required: false };
  mocks.suporte = null;
  mocks.audit.mockReset();
  mocks.warn.mockReset();
  mocks.error.mockReset();
});

describe("POST /api/v1/extensions/[id]/segredo", () => {
  it("devolve o segredo uma vez, com Cache-Control no-store, e o guarda cifrado", async () => {
    const { res, db, seg, corpo } = await girar({ segredoAtual: "segredo-antigo" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(corpo.data?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(corpo.data?.rotated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(db.upserts).toHaveLength(1);
    const gravado = db.upserts[0]!;
    expect(gravado.table).toBe("extension_installation_secrets");
    expect(gravado.options).toMatchObject({ onConflict: "installation_id" });
    expect(gravado.row).toMatchObject({ installation_id: INSTALACAO, rotated_by: ADMIN });
    expect(gravado.row.rotated_at).toBe(corpo.data?.rotated_at);
    expect(seg.decifrarSegredo(String(gravado.row.ciphertext))).toBe(corpo.data?.secret);
  });

  it("o segredo não aparece em nenhuma gravação, RPC, auditoria ou log (nem o antigo, nem o cifrado em claro)", async () => {
    const { db, corpo } = await girar({
      segredoAtual: "segredo-antigo-que-nao-pode-vazar",
      tokens: [{ organization_id: ORG_A, extension_installation_id: INSTALACAO, revoked_at: null }],
    });
    const segredo = corpo.data!.secret;
    const sai = tudoQueFoiGravado(db);

    expect(sai).not.toContain(segredo);
    expect(sai).not.toContain("segredo-antigo-que-nao-pode-vazar");
    // O que vai ao banco é o texto cifrado, não o segredo; o corpo da resposta é a única exibição.
    expect(String(db.upserts[0]!.row.ciphertext)).not.toContain(segredo);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]![0]).toMatchObject({
      action: "extension.secret_rotated",
      actorUserId: ADMIN,
      resourceType: "extension_installation",
      resourceId: INSTALACAO,
    });
  });

  it("revoga o token vivo de cada organização da instalação e de nenhuma outra", async () => {
    const { res, db } = await girar({
      tokens: [
        { organization_id: ORG_A, extension_installation_id: INSTALACAO, revoked_at: null },
        { organization_id: ORG_B, extension_installation_id: INSTALACAO, revoked_at: null },
        // Token já revogado da mesma instalação: não conta.
        { organization_id: ORG_C, extension_installation_id: INSTALACAO, revoked_at: "2026-11-01T00:00:00Z" },
        // Token vivo de OUTRA instalação na ORG_C: não pode ser tocado.
        { organization_id: ORG_C, extension_installation_id: OUTRA_INSTALACAO, revoked_at: null },
      ],
    });

    expect(res.status).toBe(200);
    expect(db.rpcs.map((chamada) => chamada.name)).toEqual([
      "fn_extensions_module_token_revoke",
      "fn_extensions_module_token_revoke",
    ]);
    expect(db.rpcs.map((chamada) => chamada.args.p_organization).sort()).toEqual([ORG_A, ORG_B].sort());
    for (const chamada of db.rpcs) {
      expect(chamada.args).toMatchObject({ p_installation: INSTALACAO, p_by: ADMIN });
    }
    // A consulta filtrou pela instalação e pelos tokens vivos.
    expect(db.filtrosDeTokens[0]).toEqual([
      ["extension_installation_id", INSTALACAO],
      ["revoked_at", null],
    ]);
    expect(mocks.audit.mock.calls[0]![0].metadata).toEqual({ organizations_revoked_count: 2 });
  });

  it("sem token vivo, não chama revoke", async () => {
    const { res, db } = await girar({ tokens: [] });
    expect(res.status).toBe(200);
    expect(db.rpcs).toEqual([]);
  });

  it("a assinatura feita com o segredo antigo reprova depois de girar e a do novo passa", async () => {
    const antigo = "segredo-antigo-do-modulo";
    const { db, seg, corpo } = await girar({ segredoAtual: antigo });
    const entrada = { organizationId: ORG_A, timestamp: Date.now(), nonce: "n-1" };

    // O host verifica contra o que está guardado agora.
    const guardado = seg.decifrarSegredo(String(db.segredos.get(INSTALACAO)!.ciphertext));
    expect(guardado).toBe(corpo.data!.secret);
    expect(seg.verificarAssinatura(guardado, entrada, seg.assinar(antigo, entrada))).toBe(false);
    expect(seg.verificarAssinatura(guardado, entrada, seg.assinar(corpo.data!.secret, entrada))).toBe(true);
  });

  it("repetir o pedido gera OUTRO segredo (não há recibo nem Idempotency-Key)", async () => {
    const primeiro = await girar();
    const segundo = await girar();
    expect(primeiro.corpo.data!.secret).not.toBe(segundo.corpo.data!.secret);
    expect(primeiro.db.gravacoes.every((g) => (g as { table: string }).table !== "extension_operations")).toBe(true);
  });

  it.each([
    ["viewer", { is_platform_admin: false }],
    ["agent", { is_platform_admin: false }],
    ["manager", { is_platform_admin: false }],
  ])("%s da organização recebe 403 e nada é gravado", async (_papel, overrides) => {
    mocks.user = usuario(overrides);
    const { res, db, corpo } = await girar();
    expect(res.status).toBe(403);
    expect(corpo.error?.code).toBe("forbidden");
    expect(db.gravacoes).toEqual([]);
    expect(db.rpcs).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("administrador de plataforma só-leitura (support_readonly) recebe 403", async () => {
    mocks.platform = { scope: "support_readonly", mfa_required: false };
    const { res, db } = await girar();
    expect(res.status).toBe(403);
    expect(db.gravacoes).toEqual([]);
  });

  it("acompanhamento administrativo em modo leitura é barrado antes do efeito", async () => {
    mocks.suporte = new Response(JSON.stringify({ error: { code: "support_readonly" } }), { status: 403 });
    const { res, db } = await girar();
    expect(res.status).toBe(403);
    expect(db.gravacoes).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("módulo declarativo recebe 409 estável e nada é gravado", async () => {
    const { res, db, corpo } = await girar({ profile: "declarative" });
    expect(res.status).toBe(409);
    expect(corpo.error?.code).toBe("extension_secret_not_applicable");
    expect(db.gravacoes).toEqual([]);
    expect(db.rpcs).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("instalação removida recebe 410 e inexistente recebe 404", async () => {
    const removida = await girar({ removida: true });
    expect(removida.res.status).toBe(410);
    expect(removida.corpo.error?.code).toBe("extension_removed");
    expect(removida.db.gravacoes).toEqual([]);

    const inexistente = await girar({ semInstalacao: true });
    expect(inexistente.res.status).toBe(404);
    expect(inexistente.corpo.error?.code).toBe("extension_installation_not_found");
    expect(inexistente.db.gravacoes).toEqual([]);
  });

  it("sem cookie de sessão recebe 401, mesmo com Bearer", async () => {
    mocks.user = null;
    const { rota } = await carregar(CHAVE);
    const db = banco({}, (s) => s);
    mocks.admin = db;
    const res = await rota.POST(pedido({ Authorization: "Bearer dsk_abcd1234_segredo" }), contexto);
    expect(res.status).toBe(401);
    expect(db.gravacoes).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("a rota é de sessão: não está em lib/auth/public-paths", async () => {
    const { isPublicPath } = await import("@/lib/auth/public-paths");
    expect(isPublicPath(`/api/v1/extensions/${INSTALACAO}/segredo`)).toBe(false);
  });

  it("sem chave de cifra: 503 extension_secret_key_missing e nada é gravado", async () => {
    const { res, db, corpo } = await girar({ tokens: [{ organization_id: ORG_A, extension_installation_id: INSTALACAO, revoked_at: null }] }, "");
    expect(res.status).toBe(503);
    expect(corpo.error?.code).toBe("extension_secret_key_missing");
    expect(corpo.error?.message).toContain("AI_CRED_AES_KEY");
    expect(db.gravacoes).toEqual([]);
    expect(db.rpcs).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("falha ao gravar o segredo: 503, sem revogar nada e sem devolver segredo", async () => {
    const { res, db, corpo } = await girar({
      upsertError: true,
      tokens: [{ organization_id: ORG_A, extension_installation_id: INSTALACAO, revoked_at: null }],
    });
    expect(res.status).toBe(503);
    expect(corpo.data).toBeUndefined();
    expect(db.rpcs).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("falha ao revogar: 503 sem devolver o segredo (repetir o pedido gira e revoga de novo)", async () => {
    const { res, corpo, db } = await girar({
      revokeError: true,
      tokens: [{ organization_id: ORG_A, extension_installation_id: INSTALACAO, revoked_at: null }],
    });
    expect(res.status).toBe(503);
    expect(corpo.data).toBeUndefined();
    expect(JSON.stringify(corpo)).not.toContain(String(db.upserts[0]!.row.ciphertext));
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("id que não é UUID recebe 404", async () => {
    const { rota } = await carregar(CHAVE);
    mocks.admin = banco({}, (s) => s);
    const res = await rota.POST(pedido(), { params: Promise.resolve({ id: "nao-e-uuid" }) });
    expect(res.status).toBe(404);
  });
});
