/**
 * As portas da lista de espera: módulo desligado não existe, prazos não têm padrão
 * e inscrição sem consentimento não entra.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  moduloLigado: vi.fn(),
  configDaEspera: vi.fn(),
  inscreverNaEspera: vi.fn(),
  tabelas: [] as string[],
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "u1" }, org: { orgId: "org-1", role: "manager" } }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: mock.moduloLigado }));
vi.mock("@/lib/agenda/encaixe-supabase", () => ({
  configDaEspera: mock.configDaEspera,
  inscreverNaEspera: mock.inscreverNaEspera,
}));
const cliente = {
  from: (tabela: string) => {
    mock.tabelas.push(tabela);
    throw new Error(`não devia consultar ${tabela}`);
  },
};
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => cliente }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => cliente }));

import { GET, PATCH, POST } from "./route";

const pedido = (corpo: unknown) =>
  new Request("http://teste/api/v1/agenda/lista-de-espera", { method: "POST", body: JSON.stringify(corpo) }) as never;

const INSCRICAO = {
  contact_id: "3f0a1d2e-6b7c-4d8e-9f01-23456789abcd",
  event_type_id: "4f0a1d2e-6b7c-4d8e-9f01-23456789abcd",
};

beforeEach(() => {
  vi.clearAllMocks();
  mock.tabelas.length = 0;
  mock.moduloLigado.mockResolvedValue(true);
  mock.configDaEspera.mockResolvedValue({ ativa: true });
});

describe("módulo desligado", () => {
  it("as três portas respondem 404 sem tocar em tabela nenhuma", async () => {
    mock.moduloLigado.mockResolvedValue(false);
    for (const resposta of [await GET(), await PATCH(pedido({})), await POST(pedido({}))]) {
      expect(resposta.status).toBe(404);
    }
    expect(mock.tabelas).toEqual([]);
  });
});

describe("os prazos não têm padrão", () => {
  it("ligar sem os três prazos é recusado", async () => {
    const r = await PATCH(pedido({ ativa: true, prazo_maximo_minutos: 60 }));
    expect(r.status).toBe(422);
    expect(mock.tabelas).toEqual([]);
  });
});

describe("a inscrição", () => {
  it("sem a organização ligada, não entra", async () => {
    mock.configDaEspera.mockResolvedValue(null);
    expect((await POST(pedido({ ...INSCRICAO, consentimento: true }))).status).toBe(409);
  });

  it("sem consentimento, não entra", async () => {
    expect((await POST(pedido(INSCRICAO))).status).toBe(422);
    expect((await POST(pedido({ ...INSCRICAO, consentimento: false }))).status).toBe(422);
    expect(mock.inscreverNaEspera).not.toHaveBeenCalled();
  });

  it("janela inválida é recusada na escrita", async () => {
    const janelas = [{ dia: 2, de: "09:00", ate: "12:00" }];
    expect((await POST(pedido({ ...INSCRICAO, consentimento: true, janelas }))).status).toBe(422);
  });
});
