import { randomBytes, randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  admin: null as unknown,
  audit: vi.fn(),
  warn: vi.fn(),
  env: { EXTENSIONS_LOCAL_CATALOG_ORIGIN: "", NEXT_PUBLIC_APP_URL: "http://localhost:3000", AI_CRED_AES_KEY: "" },
  profile: "connected" as string,
}));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit, auditForOrganizations: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), mfaEmDivida: vi.fn(), sessionAal: vi.fn() }));
// O download e a validação do pacote são outra unidade: aqui só importa o perfil do manifesto.
vi.mock("./download", () => ({
  assertCatalogOrigin: vi.fn(),
  assertServiceOrigin: vi.fn(),
  downloadArtifact: async () => new TextEncoder().encode('{"x":1}'),
}));
vi.mock("./manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest")>()),
  validateCatalogSnapshot: () => ({
    entries: [{ publisher: "acme", name: "ponte", version: "1.0.0", host_api: { min: 1, max: 2 }, permissions: [] }],
  }),
  validateArtifact: async () => ({ profile: mocks.profile, permissions: [] }),
  checkCompatibility: () => ({ compatible: true }),
}));

const CHAVE = randomBytes(32).toString("base64");
const ACTOR = randomUUID();
const CATALOG = randomUUID();
const INSTALACAO = randomUUID();
const OPERACAO = randomUUID();

function recibo(overrides: Row = {}): Row {
  return {
    id: OPERACAO,
    kind: "install",
    status: "completed",
    actor_id: ACTOR,
    organization_id: null,
    catalog_id: CATALOG,
    installation_id: INSTALACAO,
    publisher: "acme",
    name: "ponte",
    version: "1.0.0",
    entry: null,
    result: null,
    error_code: null,
    created_at: "2026-11-05T10:00:00.000Z",
    updated_at: "2026-11-05T10:00:00.000Z",
    ...overrides,
  };
}

function admin(opcoes: { upsertError?: { code: string; message: string } | "lanca" } = {}) {
  const rpcs: string[] = [];
  const upserts: Array<{ table: string; row: Row; options: Row }> = [];
  return {
    rpcs,
    upserts,
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: () =>
          Promise.resolve({
            data: {
              id: CATALOG,
              origin: "https://catalogo.example",
              revision: 1,
              digest: "a".repeat(64),
              snapshot: {},
              admitted_at: "2026-11-05T09:00:00.000Z",
            },
            error: null,
          }),
        upsert: (row: Row, options: Row) => {
          if (opcoes.upsertError === "lanca") throw new Error(`falha com ${String(row.ciphertext)}`);
          upserts.push({ table, row, options });
          return Promise.resolve({ error: opcoes.upsertError ?? null });
        },
      };
      return builder;
    },
    rpc(name: string) {
      rpcs.push(name);
      if (name === "fn_extensions_prepare_install") {
        return Promise.resolve({ data: recibo({ status: "preparing", installation_id: null, entry: {} }), error: null });
      }
      return Promise.resolve({ data: { ...recibo(), applied_now: true }, error: null });
    },
  };
}

const pedido = {
  catalog_id: CATALOG,
  publisher: "acme",
  name: "ponte",
  version: "1.0.0",
  expected_installation_revision: null,
};

beforeEach(() => {
  mocks.audit.mockReset();
  mocks.warn.mockReset();
  mocks.profile = "connected";
  mocks.env.AI_CRED_AES_KEY = CHAVE;
  vi.resetModules();
});

describe("instalar módulo connected: o segredo da instalação", () => {
  it("sem chave de cifra falha ANTES de gravar a instalação, com a frase em português", async () => {
    mocks.env.AI_CRED_AES_KEY = "";
    // O módulo é recarregado para a cifra não reaproveitar uma chave guardada em memória.
    const { installExtension: instalar } = await import("./service");
    const banco = admin();
    mocks.admin = banco;

    await expect(instalar(ACTOR, OPERACAO, pedido)).rejects.toMatchObject({
      code: "extension_secret_key_missing",
      status: 503,
      message: expect.stringContaining("chave de cifra"),
    });
    expect(banco.rpcs).toEqual(["fn_extensions_prepare_install"]);
    expect(banco.upserts).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("com a chave, grava a instalação e DEPOIS o segredo cifrado, com installation_id explícito", async () => {
    const { installExtension: instalar } = await import("./service");
    const banco = admin();
    mocks.admin = banco;

    const resultado = await instalar(ACTOR, OPERACAO, pedido);

    expect(banco.rpcs).toEqual(["fn_extensions_prepare_install", "fn_extensions_finish_install"]);
    expect(banco.upserts).toHaveLength(1);
    expect(banco.upserts[0]).toMatchObject({
      table: "extension_installation_secrets",
      row: { installation_id: INSTALACAO },
      options: { onConflict: "installation_id", ignoreDuplicates: true },
    });
    expect(String(banco.upserts[0]!.row.ciphertext)).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(resultado.secret_pending).toBeUndefined();
  });

  it("o segredo em claro não aparece no resultado, na auditoria nem no log", async () => {
    const { installExtension: instalar } = await import("./service");
    const { decifrarSegredo } = await import("./segredo-do-modulo");
    const banco = admin();
    mocks.admin = banco;

    const resultado = await instalar(ACTOR, OPERACAO, pedido);
    const segredo = decifrarSegredo(String(banco.upserts[0]!.row.ciphertext));

    expect(segredo).toHaveLength(43);
    for (const saida of [resultado, mocks.audit.mock.calls, mocks.warn.mock.calls]) {
      expect(JSON.stringify(saida)).not.toContain(segredo);
    }
  });

  it("se o segredo não for gravado, a instalação vale e o resultado diz que o segredo ainda não existe", async () => {
    const { installExtension: instalar } = await import("./service");
    mocks.admin = admin({ upsertError: { code: "42P01", message: "tabela com texto do banco" } });

    const resultado = await instalar(ACTOR, OPERACAO, pedido);

    expect(resultado).toMatchObject({ status: "completed", installation_id: INSTALACAO, secret_pending: true });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("texto do banco");
  });

  it("se gerar ou gravar lançar, o texto do erro (que poderia ter o segredo) não vai ao log", async () => {
    const { installExtension: instalar } = await import("./service");
    mocks.admin = admin({ upsertError: "lanca" });

    const resultado = await instalar(ACTOR, OPERACAO, pedido);

    expect(resultado.secret_pending).toBe(true);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("falha com");
  });

  it("módulo que não é connected não exige a chave nem grava segredo", async () => {
    mocks.profile = "declarative";
    mocks.env.AI_CRED_AES_KEY = "";
    const { installExtension: instalar } = await import("./service");
    const banco = admin();
    mocks.admin = banco;

    const resultado = await instalar(ACTOR, OPERACAO, pedido);

    expect(banco.rpcs).toContain("fn_extensions_finish_install");
    expect(banco.upserts).toEqual([]);
    expect(resultado.secret_pending).toBeUndefined();
  });
});
