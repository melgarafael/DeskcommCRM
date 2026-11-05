import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  servico: true,
  // Vínculos de `user_organizations`, inclusive o revogado: a regra não filtra `revoked_at`.
  vinculos: [] as Array<{ organization_id: string; user_id: string; revoked_at: string | null }>,
  erroVinculos: null as { message: string } | null,
  nomes: {} as Record<string, string>,
  consultas: [] as Array<{ tabela: string; eq: Record<string, unknown>; in: unknown[] }>,
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => m.servico }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.createAdminClient }));

import { nomesDosAtendentes } from "./nome-do-atendente";

const ORG = "org-a";
const OUTRA_ORG = "org-b";

function clienteDeServico() {
  return {
    from(tabela: string) {
      const consulta = { tabela, eq: {} as Record<string, unknown>, in: [] as unknown[] };
      m.consultas.push(consulta);
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => ((consulta.eq[col] = v), q),
        in: (col: string, vs: unknown[]) => {
          consulta.in = vs;
          if (m.erroVinculos) return Promise.resolve({ data: null, error: m.erroVinculos });
          const data = m.vinculos
            .filter((v) => v.organization_id === consulta.eq.organization_id && vs.includes(v.user_id))
            .map((v) => ({ user_id: v.user_id }));
          return Promise.resolve({ data, error: null });
        },
      };
      return q;
    },
    auth: {
      admin: {
        getUserById: vi.fn(async (id: string) => ({
          data: { user: { user_metadata: { full_name: m.nomes[id] } } },
          error: null,
        })),
      },
    },
  };
}

beforeEach(() => {
  m.servico = true;
  m.erroVinculos = null;
  m.consultas = [];
  m.nomes = { "u-ana": "Ana", "u-bia": "Bia", "u-caio": "Caio" };
  m.vinculos = [
    { organization_id: ORG, user_id: "u-ana", revoked_at: null },
    { organization_id: ORG, user_id: "u-bia", revoked_at: "2026-10-01T00:00:00Z" },
    { organization_id: OUTRA_ORG, user_id: "u-caio", revoked_at: null },
  ];
  m.createAdminClient.mockReset();
  m.createAdminClient.mockImplementation(clienteDeServico);
});

describe("nomesDosAtendentes — só membros da organização ganham nome", () => {
  it("membro e ex-membro ganham nome; id de outra organização não", async () => {
    const nomes = await nomesDosAtendentes(ORG, ["u-ana", "u-bia", "u-caio"]);
    expect(nomes.get("u-ana")).toBe("Ana");
    expect(nomes.get("u-bia")).toBe("Bia");
    expect(nomes.get("u-caio") ?? null).toBeNull();
  });

  it("o id de fora nem chega a ser consultado no cadastro de usuários", async () => {
    const admin = clienteDeServico();
    m.createAdminClient.mockReturnValue(admin);
    await nomesDosAtendentes(ORG, ["u-ana", "u-caio"]);
    expect(admin.auth.admin.getUserById).toHaveBeenCalledTimes(1);
    expect(admin.auth.admin.getUserById).toHaveBeenCalledWith("u-ana");
  });

  it("uma consulta de vínculo por chamada, filtrada pela organização, com os ids distintos", async () => {
    await nomesDosAtendentes(ORG, ["u-ana", "u-ana", null, "u-caio", undefined]);
    expect(m.consultas).toEqual([
      { tabela: "user_organizations", eq: { organization_id: ORG }, in: ["u-ana", "u-caio"] },
    ]);
  });

  it("vínculo que não pôde ser lido: ninguém ganha nome e nada lança", async () => {
    m.erroVinculos = { message: "fora do ar" };
    const nomes = await nomesDosAtendentes(ORG, ["u-ana"]);
    expect(nomes.get("u-ana") ?? null).toBeNull();
  });

  it("sem service role não abre o client de serviço", async () => {
    m.servico = false;
    const nomes = await nomesDosAtendentes(ORG, ["u-ana"]);
    expect(nomes.size).toBe(0);
    expect(m.createAdminClient).not.toHaveBeenCalled();
  });
});
