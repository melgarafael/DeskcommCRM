import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: (v: unknown) => Buffer.from(String(v)),
  decryptKey: vi.fn(() => "senha-decifrada"),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { decryptKey } from "@/lib/crypto/aes_gcm";

import { carregarConexao } from "./credenciais";

const LINHA = {
  id: "conn-1",
  organization_id: "org-1",
  label: "Meu Postgres",
  host: "db.exemplo.com",
  port: 5432,
  database_name: "outro_crm",
  username: "leitor",
  password_encrypted: "\\xaa",
  password_iv: "\\xbb",
  password_tag: "\\xcc",
  ssl_mode: "require",
  enabled: true,
  max_rows: 800,
  max_filters: 40,
  max_response_bytes: 120000,
  updated_at: "2026-09-11T00:00:00.000Z",
};

/** Admin falso: registra os `.eq()` para provar o filtro por organização. */
function adminFalso(resultado: { data: unknown; error: unknown }) {
  const eq: Array<[string, unknown]> = [];
  const builder = {
    select: () => builder,
    eq: (coluna: string, valor: unknown) => {
      eq.push([coluna, valor]);
      return builder;
    },
    maybeSingle: async () => resultado,
  };
  const admin = { from: () => builder } as unknown as SupabaseClient;
  return { admin, eq };
}

describe("carregarConexao", () => {
  beforeEach(() => {
    vi.mocked(decryptKey).mockReset();
    vi.mocked(decryptKey).mockReturnValue("senha-decifrada");
  });

  it("filtra SEMPRE por organization_id e id — a lição da #236", async () => {
    const { admin, eq } = adminFalso({ data: LINHA, error: null });
    await carregarConexao(admin, "org-1", "conn-1");
    expect(eq).toEqual([
      ["organization_id", "org-1"],
      ["id", "conn-1"],
    ]);
  });

  it("devolve a conexão decifrada e usa o updated_at como versão do pool", async () => {
    const { admin } = adminFalso({ data: LINHA, error: null });
    await expect(carregarConexao(admin, "org-1", "conn-1")).resolves.toEqual({
      ok: true,
      conexao: {
        id: "conn-1",
        organizationId: "org-1",
        label: "Meu Postgres",
        host: "db.exemplo.com",
        port: 5432,
        database: "outro_crm",
        username: "leitor",
        password: "senha-decifrada",
        sslMode: "require",
        maxRows: 800,
        maxFilters: 40,
        maxResponseBytes: 120000,
        chaveDoCliente: null,
        versao: "2026-09-11T00:00:00.000Z",
      },
    });
  });

  it("a coluna que identifica o cliente só vale com o tipo junto", async () => {
    const com = adminFalso({
      data: { ...LINHA, customer_key_column: "telefone", customer_key_kind: "phone" },
      error: null,
    });
    const r = await carregarConexao(com.admin, "org-1", "conn-1");
    expect(r.ok && r.conexao.chaveDoCliente).toEqual({ coluna: "telefone", tipo: "phone" });

    const meia = adminFalso({ data: { ...LINHA, customer_key_column: "telefone" }, error: null });
    const r2 = await carregarConexao(meia.admin, "org-1", "conn-1");
    expect(r2.ok && r2.conexao.chaveDoCliente).toBeNull();
  });

  it("conexão inexistente", async () => {
    const { admin } = adminFalso({ data: null, error: null });
    await expect(carregarConexao(admin, "org-1", "x")).resolves.toEqual({
      ok: false,
      motivo: "nao_encontrada",
    });
  });

  it("conexão desativada não abre pool", async () => {
    const { admin } = adminFalso({ data: { ...LINHA, enabled: false }, error: null });
    await expect(carregarConexao(admin, "org-1", "x")).resolves.toEqual({
      ok: false,
      motivo: "desativada",
    });
  });

  it("erro de leitura vira `banco`, sem vazar detalhe do driver", async () => {
    const { admin } = adminFalso({ data: null, error: { message: "detalhe interno" } });
    await expect(carregarConexao(admin, "org-1", "x")).resolves.toEqual({
      ok: false,
      motivo: "banco",
    });
  });

  it("decrypt que falha (falta AI_CRED_AES_KEY) vira `cifra_indisponivel`", async () => {
    vi.mocked(decryptKey).mockImplementationOnce(() => {
      throw new Error("sem chave");
    });
    const { admin } = adminFalso({ data: LINHA, error: null });
    await expect(carregarConexao(admin, "org-1", "x")).resolves.toEqual({
      ok: false,
      motivo: "cifra_indisponivel",
    });
  });
});
