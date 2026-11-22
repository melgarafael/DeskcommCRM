// @vitest-environment node
/**
 * POST /api/v1/imports — a PRÉVIA (A23, #4888).
 *
 * `previa=true` não grava NADA: nem o lote, nem linha. Sem `previa`, o servidor
 * classifica de novo e passa o veredito para o processador, que grava só as `nova`.
 * Só as fronteiras (autenticação, leitura da base, processador) são dubladas;
 * multipart e CSV são reais.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Previa from "@/lib/crm-b2b/import-previa";
import type * as RouteHelpers from "@/lib/crm-b2b/route-helpers";
import type { LinhaClassificada } from "@/lib/crm-b2b/import-previa";

const h = vi.hoisted(() => ({
  from: vi.fn(),
  classificadas: [] as LinhaClassificada[],
  processar: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/crm-b2b/route-helpers", async (original) => ({
  ...(await original<typeof RouteHelpers>()),
  seModuloB2bDesligado: vi.fn(async () => null),
}));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(async () => ({
    ok: true,
    supabase: { from: h.from },
    organizationId: "22222222-2222-4222-8222-222222222222",
    actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
    apiTokenId: null,
    idioma: "pt-BR",
  })),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/crm-b2b/import-previa", async (original) => ({
  ...(await original<typeof Previa>()),
  previaDaImportacao: vi.fn(async () => h.classificadas),
}));
vi.mock("@/lib/crm-b2b/import-process", () => ({
  processCompaniesPeopleImport: (...args: unknown[]) => h.processar(...args),
}));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(async () => new Map([["u-dono", "Carla Dono"]])),
}));

import { POST } from "./route";

const CSV = "Pessoa,Telefone,Email\nAna,11988887777,ana@x.com\nBia,11977776666,bia@x.com\nCida,,cida@x.com\n";

function pedido(extra: Record<string, string> = {}): Request {
  const form = new FormData();
  form.set("file", new File([CSV], "lista.csv", { type: "text/csv" }));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new Request("https://crm.exemplo/api/v1/imports", { method: "POST", body: form });
}

beforeEach(() => {
  h.from.mockReset();
  h.processar.mockReset();
  h.processar.mockResolvedValue({ successful_rows: 1, failed_rows: 1, conflict_rows: 1, processed_rows: 3 });
  h.classificadas = [
    { rowNumber: 2, status: "nova", motivo: null },
    {
      rowNumber: 3,
      status: "ja_existe",
      motivo: "Já existe um contato com este celular ou e-mail.",
      existente: { tipo: "contato", id: "c1", nome: "Bia Antiga", donoId: "u-dono" },
    },
    { rowNumber: 4, status: "sem_telefone", motivo: "Linha sem telefone: não entra na importação." },
  ];
});

describe("POST /api/v1/imports com previa=true: linha anexada", () => {
  it("conta as anexadas à parte e NÃO as põe no CSV de fora (elas entram)", async () => {
    h.classificadas = [
      {
        rowNumber: 2,
        status: "anexada",
        motivo: "Empresa já cadastrada com este CNPJ.",
        existente: { tipo: "empresa", id: "e1", nome: "Acme", donoId: null },
      },
      { rowNumber: 3, status: "sem_telefone", motivo: "Linha sem telefone: não entra na importação." },
    ];
    const res = await POST(pedido({ previa: "true" }) as never);
    const corpo = (await res.json()) as {
      data: { previa: Record<string, number>; linhas_fora: Array<{ linha: number; status: string }> };
    };
    expect(corpo.data.previa).toMatchObject({ anexadas: 1, sem_telefone: 1, novas: 0 });
    expect(corpo.data.linhas_fora.map((l) => [l.linha, l.status])).toEqual([[3, "sem_telefone"]]);
  });
});

describe("POST /api/v1/imports com previa=true", () => {
  it("devolve os totais e as linhas de fora (com de quem é) e NÃO grava nada", async () => {
    const res = await POST(pedido({ previa: "true" }) as never);
    const corpo = (await res.json()) as {
      data: {
        previa: Record<string, number>;
        headers: string[];
        linhas_fora: Array<{ linha: number; status: string; de_quem: string | null; existente_nome: string | null; valores: string[] }>;
      };
    };

    expect(res.status).toBe(200);
    expect(corpo.data.previa).toMatchObject({ total: 3, novas: 1, ja_existem: 1, sem_telefone: 1 });
    expect(corpo.data.headers).toEqual(["Pessoa", "Telefone", "Email"]);
    expect(corpo.data.linhas_fora.map((l) => [l.linha, l.status])).toEqual([
      [3, "ja_existe"],
      [4, "sem_telefone"],
    ]);
    expect(corpo.data.linhas_fora[0]).toMatchObject({
      existente_nome: "Bia Antiga",
      de_quem: "Carla Dono",
      valores: ["Bia", "11977776666", "bia@x.com"],
    });

    // A prova do "não grava": nenhuma tabela foi tocada e o processador nem rodou.
    expect(h.from).not.toHaveBeenCalled();
    expect(h.processar).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/imports sem previa", () => {
  it("cria o lote e passa o veredito ao processador, que grava só as novas", async () => {
    h.from.mockReturnValue({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "lote-1" }, error: null }) }) }),
    });

    const res = await POST(pedido() as never);

    expect(res.status).toBe(201);
    expect(h.from).toHaveBeenCalledWith("import_batches");
    const opcoes = h.processar.mock.calls[0]?.[1] as { classificacao: Map<number, LinhaClassificada> };
    expect([...opcoes.classificacao.keys()]).toEqual([2, 3, 4]);
    expect(opcoes.classificacao.get(3)?.status).toBe("ja_existe");
  });
});
