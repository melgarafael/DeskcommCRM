import { describe, expect, it } from "vitest";

import { senhaForteSchema } from "@/lib/auth/schemas";
import { gerarSenhaProvisoria, podeCriarPessoaComSenha } from "@/lib/auth/criar-pessoa-com-senha";

type Admin = Parameters<typeof podeCriarPessoaComSenha>[1];

const comEmpresas = (count: number | null, error: unknown = null) =>
  ({ from: () => ({ select: async () => ({ count, error }) }) }) as unknown as Admin;

const adminDeEmpresa = { is_platform_admin: false, platform_admin_scope: null };

describe("gerarSenhaProvisoria", () => {
  it("toda senha gerada passa pela régua da recuperação e não se repete", () => {
    const senhas = Array.from({ length: 500 }, gerarSenhaProvisoria);
    for (const s of senhas) {
      expect(senhaForteSchema.safeParse(s).success).toBe(true);
      expect(s).toMatch(/^[A-HJ-NP-Za-hj-km-np-z2-9]{4}(-[A-HJ-NP-Za-hj-km-np-z2-9]{4}){2}$/);
    }
    expect(new Set(senhas).size).toBe(senhas.length);
  });
});

describe("podeCriarPessoaComSenha (doc 310 A)", () => {
  it("admin de empresa: só numa instalação de uma empresa", async () => {
    expect(await podeCriarPessoaComSenha(adminDeEmpresa, comEmpresas(1))).toBe(true);
    expect(await podeCriarPessoaComSenha(adminDeEmpresa, comEmpresas(2))).toBe(false);
  });

  it("dono da instalação (scope full, fora de acompanhamento) com várias empresas", async () => {
    const dono = { is_platform_admin: true, platform_admin_scope: "full" as const };
    expect(await podeCriarPessoaComSenha(dono, comEmpresas(9))).toBe(true);
    expect(
      await podeCriarPessoaComSenha({ ...dono, support: { status: "active" } as never }, comEmpresas(9)),
    ).toBe(false);
    expect(
      await podeCriarPessoaComSenha({ ...dono, platform_admin_scope: "support_readonly" }, comEmpresas(9)),
    ).toBe(false);
  });

  it("leitura que falha fecha a porta", async () => {
    expect(await podeCriarPessoaComSenha(adminDeEmpresa, comEmpresas(null, { code: "XX000" }))).toBe(false);
  });
});
