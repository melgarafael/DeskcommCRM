/**
 * A pré-checagem do DELETE tem de enxergar o MESMO conjunto que a FK vê —
 * e o DELETE tem de parar ANTES do banco quando esse conjunto não é vazio.
 *
 * É a #1142 em forma de teste. A régua antiga (`contarUsoPublicado`) contava só
 * a versão PUBLICADA de agente não-arquivado; a FK
 * `ai_agent_versions.credential_id ON DELETE RESTRICT` (`supabase/baseline.sql`)
 * não distingue nada disso. Resultado: a API dizia "não está em uso", o DELETE
 * batia no `23503` e a frase que saía ("Remova as versões antes") não tinha
 * saída nenhuma na UI.
 *
 * Três invariantes que os testes existentes NÃO pegam (todos usam um fake que
 * ignora os filtros, então uma `.eq("status", ...)` nova passaria em verde):
 *
 *  1. O SELECT de uso filtra SÓ `credential_id` + `organization_id` — sem
 *     status, sem `published_version_id`, sem `limit` (um limite de linha faria
 *     a pré-checagem ver um SUBCONJUNTO do que a FK vê);
 *  2. Com qualquer referência o `.delete()` nem é emitido: a API não promete o
 *     que o banco vai recusar;
 *  3. Se mesmo assim o banco recusar com `23503` (corrida), a resposta é 409
 *     `credential_in_use` — nunca 500 e nunca "Remova as versões".
 *
 * Cobrem também o caso que a régua antiga deixava passar: versão de agente
 * ARQUIVADO (arquivar não apaga versão; a FK segue travando).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { DELETE } from "@/app/api/v1/ai/credentials/[id]/route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";

type Resposta = { data?: unknown; error?: unknown };
type Fake = { from: (table: string) => unknown };

/** Um `.from(tabela)` feito pela rota — com o que ele filtrou de verdade. */
interface Registro {
  table: string;
  op: string;
  filtros: Record<string, unknown>;
  limit: number;
}

/**
 * O mesmo chain mínimo do resto da suíte, mas REGISTRANDO os filtros: é o que
 * deixa este teste ver uma `.eq("status", ...)" que os outros fakes ignoram.
 */
function fakeAdmin(config: Record<string, Resposta>, registros: Registro[]): Fake {
  return {
    from(table: string) {
      const registro: Registro = { table, op: "select", filtros: {}, limit: 0 };
      registros.push(registro);
      const respond = () =>
        config[`${table}:${registro.op}`] ?? config[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (campo: string, valor: unknown) => {
          registro.filtros[campo] = valor;
          return chain;
        },
        in: (campo: string, valor: unknown) => {
          registro.filtros[campo] = valor;
          return chain;
        },
        not: (campo: string, _op: string, valor: unknown) => {
          registro.filtros[`${campo}:not`] = valor;
          return chain;
        },
        order: () => chain,
        limit: () => {
          registro.limit += 1;
          return chain;
        },
        update: () => {
          registro.op = "update";
          return chain;
        },
        insert: () => {
          registro.op = "insert";
          return chain;
        },
        delete: () => {
          registro.op = "delete";
          return chain;
        },
        maybeSingle: async () => respond(),
        single: async () => respond(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(respond()).then(resolve),
      };
      return chain;
    },
  };
}

const cred = {
  id,
  organization_id: org,
  provider: "anthropic",
  label: "Produção",
  api_key_last4: "abcd",
};

function versao(over: {
  id?: string;
  status?: string;
  version_number?: number;
  nome?: string;
  arquivado?: boolean;
}) {
  return {
    id: over.id ?? "v1",
    credential_id: id,
    version_number: over.version_number ?? 1,
    status: over.status ?? "superseded",
    ai_agents: {
      id: "a1",
      name: over.nome ?? "Atendimento",
      archived_at: over.arquivado ? "2026-01-01T00:00:00Z" : null,
      published_version_id: null,
    },
  };
}

let registros: Registro[] = [];

function montar(config: Record<string, Resposta>) {
  registros = [];
  vi.mocked(createAdminClient).mockReturnValue(
    fakeAdmin(config, registros) as unknown as ReturnType<typeof createAdminClient>,
  );
}

function invocar() {
  return DELETE(new NextRequest(`http://localhost/api/v1/ai/credentials/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

/** O SELECT de uso da pré-checagem — o único que toca `ai_agent_versions`. */
function consultaDeUso(): Registro {
  const r = registros.find((x) => x.table === "ai_agent_versions");
  expect(r).toBeDefined();
  return r as Registro;
}

function deleteEmitido(): boolean {
  return registros.some((x) => x.table === "ai_provider_credentials" && x.op === "delete");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: org, role: "admin", name: "Org" },
    user: { id: "actor", idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
});

describe("a pré-checagem do DELETE enxerga o mesmo conjunto da FK", () => {
  it("filtra só credential_id e organization_id — sem status, sem published_version_id, sem limit", async () => {
    montar({
      "ai_provider_credentials:select": { data: cred, error: null },
      "ai_agent_versions:select": {
        data: [versao({ status: "superseded", nome: "Triagem" })],
        error: null,
      },
    });

    const res = await invocar();

    // A régua antiga filtrava pela versão publicada do agente. A FK não filtra
    // nada: qualquer coluna a mais aqui faz a API prometer um 200 que o banco
    // recusa com 23503.
    const uso = consultaDeUso();
    expect(uso.op).toBe("select");
    expect(Object.keys(uso.filtros).sort()).toEqual(["credential_id", "organization_id"]);
    expect(uso.filtros.credential_id).toBe(id);
    expect(uso.filtros.organization_id).toBe(org);
    // Um `limit` truncaria a leitura: a pré-checagem veria subconjunto da FK.
    expect(uso.limit).toBe(0);
    // E o conjunto que ela viu é mesmo o da FK: a recusa saiu.
    expect(res.status).toBe(409);
  });

  it("qualquer referência: 409 e o .delete() NEM É EMITIDO — a API não promete o que a FK recusa", async () => {
    montar({
      "ai_provider_credentials:select": { data: cred, error: null },
      "ai_agent_versions:select": {
        data: [versao({ id: "v3", version_number: 3, status: "superseded", nome: "Triagem" })],
        error: null,
      },
      // Se a rota chegasse aqui, o banco diria 23503 — e era exatamente a
      // promessa mentirosa da #1142.
      "ai_provider_credentials:delete": { error: { code: "23503", message: "violates" } },
    });

    const res = await invocar();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("credential_in_use");
    expect(deleteEmitido()).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("versão de agente ARQUIVADO também trava — arquivar não apaga versão e a FK não pergunta", async () => {
    montar({
      "ai_provider_credentials:select": { data: cred, error: null },
      "ai_agent_versions:select": {
        data: [
          versao({
            id: "v2",
            version_number: 2,
            status: "superseded",
            nome: "Triagem antiga",
            arquivado: true,
          }),
        ],
        error: null,
      },
    });

    const res = await invocar();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("credential_in_use");
    expect(body.error.message).toContain("Triagem antiga v2");
    expect(deleteEmitido()).toBe(false);
  });

  it("sem nenhuma referência: 200, a linha sai (delete filtrado por id e org) e audita", async () => {
    montar({
      "ai_provider_credentials:select": { data: cred, error: null },
      "ai_agent_versions:select": { data: [], error: null },
      "ai_provider_credentials:delete": { error: null },
    });

    const res = await invocar();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ id, deleted: true, jev_desligado: false });
    const del = registros.find((x) => x.table === "ai_provider_credentials" && x.op === "delete");
    expect(del).toBeDefined();
    expect((del as Registro).filtros).toMatchObject({ id, organization_id: org });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.credential_deleted", resourceId: id }),
    );
  });

  it("o banco recusa na corrida (23503): 409 credential_in_use, nunca 500 e nunca 'Remova as versões'", async () => {
    montar({
      "ai_provider_credentials:select": { data: cred, error: null },
      "ai_agent_versions:select": { data: [], error: null },
      "ai_provider_credentials:delete": {
        error: { code: "23503", message: 'violates foreign key constraint "ai_agent_versions_credential_id_fkey"' },
      },
    });

    const res = await invocar();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("credential_in_use");
    expect(body.error.message).not.toContain("Remova as versões");
    // A saída que EXISTE continua sendo a da #1142: editar no lugar.
    expect(body.error.message).toContain("Editar credencial");
    expect(audit).not.toHaveBeenCalled();
  });
});
