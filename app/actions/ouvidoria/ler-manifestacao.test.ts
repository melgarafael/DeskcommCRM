/**
 * A PORTA DA LEITURA DA OUVIDORIA (#3611, fatia 1).
 *
 * O que este arquivo mede é a REGRA DE PAPEL — e só ela. A leitura em si
 * (predicado de organização, mapeamento da linha) é medida em
 * `tests/unit/ouvidoria-registro.test.ts`, com o mesmo dublê de banco.
 *
 * ⚠️ O caso do `agent` importa mais do que parece: `admin` é a régua escolhida
 * enquanto a configuração de perfis autorizados não existe (fatia seguinte), e
 * a "correção" natural de um vermelho aqui seria baixar a régua para `manager` —
 * exatamente a decisão que o dono do produto ainda não tomou. O caso fixa a
 * régua e diz por quê.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { OUTRA_ORG, ORG_ID, USER_ID, makeDb } from "@/tests/helpers/stages-db-double";

const MANIFESTACAO = {
  id: "66666666-6666-4666-8666-666666666666",
  organization_id: ORG_ID,
  protocolo: "OUV-20261028-ABCD1234",
  canal: "whatsapp",
  texto: "Relato sigiloso.",
  contact_id: null,
  status: "recebida",
  created_at: "2026-10-28T12:00:00.000Z",
  updated_at: "2026-10-28T12:00:00.000Z",
};

function sessao(role: "admin" | "manager" | "agent" | "viewer") {
  vi.mocked(loadAuthUser).mockResolvedValue({ id: USER_ID } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({
    orgId: ORG_ID,
    name: "Org",
    role,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lerManifestacaoDaOuvidoria", () => {
  it("sem sessão: unauthenticated, sem tocar no banco", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null);
    const db = makeDb({ manifestacoes: [MANIFESTACAO] });
    const { lerManifestacaoDaOuvidoria } = await import("./ler-manifestacao");

    await expect(lerManifestacaoDaOuvidoria(MANIFESTACAO.id)).resolves.toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(db.escritas).toHaveLength(0);
    expect(resolveActiveOrg).not.toHaveBeenCalled();
  });

  it("⭐ sessão de acompanhamento somente leitura não lê o relato sigiloso", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: USER_ID,
      support: {
        id: "77777777-7777-4777-8777-777777777777",
        organization_id: ORG_ID,
        actor_user_id: USER_ID,
        auth_session_id: "88888888-8888-4888-8888-888888888888",
        previous_organization_id: null,
        expires_at: "2030-01-01T00:00:00.000Z",
        name: "Suporte",
        locale: null,
        access_mode: "support_readonly",
        status: "active",
      },
    } as never);
    makeDb({ manifestacoes: [MANIFESTACAO] });
    const { lerManifestacaoDaOuvidoria } = await import("./ler-manifestacao");

    await expect(lerManifestacaoDaOuvidoria(MANIFESTACAO.id)).resolves.toEqual({
      ok: false,
      error: "forbidden_role",
    });
    // A barreira vem antes de qualquer resolução de tenant.
    expect(resolveActiveOrg).not.toHaveBeenCalled();
  });

  it("usuário sem organização ativa: forbidden_tenant", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(resolveActiveOrg).mockResolvedValue(null);
    makeDb({ manifestacoes: [MANIFESTACAO] });
    const { lerManifestacaoDaOuvidoria } = await import("./ler-manifestacao");

    await expect(lerManifestacaoDaOuvidoria(MANIFESTACAO.id)).resolves.toEqual({
      ok: false,
      error: "forbidden_tenant",
    });
  });

  it("⭐ papel abaixo de admin (agent, manager, viewer) não lê", async () => {
    makeDb({ manifestacoes: [MANIFESTACAO] });
    const { lerManifestacaoDaOuvidoria } = await import("./ler-manifestacao");

    for (const role of ["agent", "manager", "viewer"] as const) {
      sessao(role);
      await expect(lerManifestacaoDaOuvidoria(MANIFESTACAO.id)).resolves.toEqual({
        ok: false,
        error: "forbidden_role",
      });
    }
  });

  it("⭐ admin da organização lê a manifestação da própria empresa", async () => {
    sessao("admin");
    makeDb({ manifestacoes: [MANIFESTACAO] });
    const { lerManifestacaoDaOuvidoria } = await import("./ler-manifestacao");

    const resultado = await lerManifestacaoDaOuvidoria(MANIFESTACAO.id);

    expect(resultado.ok).toBe(true);
    if (resultado.ok) expect(resultado.manifestacao.protocolo).toBe("OUV-20261028-ABCD1234");
  });

  it("⭐ admin de OUTRA empresa recebe not_found, não a linha do vizinho", async () => {
    sessao("admin");
    makeDb({ manifestacoes: [{ ...MANIFESTACAO, organization_id: OUTRA_ORG }] });
    const { lerManifestacaoDaOuvidoria } = await import("./ler-manifestacao");

    await expect(lerManifestacaoDaOuvidoria(MANIFESTACAO.id)).resolves.toEqual({
      ok: false,
      error: "not_found",
    });
  });
});
