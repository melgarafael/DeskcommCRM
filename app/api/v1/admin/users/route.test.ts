import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/v1/admin/users — a listagem cross-tenant do painel de plataforma.
 *
 * Os dois defeitos que estes testes guardam:
 *  - o custo em requests ao GoTrue crescia com o número de VÍNCULOS (não com o
 *    tamanho da página): 300 vínculos = 300 requests concorrentes;
 *  - erro do GoTrue era engolido e virava lista vazia — indistinguível de banco
 *    vazio, e regressão em cima do 500 explícito que a rota dava antes.
 */

vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

type AuthUserStub = {
  id: string;
  email: string;
  last_sign_in_at: string | null;
  created_at: string;
  user_metadata: Record<string, unknown>;
};

function authUser(id: string, n: number): AuthUserStub {
  return {
    id,
    email: `user${n}@example.com`,
    last_sign_in_at: `2026-08-0${(n % 9) + 1}T00:00:00Z`,
    created_at: "2026-01-01T00:00:00Z",
    user_metadata: { full_name: `User ${n}` },
  };
}

function uoRow(userId: string) {
  return {
    user_id: userId,
    organization_id: ORG_ID,
    role: "agent",
    accepted_at: "2026-01-01T00:00:00Z",
    revoked_at: null,
    organizations: { display_name: "Org", slug: "org" },
  };
}

interface Cfg {
  uoRows?: unknown[];
  uoError?: { message: string } | null;
  /** Páginas devolvidas por listUsers, na ordem. Página ausente = vazia. */
  authPages?: AuthUserStub[][];
  listError?: { message: string; status?: number; code?: string } | null;
}

function makeAdminStub(cfg: Cfg) {
  const listUsers = vi.fn(async ({ page }: { page: number; perPage: number }) => {
    if (cfg.listError) {
      return { data: { users: [] }, error: cfg.listError };
    }
    return {
      data: {
        users: cfg.authPages?.[page - 1] ?? [],
        aud: "authenticated",
        nextPage: null,
        lastPage: 0,
        total: 0,
      },
      error: null,
    };
  });
  const getUserById = vi.fn(async (uid: string) => {
    const found = cfg.authPages?.flat().find((u) => u.id === uid);
    return found
      ? { data: { user: found }, error: null }
      : { data: { user: null }, error: { message: "not found", status: 404 } };
  });

  const builder = {
    select: () => builder,
    order: () => builder,
    eq: () => builder,
    then(
      resolve: (v: { data: unknown[] | null; error: unknown }) => unknown,
    ) {
      return Promise.resolve({
        data: cfg.uoError ? null : (cfg.uoRows ?? []),
        error: cfg.uoError ?? null,
      }).then(resolve);
    },
  };

  return {
    stub: {
      from: (table: string) => {
        if (table !== "user_organizations") {
          throw new Error(`unexpected table ${table}`);
        }
        return builder;
      },
      auth: { admin: { listUsers, getUserById } },
    },
    listUsers,
    getUserById,
  };
}

function req(qs = "") {
  return new NextRequest(`http://localhost/api/v1/admin/users${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
});

describe("GET /api/v1/admin/users — envelope", () => {
  it("devolve { data: [...] } sem aninhar o envelope dentro de si mesmo", async () => {
    const u = authUser("aaaaaaaa-0000-4000-8000-000000000001", 1);
    const { stub } = makeAdminStub({ uoRows: [uoRow(u.id)], authPages: [[u]] });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: Array<{ user_id: string; email: string }>;
      meta: { has_more: boolean };
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ user_id: u.id, email: u.email });
    // O corpo aninhado (`{ data: { data: [...] } }`) passaria no teste acima se
    // ele só olhasse `body.data`; esta linha é a que reprova.
    expect(body.data).not.toHaveProperty("data");
    expect(body.meta.has_more).toBe(false);
  });
});

describe("GET /api/v1/admin/users — custo no GoTrue", () => {
  it("300 vínculos não viram 300 requests ao Auth", async () => {
    const users = Array.from({ length: 300 }, (_, i) =>
      authUser(
        `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        i,
      ),
    );
    const { stub, listUsers, getUserById } = makeAdminStub({
      uoRows: users.map((u) => uoRow(u.id)),
      authPages: [users],
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req("?limit=30"));
    expect(res.status).toBe(200);

    // A propriedade guardada é "o número de chamadas ao GoTrue não cresce com o
    // número de vínculos", não qual método a rota usa.
    const chamadas = listUsers.mock.calls.length + getUserById.mock.calls.length;
    expect(chamadas).toBeLessThanOrEqual(2);

    const body = (await res.json()) as { data: unknown[]; meta: { has_more: boolean } };
    expect(body.data).toHaveLength(30);
    expect(body.meta.has_more).toBe(true);
  });

  it("continua paginando até resolver todos os ids necessários", async () => {
    const u1 = authUser("aaaaaaaa-0000-4000-8000-000000000001", 1);
    const u2 = authUser("aaaaaaaa-0000-4000-8000-000000000002", 2);
    const { stub, listUsers } = makeAdminStub({
      uoRows: [uoRow(u1.id), uoRow(u2.id)],
      authPages: [[u1], [u2]],
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(listUsers.mock.calls.length).toBeGreaterThanOrEqual(2);

    const body = (await res.json()) as { data: Array<{ email: string }> };
    expect(body.data.map((r) => r.email).sort()).toEqual([u1.email, u2.email]);
  });
});

describe("GET /api/v1/admin/users — teto de páginas da varredura", () => {
  // 50 é o `MAX_PAGES` da rota. Os dois casos rodam EM CIMA da fronteira, não
  // perto dela — é lá que o off-by-one mora. Mexer no teto sem mexer aqui
  // deixa este bloco vermelho, e isso é o certo: o número é o objeto do teste.
  const MAX_PAGES = 50;

  /** Diretório com MAX_PAGES páginas CHEIAS; `alvo`, se dado, vai na última. */
  function diretorioNoTeto(alvo?: AuthUserStub): AuthUserStub[][] {
    return Array.from({ length: MAX_PAGES }, (_, i) => {
      const enchimento = authUser(
        `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
        i,
      );
      return i === MAX_PAGES - 1 && alvo ? [enchimento, alvo] : [enchimento];
    });
  }

  it("id necessário na ÚLTIMA página permitida devolve a lista, não 503", async () => {
    const alvo = authUser("aaaaaaaa-0000-4000-8000-000000000001", 1);
    const { stub, listUsers } = makeAdminStub({
      uoRows: [uoRow(alvo.id)],
      authPages: diretorioNoTeto(alvo),
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req());

    // O mapa está COMPLETO ao fim da página 50: nada foi truncado, e o teto
    // não tem o que denunciar.
    expect(res.status).toBe(200);
    expect(listUsers.mock.calls.length).toBe(MAX_PAGES);
    const body = (await res.json()) as { data: Array<{ user_id: string }> };
    expect(body.data.map((r) => r.user_id)).toEqual([alvo.id]);
  });

  it("id ainda pendente depois do teto continua falhando alto", async () => {
    const orfao = "aaaaaaaa-0000-4000-8000-000000000009";
    const { stub, listUsers } = makeAdminStub({
      uoRows: [uoRow(orfao)],
      authPages: diretorioNoTeto(),
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req());

    expect(res.status).toBe(503);
    expect(listUsers.mock.calls.length).toBe(MAX_PAGES);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_unavailable");
  });

  it("na fronteira, a falha não afirma o tamanho do diretório — ela conta os pendentes", async () => {
    // Este é o cenário exato em que os dois mundos são indistinguíveis: o
    // diretório tem MAX_PAGES páginas não-vazias e o vínculo é órfão (usuário
    // removido do Auth). A varredura para no teto sem nunca ver a página vazia
    // que provaria o fim, então "o diretório é maior que o suportado" é uma
    // causa NÃO medida — e era o que a mensagem afirmava.
    //
    // A decisão é falhar fechado na AÇÃO (503; entregar a lista como completa
    // some com um usuário que existe) e aberto na INFORMAÇÃO: a mensagem fala
    // do que aconteceu, e o `details` leva o dado que separa os dois mundos na
    // mão do operador — 1 pendente num diretório grande cheira a órfão,
    // centenas cheiram a truncamento.
    const orfao = "aaaaaaaa-0000-4000-8000-000000000009";
    const vivo = authUser("aaaaaaaa-0000-4000-8000-000000000001", 1);
    const { stub } = makeAdminStub({
      uoRows: [uoRow(vivo.id), uoRow(orfao)],
      authPages: diretorioNoTeto(vivo),
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req());

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: string };
    };
    expect(body.error.code).toBe("upstream_unavailable");
    expect(body.error.message).not.toMatch(/maior que o suportado/i);
    // 1 dos 2 vínculos ficou sem usuário: o número é a informação, não a causa.
    expect(body.error.details).toContain("1 of 2 link(s) unresolved");
  });
});

describe("GET /api/v1/admin/users — GoTrue indisponível", () => {
  it("falha alto em vez de devolver lista curta", async () => {
    const u = authUser("aaaaaaaa-0000-4000-8000-000000000001", 1);
    const { stub } = makeAdminStub({
      uoRows: [uoRow(u.id)],
      authPages: [[u]],
      // AuthRetryableFetchError: o SDK devolve isto SEM lançar em 504/socket.
      listError: { message: "Failed to fetch", status: 504 },
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req());

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string }; data?: unknown };
    expect(body.error.code).toBe("upstream_unavailable");
    expect(body).not.toHaveProperty("data");
  });

  it("vínculo órfão (usuário removido do Auth) some da lista sem derrubar as outras linhas", async () => {
    const vivo = authUser("aaaaaaaa-0000-4000-8000-000000000001", 1);
    const removido = "aaaaaaaa-0000-4000-8000-000000000009";
    const { stub } = makeAdminStub({
      uoRows: [uoRow(vivo.id), uoRow(removido)],
      authPages: [[vivo]],
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ user_id: string }> };
    expect(body.data.map((r) => r.user_id)).toEqual([vivo.id]);
  });
});
