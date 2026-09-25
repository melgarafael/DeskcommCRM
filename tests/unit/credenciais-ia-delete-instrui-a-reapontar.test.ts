/**
 * A recusa do DELETE tem de ENSINAR o caminho certo.
 *
 * A mensagem antiga — "Remova as versões antes." — era dupla armadilha: remover
 * a versão apaga o agente (e o histórico dele), e a própria instrução é
 * impossível de seguir, porque a versão está presa por mais duas FKs
 * (`ai_agent_runs.agent_version_id` RESTRICT e `ai_reply_drafts.agent_version_id`
 * NO ACTION). O que existe é repontar a versão para outra credencial.
 *
 * Este teste também cobre a régua honesta: uma versão em RASCUNHO é suficiente
 * para o banco recusar a exclusão, e a rota precisa recusar antes disso.
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

/** Chain mínimo que cobre select/filter/maybeSingle/single/delete e é thenable. */
function fakeAdmin(config: Record<string, Resposta>): Fake {
  return {
    from(table: string) {
      let op = "select";
      const respond = () => config[`${table}:${op}`] ?? config[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        update: () => {
          op = "update";
          return chain;
        },
        insert: () => {
          op = "insert";
          return chain;
        },
        delete: () => {
          op = "delete";
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
}) {
  return {
    id: over.id ?? "v1",
    credential_id: id,
    version_number: over.version_number ?? 1,
    status: over.status ?? "draft",
    ai_agents: { id: "a1", name: over.nome ?? "Atendimento", archived_at: null, published_version_id: null },
  };
}

function invocar() {
  return DELETE(new NextRequest(`http://localhost/api/v1/ai/credentials/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: org, role: "admin", name: "Org" },
    user: { id: "actor", idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
});

describe("DELETE /api/v1/ai/credentials/:id instrui a repontar", () => {
  it("rascunho já é suficiente para recusar, e a frase diz o agente e a versão", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        "ai_provider_credentials:select": { data: cred, error: null },
        "ai_agent_versions:select": {
          data: [versao({ id: "v4", version_number: 4, status: "draft", nome: "Triagem" })],
          error: null,
        },
      }) as unknown as ReturnType<typeof createAdminClient>,
    );

    const res = await invocar();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("credential_in_use");
    // Ensina o caminho certo, nomeando quem travar.
    expect(body.error.message).toContain("1 versão de agente");
    expect(body.error.message).toContain("Triagem v4");
    expect(body.error.message).toContain("Aponte essa versão para outra chave");
    // E deixa claro por que a instrução antiga era perigosa.
    expect(body.error.message).toContain("destruiria o agente");
    expect(body.error.message).not.toContain("Remova as versões");
    // O operador precisa saber onde ir: dados estruturados junto da frase.
    expect(body.error.details).toMatchObject({
      count: 1,
      versions: [{ agent_name: "Triagem", version_number: 4, status: "draft" }],
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("conta todas as versões e lista cada agente (rascunho + superseded)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        "ai_provider_credentials:select": { data: cred, error: null },
        "ai_agent_versions:select": {
          data: [
            versao({ id: "v3", version_number: 3, status: "superseded", nome: "Triagem" }),
            versao({ id: "v2", version_number: 2, status: "draft", nome: "Atendimento" }),
          ],
          error: null,
        },
      }) as unknown as ReturnType<typeof createAdminClient>,
    );

    const res = await invocar();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.message).toContain("2 versões de agente");
    expect(body.error.message).toContain("Triagem v3");
    expect(body.error.message).toContain("Atendimento v2");
    expect(body.error.details.count).toBe(2);
  });

  it("sem versão apontando, exclui de verdade e audita", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        "ai_provider_credentials:select": { data: cred, error: null },
        "ai_agent_versions:select": { data: [], error: null },
        "ai_provider_credentials:delete": { error: null },
      }) as unknown as ReturnType<typeof createAdminClient>,
    );

    const res = await invocar();
    const body = await res.json();

    expect(res.status).toBe(200);
    // `jev_desligado` só é `true` na chave do Jev (credenciais-ia-delete-desliga-o-jev).
    expect(body.data).toEqual({ id, deleted: true, jev_desligado: false });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.credential_deleted", resourceId: id }),
    );
  });

  it("credencial de outra organização responde 404 e não tenta excluir", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        "ai_provider_credentials:select": {
          data: { ...cred, organization_id: "outra-org" },
          error: null,
        },
      }) as unknown as ReturnType<typeof createAdminClient>,
    );

    const res = await invocar();
    expect(res.status).toBe(404);
  });
});
