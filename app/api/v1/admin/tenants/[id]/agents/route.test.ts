/**
 * A leitura que revela se o cliente está atendendo — e as duas perguntas que a
 * tela faz por baixo dela: *de quem é este agente* e *qual versão o motor roda*.
 *
 * ─── Por que o dublê aplica os filtros de verdade ──────────────────────────
 *
 * Um stub que devolvesse a lista pronta deixaria passar o defeito mais caro
 * desta rota: o `eq("organization_id", …)` some e um agente de OUTRA
 * organização aparece na carteira do cliente. Com o filtro aplicado de verdade,
 * apagar essa linha muda o resultado do teste — que é a única coisa que faz o
 * teste valer alguma coisa.
 *
 * O mesmo vale para a versão: ela é buscada com o `organization_id` da rota, e
 * o caso "versão de outra organização não é servida" existe exatamente para
 * isso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET } from "./route";

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const USER = "11111111-1111-4111-8111-111111111111";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const AGENTE_ALHEIO = "55555555-5555-4555-8555-555555555555";
const VERSAO = "66666666-6666-4666-8666-666666666666";
const VERSAO_ALHEIA = "77777777-7777-4777-8777-777777777777";

type Linha = Record<string, unknown>;
type Predicado = (linha: Linha) => boolean;

/**
 * Dublê do client de service role: encadeia e filtra como o PostgREST, e é
 * "thenable" porque a rota espera a consulta depois de `.order(...)`.
 */
function dubleAdmin(tabelas: Record<string, Linha[]>) {
  function consulta(tabela: string, predicados: Predicado[] = []) {
    const linhas = () => (tabelas[tabela] ?? []).filter((l) => predicados.every((p) => p(l)));
    const api: Record<string, unknown> = {
      select: () => consulta(tabela, predicados),
      eq: (coluna: string, valor: unknown) =>
        consulta(tabela, [...predicados, (l) => l[coluna] === valor]),
      is: (coluna: string, valor: unknown) =>
        consulta(tabela, [...predicados, (l) => l[coluna] === valor]),
      in: (coluna: string, valores: unknown[]) =>
        consulta(tabela, [...predicados, (l) => valores.includes(l[coluna])]),
      order: () => consulta(tabela, predicados),
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Linha[]; error: null }) => unknown) =>
        resolve({ data: linhas(), error: null }),
    };
    return api;
  }
  return { from: (tabela: string) => consulta(tabela) };
}

function agente(over: Linha = {}): Linha {
  return {
    id: AGENTE,
    organization_id: ORG,
    name: "Agente de vendas",
    kind: "mcp_agent",
    is_active: true,
    is_default: true,
    priority: 0,
    published_version_id: VERSAO,
    archived_at: null,
    ...over,
  };
}

function versao(over: Linha = {}): Linha {
  return {
    id: VERSAO,
    organization_id: ORG,
    version_number: 3,
    status: "published",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    published_at: "2026-09-01T12:00:00.000Z",
    provisioning_origin: "onboarding",
    ...over,
  };
}

function banco(
  over: {
    organizations?: Linha[];
    ai_agents?: Linha[];
    ai_agent_versions?: Linha[];
  } = {},
) {
  return dubleAdmin({
    organizations: over.organizations ?? [{ id: ORG }],
    ai_agents: over.ai_agents ?? [agente()],
    ai_agent_versions: over.ai_agent_versions ?? [versao()],
  });
}

/** Ponto único de entrada da rota: a URL e o `params` têm de casar com o que ela lê. */
function chamar(id: string) {
  return GET(new NextRequest(`http://localhost/api/v1/admin/tenants/${id}/agents`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.mocked(requirePlatformAdmin).mockReset();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(audit).mockClear();
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(createAdminClient).mockReturnValue(banco() as never);
});

describe("GET /api/v1/admin/tenants/[id]/agents", () => {
  it("recusa quem não é platform admin", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("nope"));

    const res = await chamar(ORG);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled();
  });

  it("recusa id que não é uuid sem consultar o banco", async () => {
    const res = await chamar("nao-e-uuid");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "validation_error" } });
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled();
  });

  it("404 para organização inexistente — e não lista vazia", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ organizations: [] }) as never);

    const res = await chamar(ORG);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("devolve o agente junto da versão que o motor executa", async () => {
    const res = await chamar(ORG);
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.organization_id).toBe(ORG);
    expect(corpo.data.agents).toHaveLength(1);
    expect(corpo.data.agents[0]).toMatchObject({
      id: AGENTE,
      name: "Agente de vendas",
      kind: "mcp_agent",
      is_active: true,
      published_version_id: VERSAO,
      published_version: {
        version_number: 3,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        status: "published",
      },
    });
  });

  it("agente sem publicada devolve null — e isso é resposta, não erro", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({ ai_agents: [agente({ published_version_id: null })] }) as never,
    );

    const res = await chamar(ORG);
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.agents[0].published_version_id).toBeNull();
    expect(corpo.data.agents[0].published_version).toBeNull();
  });

  it("não serve agente de outra organização", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({
        ai_agents: [
          agente(),
          agente({ id: AGENTE_ALHEIO, organization_id: OUTRA_ORG, name: "Do vizinho" }),
        ],
      }) as never,
    );

    const res = await chamar(ORG);
    const corpo = await res.json();

    expect(corpo.data.agents).toHaveLength(1);
    expect(corpo.data.agents.map((a: { name: string }) => a.name)).toEqual(["Agente de vendas"]);
  });

  it("não serve versão de outra organização, mesmo com o id apontando para ela", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({
        ai_agents: [agente({ published_version_id: VERSAO_ALHEIA })],
        ai_agent_versions: [versao({ id: VERSAO_ALHEIA, organization_id: OUTRA_ORG })],
      }) as never,
    );

    const res = await chamar(ORG);
    const corpo = await res.json();

    expect(corpo.data.agents[0].published_version_id).toBe(VERSAO_ALHEIA);
    expect(corpo.data.agents[0].published_version).toBeNull();
  });

  it("agente arquivado não aparece — ele não atende ninguém", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({ ai_agents: [agente({ archived_at: "2026-08-01T00:00:00.000Z" })] }) as never,
    );

    const res = await chamar(ORG);
    const corpo = await res.json();

    expect(corpo.data.agents).toEqual([]);
  });

  it("audita a leitura com o ator real e a organização visitada", async () => {
    await chamar(ORG);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "platform_admin.tenant_agents_viewed",
        actorUserId: USER,
        actingAsPlatformAdmin: true,
        bypassedRls: true,
        organizationId: ORG,
        resourceType: "organization",
        resourceId: ORG,
      }),
    );
  });

  it("não audita quando a guarda recusa", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("nope"));

    await chamar(ORG);

    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
