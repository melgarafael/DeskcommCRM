/**
 * `/app/companies` com a camada POR EMPRESA (#4871, F2 do #3868).
 *
 * Mesmas combinações de `empresa-desligada-fecha-configuracoes-de-propostas`,
 * para o outro módulo da fatia (`crm_b2b`): o layout só consultava a instalação
 * e agora passa a organização do request. O dublê de banco aplica os filtros de
 * verdade, então o `.eq("organization_id", …)` ausente é o que fica vermelho.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAVE_DO_MODULO } from "@/lib/instalacao/modulos";
import { bancoDeDuasEmpresas } from "@/tests/helpers/postgrest-de-duas-empresas";

const ORG_A = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  banco: { cliente: {} as unknown },
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  activeOrg: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({ id: "u-1" })),
  resolveActiveOrg: mocks.activeOrg,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.banco.cliente }));

import Layout from "@/app/app/companies/layout";

function mundo(opcoes: { instalacaoLigada: boolean; linhaDaEmpresa?: "ligado" | "desligado" }) {
  const banco = bancoDeDuasEmpresas({
    platform_config: opcoes.instalacaoLigada
      ? [{ chave: CHAVE_DO_MODULO.crm_b2b, valor: "ligado" }]
      : [{ chave: CHAVE_DO_MODULO.crm_b2b, valor: "desligado" }],
    organization_modules:
      opcoes.linhaDaEmpresa === undefined
        ? []
        : [{ organization_id: ORG_A, modulo: "crm_b2b", estado: opcoes.linhaDaEmpresa }],
  });
  mocks.banco.cliente = banco.cliente;
  return banco;
}

describe("a tela de Empresas consulta a empresa, não só a instalação", () => {
  beforeEach(() => {
    mocks.notFound.mockClear();
    mocks.activeOrg.mockReset();
    mocks.activeOrg.mockResolvedValue({ orgId: ORG_A, role: "admin" });
  });

  it("instalação ligada + empresa desligada: 404, e a recusa leu a linha DA empresa", async () => {
    const banco = mundo({ instalacaoLigada: true, linhaDaEmpresa: "desligado" });

    await expect(Layout({ children: "tela" })).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mocks.notFound).toHaveBeenCalled();
    expect(banco.chamadas.some((c) => c.tabela === "organization_modules" && c.filtros.some(([col, v]) => col === "organization_id" && v === ORG_A))).toBe(true);
  });

  it("instalação ligada + empresa ligada: a tela existe", async () => {
    mundo({ instalacaoLigada: true, linhaDaEmpresa: "ligado" });
    const r = await Layout({ children: "tela" });
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(r).toBe("tela");
  });

  it("instalação ligada + empresa sem linha: herda a instalação (controle)", async () => {
    mundo({ instalacaoLigada: true });
    await Layout({ children: "tela" });
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("instalação DESLIGADA + empresa ligada: 404 — a instalação continua sendo o teto", async () => {
    mundo({ instalacaoLigada: false, linhaDaEmpresa: "ligado" });
    await expect(Layout({ children: "tela" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalled();
  });
});
