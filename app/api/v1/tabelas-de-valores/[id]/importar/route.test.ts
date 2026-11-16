// @vitest-environment node
/**
 * A ROTA de importar com a mesma planilha duas vezes (#4612, prova do #4643).
 *
 * O invariante do banco chegava ao `repetida: true` chamando o store direto. Pela
 * rota, a segunda confirmação dos mesmos bytes caía antes, num 422 ("nenhuma
 * linha pode entrar"), porque a prévia de uma planilha já importada nunca tem
 * linha nova. Aqui o que está sob teste é a ordem das decisões da rota; leitura
 * de planilha, autenticação e banco são dublês.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  jaImportado: false,
  importar: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: async () => ({
    ok: true,
    via: "session",
    organizationId: "org-a",
    idioma: "pt-BR",
    actor: { type: "user", id: "user-a" },
  }),
  tetoDeEscritaDoToken: async () => null,
}));
vi.mock("@/lib/api/corpo-com-teto", () => ({
  lerCorpoComTeto: async (req: Request) => ({ ok: true, corpo: req }),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/planilha/ler-arquivo", () => ({
  IMPORT_MAX_BYTES: 2 * 1024 * 1024,
  isCsvFilename: (n: string) => n.endsWith(".csv"),
  isXlsxFilename: (n: string) => n.endsWith(".xlsx"),
  parseImportFile: async () => ({ ok: true, sheet: {} }),
}));
vi.mock("@/lib/tabela-de-valores/planilha", () => ({
  lerPlanilhaDaTabelaDeValores: () => ({ colunasIgnoradas: [] }),
}));
vi.mock("@/lib/tabela-de-valores/store", () => ({
  buscarTabelaDeValores: async () => ({ id: "tabela-1" }),
  // A prévia de uma planilha já importada: nenhuma linha nova.
  previaDaPlanilha: async () => ({
    entram: [],
    fora: [{ linha: 2, codigo: "P1", motivo: "ja_existe_na_tabela" }],
    resumo: { ja_existe_na_tabela: 1 },
    total_linhas: 1,
  }),
  arquivoJaImportado: async () => estado.jaImportado,
  importarTabelaDeValores: estado.importar,
}));

import { POST } from "./route";

function pedido(): import("next/server").NextRequest {
  const form = new FormData();
  form.set("file", new File(["codigo;descricao\nP1;Procedimento"], "tabela.csv", { type: "text/csv" }));
  return new Request("http://localhost/api/v1/tabelas-de-valores/tabela-1/importar", {
    method: "POST",
    body: form,
  }) as unknown as import("next/server").NextRequest;
}

const ctx = { params: Promise.resolve({ id: "tabela-1" }) } as never;

beforeEach(() => {
  estado.importar.mockReset();
  estado.importar.mockResolvedValue({
    tabela_id: "tabela-1",
    inseridos: 0,
    ja_existe: 1,
    repetida: true,
    fora: [],
    resumo: {},
    total_linhas: 1,
  });
});

describe("POST /tabelas-de-valores/[id]/importar — a mesma planilha de novo", () => {
  it("planilha já importada devolve repetida: true, e não um 422", async () => {
    estado.jaImportado = true;
    const r = await POST(pedido(), ctx);
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { repetida: boolean; inseridos: number } };
    expect(corpo.data.repetida).toBe(true);
    expect(corpo.data.inseridos).toBe(0);
    expect(estado.importar).toHaveBeenCalledTimes(1);
  });

  it("controle: planilha NOVA em que nada pode entrar continua recusada com 422, sem importar", async () => {
    estado.jaImportado = false;
    const r = await POST(pedido(), ctx);
    expect(r.status).toBe(422);
    expect(estado.importar).not.toHaveBeenCalled();
  });
});
