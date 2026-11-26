import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET, PATCH } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
// `requireSupportWrite` lê o usuário para saber se há acompanhamento (leitura de
// suporte): sem a sessão, ele não recusa — é o caso desta rota de admin direto.
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

/**
 * O campo da #4670 exposto pela API da conexão — leitura de admin, escrita
 * auditada, e organização sempre vinda da sessão.
 *
 * No molde de `acervo/route.test.ts` e `ai-access/route.test.ts`: o que se cobra
 * aqui é o CONTRATO da rota (quem pode, com que filtro, o que fica na trilha),
 * não a decisão de negócio — essa é medida em
 * `tests/unit/conexao-decide-se-a-conversa-cria-negocio.test.ts` e no invariante
 * de banco.
 */
const org = "33333333-3333-4333-8333-333333333333";
const canal = "44444444-4444-4444-8444-444444444444";
const filters: Record<string, unknown> = {};
const update = vi.fn();
const row = {
  id: canal,
  organization_id: org,
  conversa_nova_cria_negocio: false,
};
const context = (id = canal) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown = {}) =>
  new NextRequest(`http://localhost/api/v1/channel-sessions/${canal}/negocio-da-conversa`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(filters)) delete filters[k];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: org },
    org: { orgId: org, role: "admin" },
  } as Awaited<ReturnType<typeof requireRole>>);
  const bate = () => Object.entries(filters).every(([k, v]) => row[k as keyof typeof row] === v);
  const query = {
    select: () => query,
    update: (patch: unknown) => {
      update(patch);
      return query;
    },
    eq: (k: string, v: unknown) => {
      filters[k] = v;
      return query;
    },
    maybeSingle: async () => ({ data: bate() ? row : null, error: null }),
  };
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => query,
  } as unknown as ReturnType<typeof createAdminClient>);
});

describe("#4670 · a opção por conexão pela API da conexão", () => {
  it("exige admin para ler e para escrever, e não toca no banco se negado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "Acesso negado.", 403),
    } as Awaited<ReturnType<typeof requireRole>>);

    expect((await GET(req(), context())).status).toBe(403);
    expect((await PATCH(req({ conversa_nova_cria_negocio: true }), context())).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("canal de outra organização responde 404, não grava e não audita", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: org },
      org: { orgId: canal, role: "admin" },
    } as Awaited<ReturnType<typeof requireRole>>);

    expect((await GET(req(), context())).status).toBe(404);
    expect((await PATCH(req({ conversa_nova_cria_negocio: true }), context())).status).toBe(404);
    // O `update` do builder é montado antes do filtro; o que decide a gravação é
    // a linha devolvida no `select("id")` — sem linha, o Postgres não escreveu
    // nada, a rota responde 404 e NADA vai para a trilha.
    expect(audit).not.toHaveBeenCalled();
  });

  it("lê o valor da conexão (false é um valor, não ausência)", async () => {
    const res = await GET(req(), context());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { conversa_nova_cria_negocio: false },
    });
    // A organização vai no filtro: é o que impede ler a chave da vizinha.
    expect(filters.organization_id).toBe(org);
  });

  it("grava auditado, com o valor novo na trilha", async () => {
    const res = await PATCH(req({ conversa_nova_cria_negocio: false }), context());

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ conversa_nova_cria_negocio: false });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.negocio_da_conversa_updated",
        organizationId: org,
        resourceType: "channel_session",
        resourceId: canal,
        metadata: { conversa_nova_cria_negocio: false },
      }),
    );
  });

  it("corpo sem o campo é 422, e nada é gravado", async () => {
    expect((await PATCH(req({}), context())).status).toBe(422);
    expect(update).not.toHaveBeenCalled();
  });
});
