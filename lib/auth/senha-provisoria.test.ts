import { describe, expect, it } from "vitest";

import {
  CODIGO_SENHA_PROVISORIA,
  organizacoesComSenhaProvisoria,
  senhaProvisoriaPendente,
} from "@/lib/auth/senha-provisoria";
import type { AuthUser } from "@/lib/auth/types";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function usuario(orgs: Array<{ id: string; senha_provisoria?: boolean }>): Pick<AuthUser, "support" | "organizations"> {
  return {
    organizations: orgs.map((o) => ({
      organization_id: o.id,
      organization_name: "Org",
      role: "agent" as const,
      org_status: "active",
      senha_provisoria: o.senha_provisoria,
    })),
  };
}

/**
 * O sinal do primeiro acesso (#3876) na camada pura.
 *
 * O caso que MAIS importa aqui é o do CONVIDADO: quem entrou pelo fluxo antigo
 * não deve nada a ninguém, e a única coisa que separa os dois mundos é a coluna
 * do vínculo. Um `undefined` que virasse "obrigado" trancaria toda a base
 * existente na tela de troca de senha.
 */
describe("senhaProvisoriaPendente", () => {
  it("convidado (sem a marca) não é obrigado a trocar", () => {
    expect(senhaProvisoriaPendente(usuario([{ id: ORG_A }]), ORG_A)).toBe(false);
    expect(senhaProvisoriaPendente(usuario([{ id: ORG_A, senha_provisoria: false }]), ORG_A)).toBe(false);
  });

  it("criado pelo admin é obrigado a trocar na organização onde foi criado", () => {
    const u = usuario([{ id: ORG_A, senha_provisoria: true }]);
    expect(senhaProvisoriaPendente(u, ORG_A)).toBe(true);
    expect(senhaProvisoriaPendente(u, ORG_B)).toBe(false);
  });

  it("a obrigação é por vínculo: convite em outra empresa não contamina", () => {
    const u = usuario([
      { id: ORG_A, senha_provisoria: true },
      { id: ORG_B, senha_provisoria: false },
    ]);
    expect(senhaProvisoriaPendente(u, ORG_A)).toBe(true);
    expect(senhaProvisoriaPendente(u, ORG_B)).toBe(false);
    expect(organizacoesComSenhaProvisoria(u)).toEqual([ORG_A]);
  });

  it("sessão de acompanhamento nunca é gated", () => {
    const u = {
      ...usuario([{ id: ORG_A, senha_provisoria: true }]),
      // Sessão de acompanhamento: o formato completo mora em `SupportContext`;
      // aqui só importa que o campo exista.
      support: { status: "active" } as unknown as AuthUser["support"],
    };
    expect(senhaProvisoriaPendente(u, ORG_A)).toBe(false);
    expect(organizacoesComSenhaProvisoria(u)).toEqual([]);
  });

  it("o código da recusa é estável — a tela e o cliente dependem dele", () => {
    expect(CODIGO_SENHA_PROVISORIA).toBe("password_change_required");
  });
});
