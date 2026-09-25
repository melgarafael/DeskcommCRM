/**
 * Excluir a última chave apta do Jev DESLIGA o Jev — com auditoria própria.
 *
 * A chave do Jev não trava a exclusão como a de um agente (nenhuma versão aponta
 * para ela). Sem este desligamento, o cartão seguiria dizendo "ligado" sem chave
 * nenhuma, e a linha `ai.jev.desligado` que a auditoria promete para este caso
 * nunca sairia. O aceite de LGPD fica: religar com chave nova não pede de novo.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE } from "@/app/api/v1/ai/credentials/[id]/route";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const USUARIO = "33333333-3333-4333-8333-333333333333";
const ID = "22222222-2222-4222-8222-222222222222";
const ACEITE = { em: "2026-09-01T12:00:00.000Z", por: USUARIO };

type Linha = Record<string, unknown>;

interface Estado {
  provider: string;
  settings: Linha;
  /** As credenciais do Jev que sobram depois da exclusão. */
  restantes: Linha[];
  tabelasLidas: string[];
  escritasEmOrg: Array<{ eq: Array<[string, unknown]>; settings: Linha }>;
}

let estado: Estado;

function fakeAdmin() {
  return {
    from(tabela: string) {
      estado.tabelasLidas.push(tabela);
      let op: "select" | "update" | "delete" = "select";
      let patch: Linha | null = null;
      const eq: Array<[string, unknown]> = [];
      const lista = () => {
        if (tabela === "ai_provider_credentials" && op === "select") {
          // Aplica os filtros de igualdade: sem isto, a chave de OUTRA
          // organização contaria como "sobra outra chave" sem ninguém ver.
          return {
            data: estado.restantes.filter((l) => eq.every(([col, v]) => l[col] === v)),
            error: null,
          };
        }
        return { data: tabela === "ai_agent_versions" ? [] : null, error: null };
      };
      const chain = {
        select: () => chain,
        eq: (coluna: string, valor: unknown) => {
          eq.push([coluna, valor]);
          return chain;
        },
        update: (p: Linha) => {
          op = "update";
          patch = p;
          return chain;
        },
        delete: () => {
          op = "delete";
          return chain;
        },
        maybeSingle: async () => {
          if (tabela === "ai_provider_credentials") {
            return {
              data: { id: ID, organization_id: ORG, provider: estado.provider, label: "Jev", api_key_last4: "wxyz" },
              error: null,
            };
          }
          expect(tabela).toBe("organizations");
          if (op === "update" && patch) {
            estado.settings = patch.settings as Linha;
            estado.escritasEmOrg.push({ eq, settings: estado.settings });
          }
          return { data: { settings: estado.settings }, error: null };
        },
        then: (ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve(lista()).then(ok, erro),
      };
      return chain;
    },
  };
}

function chaveDoJev(over: Linha = {}): Linha {
  return {
    organization_id: ORG,
    provider: "typesafe",
    is_active: true,
    validated_at: "2026-09-20T12:00:00.000Z",
    created_at: "2026-09-20T12:00:00.000Z",
    ...over,
  };
}

async function excluir() {
  const res = await DELETE(
    new NextRequest(`http://localhost/api/v1/ai/credentials/${ID}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: ID }) },
  );
  return { status: res.status, corpo: await res.json() };
}

const acoesAuditadas = () => vi.mocked(audit).mock.calls.map(([a]) => a.action);

beforeEach(() => {
  vi.clearAllMocks();
  estado = {
    provider: "typesafe",
    settings: {
      branding: { app_name: "Loja" },
      jev: { ligado: true, modo: "decide", aceite: ACEITE },
    },
    restantes: [],
    tabelasLidas: [],
    escritasEmOrg: [],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, role: "admin", name: "Org" },
    user: { id: USUARIO, idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue(
    fakeAdmin() as unknown as ReturnType<typeof createAdminClient>,
  );
});

describe("DELETE /api/v1/ai/credentials/:id — a chave do Jev", () => {
  it("a última chave apta desliga o Jev, na organização da sessão, e audita o desligamento", async () => {
    const { status, corpo } = await excluir();

    expect(status).toBe(200);
    expect(corpo.data).toMatchObject({ id: ID, deleted: true, jev_desligado: true });

    expect(estado.escritasEmOrg).toHaveLength(1);
    expect(estado.escritasEmOrg[0]?.eq).toContainEqual(["id", ORG]);
    expect(estado.settings.jev).toMatchObject({ ligado: false, modo: "decide", aceite: ACEITE });
    // `settings` é compartilhado: o resto da organização fica como estava.
    expect(estado.settings.branding).toEqual({ app_name: "Loja" });

    expect(acoesAuditadas()).toEqual(["ai.credential_deleted", "ai.jev.desligado"]);
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "ai.jev.desligado",
        organizationId: ORG,
        actorUserId: USUARIO,
        metadata: expect.objectContaining({ motivo: "chave_excluida" }),
      }),
    );
  });

  it("sobra só chave NÃO validada: ela não sai para a rede, então o Jev desliga igual", async () => {
    estado.restantes = [chaveDoJev({ validated_at: null })];
    const { corpo } = await excluir();
    expect(corpo.data.jev_desligado).toBe(true);
    expect(estado.settings.jev).toMatchObject({ ligado: false });
  });

  it("sobra outra chave validada: o Jev segue ligado, sem escrita e sem auditoria dele", async () => {
    estado.restantes = [chaveDoJev()];
    const { status, corpo } = await excluir();
    expect(status).toBe(200);
    expect(corpo.data.jev_desligado).toBe(false);
    expect(estado.escritasEmOrg).toEqual([]);
    expect(acoesAuditadas()).toEqual(["ai.credential_deleted"]);
  });

  it("a chave validada de OUTRA organização não segura o Jev desta ligado", async () => {
    // Cliente admin passa por cima da RLS: o filtro de organização é a única
    // cerca entre "sobrou chave" e "sobrou chave de outra empresa".
    estado.restantes = [chaveDoJev({ organization_id: "99999999-9999-4999-8999-999999999999" })];
    const { corpo } = await excluir();
    expect(corpo.data.jev_desligado).toBe(true);
    expect(estado.settings.jev).toMatchObject({ ligado: false });
  });

  it("o Jev já desligado: nada a desligar", async () => {
    estado.settings = { jev: { ligado: false, modo: "observacao", aceite: ACEITE } };
    const { corpo } = await excluir();
    expect(corpo.data.jev_desligado).toBe(false);
    expect(estado.escritasEmOrg).toEqual([]);
    expect(acoesAuditadas()).toEqual(["ai.credential_deleted"]);
  });

  it("controle: chave de quem conversa nem olha o interruptor do Jev", async () => {
    estado.provider = "anthropic";
    const { corpo } = await excluir();
    expect(corpo.data.jev_desligado).toBe(false);
    expect(estado.tabelasLidas).not.toContain("organizations");
    expect(acoesAuditadas()).toEqual(["ai.credential_deleted"]);
  });
});
