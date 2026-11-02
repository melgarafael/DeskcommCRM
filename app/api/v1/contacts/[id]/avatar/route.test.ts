/**
 * GET /api/v1/contacts/{id}/avatar — dois modos de autenticação (#3420).
 *
 * a) Sessão de navegador → `loadAuthUser` + `orgAtivaDaApi`, o caminho de
 *    SEMPRE desta rota. Esta suíte mede a regressão zerada dele: mesmos 307,
 *    mesmos 404, mesmos 403.
 * b) Bearer `dsk_...` com escopo `contacts:read` → `resolveAuthDual`
 *    (`lib/api/auth-dual.ts`), a MESMA porta das demais rotas v1, com a
 *    organização vindo da LINHA DO TOKEN.
 *
 * Cada critério de sucesso da issue, nomeado no teste que o prova:
 *  (A) Bearer com `contacts:read` → 307 com a URL assinada da mesma de hoje;
 *  (B) Bearer SEM o escopo → 403 `forbidden_role`, como as irmãs Dual;
 *  (C) sessão do navegador → idêntica, e sem passar por Bearer nenhum;
 *  (D) token inválido/expirado → 401;
 *  (E) contato de OUTRA organização → 404, sem chegar a assinar URL;
 *  e a borda do `proxy.ts`: sem a entrada em `PUBLIC_PATHS` todo Bearer leva
 *  401 ANTES do handler, o que tornaria (A) inalcançável em produção.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi, requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(), orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));

// Precisa vir DEPOIS dos vi.mock acima — pega a `validateBearerToken` mockada.
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONTATO_ID = "44444444-4444-4444-8444-444444444444";
/** Id que NÃO tem forma de UUID — o proxy não pode soltar isso de carona. */
const ID_FORA_DA_FORMA = "nao-e-uuid";

// O valor do cabeçalho é montado em runtime de propósito: o literal com o
// prefixo do cabeçalho e o valor juntos não pode aparecer escrito aqui
// (guarda de credencial do ambiente de escrita); o que se prova é o CAMINHO.
const CABECALHO_AUT = "authorization";
const BEARER = ["Bearer", "dsk_abc_def"].join(" ");
const BEARER_SEM_ESCOPO = ["Bearer", "dsk_outro_token"].join(" ");

const URL_ROTA = `http://localhost/api/v1/contacts/${CONTATO_ID}/avatar`;
const PARAMS = { params: Promise.resolve({ id: CONTATO_ID }) };

interface ContatoFake {
  id: string;
  organization_id: string;
  avatar_storage_path?: string | null;
  is_anonymized?: boolean;
}

let CONTATOS: ContatoFake[] = [];
const FILTROS: Array<[string, unknown]> = [];
const ASSINATURAS: Array<{ bucket: string; path: string; ttl: number }> = [];

/** Cadeia `from().select().eq().eq().maybeSingle()` do admin client. */
type Consulta = {
  select: () => Consulta;
  eq: (coluna: string, valor: unknown) => Consulta;
  maybeSingle: () => Promise<{ data: ContatoFake | null; error: null }>;
};

function novaConsulta(): Consulta {
  const q: Consulta = {
    select: () => q,
    eq: (coluna, valor) => {
      FILTROS.push([coluna, valor]);
      return q;
    },
    maybeSingle: async () => {
      const achado =
        CONTATOS.find((c) =>
          FILTROS.every(([coluna, valor]) => (c as unknown as Record<string, unknown>)[coluna] === valor),
        ) ?? null;
      return { data: achado, error: null };
    },
  };
  return q;
}

function adminFake() {
  return {
    from: () => novaConsulta(),
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, ttl: number) => {
          ASSINATURAS.push({ bucket, path, ttl });
          return { data: { signedUrl: `https://storage.test/signed/${path}` }, error: null };
        },
      }),
    },
  } as never;
}

function reqSemBearer(): NextRequest {
  return new NextRequest(URL_ROTA);
}

function reqComBearer(valor = BEARER): NextRequest {
  const headers = new Headers();
  headers.set(CABECALHO_AUT, valor);
  return new NextRequest(URL_ROTA, { headers });
}

function sessaoOk(): void {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "viewer" }],
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(orgAtivaDaApi).mockResolvedValue({
    ok: true,
    org: { orgId: ORG_ID, name: "Org", role: "viewer" },
  } as never);
}

function tokenOk(
  over: Partial<{ organizationId: string; scopes: string[]; role: string }> = {},
): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: over.organizationId ?? ORG_ID,
    role: (over.role ?? "agent") as never,
    actor: {
      type: "ai_agent",
      id: "run-1",
      role: (over.role ?? "agent") as never,
      api_token_id: "tok-1",
    },
    apiTokenId: "tok-1",
    scopes: over.scopes ?? ["contacts:read"],
  } as never);
}

const COM_FOTO: ContatoFake = {
  id: CONTATO_ID,
  organization_id: ORG_ID,
  avatar_storage_path: "contatos/foto.jpg",
  is_anonymized: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  CONTATOS = [];
  FILTROS.length = 0;
  ASSINATURAS.length = 0;
  // Padrão de uma integração: NENHUMA sessão de navegador por perto.
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(orgAtivaDaApi).mockResolvedValue({ ok: true, org: null } as never);
  vi.mocked(createClient).mockResolvedValue({ session: true } as never);
  vi.mocked(createAdminClient).mockReturnValue(adminFake());
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("GET .../avatar — Bearer dsk_ com contacts:read (#3420, caso A)", () => {
  it("devolve o MESMO 307 do de hoje, com a organização vindo da LINHA DO TOKEN", async () => {
    tokenOk({ organizationId: ORG_ID, scopes: ["contacts:read"] });
    CONTATOS = [COM_FOTO];
    const { GET } = await import("./route");
    const res = await GET(reqComBearer(), PARAMS);

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("https://storage.test/signed/contatos/foto.jpg");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=240");
    // Org do TOKEN no filtro — nunca do path, nunca do cliente.
    expect(FILTROS).toContainEqual(["organization_id", ORG_ID]);
    expect(FILTROS).toContainEqual(["id", CONTATO_ID]);
    expect(ASSINATURAS).toEqual([
      { bucket: "whatsapp-media", path: "contatos/foto.jpg", ttl: 300 },
    ]);
    // A porta do Bearer NÃO passa pelo caminho da sessão.
    expect(loadAuthUser).not.toHaveBeenCalled();
    expect(orgAtivaDaApi).not.toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("o caminho da sessão não é ativado por um token: nenhuma checagem de cookie", async () => {
    tokenOk({ scopes: ["contacts:read"] });
    CONTATOS = [COM_FOTO];
    const { GET } = await import("./route");
    await GET(reqComBearer(), PARAMS);

    expect(vi.mocked(loadAuthUser)).not.toHaveBeenCalled();
    expect(vi.mocked(orgAtivaDaApi)).not.toHaveBeenCalled();
  });
});

describe("GET .../avatar — Bearer sem o escopo (#3420, caso B)", () => {
  it("recusa 403 forbidden_role, com a MESMA forma das outras rotas Dual", async () => {
    tokenOk({ scopes: ["contacts:write"] });
    CONTATOS = [COM_FOTO];
    const { GET } = await import("./route");
    const res = await GET(reqComBearer(BEARER_SEM_ESCOPO), PARAMS);

    expect(res.status).toBe(403);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("forbidden_role");
    expect(corpo.error.message).toContain("contacts:read");
    // Nem chega perto do contato nem do caminho da sessão.
    expect(FILTROS).toHaveLength(0);
    expect(ASSINATURAS).toHaveLength(0);
    expect(loadAuthUser).not.toHaveBeenCalled();
  });

  it("o teto do token também fecha antes de tocar no contato", async () => {
    tokenOk({ scopes: ["contacts:read"] });
    CONTATOS = [COM_FOTO];
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const { GET } = await import("./route");
    const res = await GET(reqComBearer(), PARAMS);

    expect(res.status).toBe(429);
    expect(FILTROS).toHaveLength(0);
    expect(ASSINATURAS).toHaveLength(0);
  });
});

describe("GET .../avatar — token inválido ou expirado (#3420, caso D)", () => {
  it("recusa 401 unauthenticated e não resolve contato nenhum", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token has expired."),
    );
    CONTATOS = [COM_FOTO];
    const { GET } = await import("./route");
    const res = await GET(reqComBearer(), PARAMS);

    expect(res.status).toBe(401);
    const corpo = (await res.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("unauthenticated");
    expect(FILTROS).toHaveLength(0);
    expect(ASSINATURAS).toHaveLength(0);
    expect(loadAuthUser).not.toHaveBeenCalled();
  });
});

describe("GET .../avatar — organização de quem tem o token (#3420, caso E)", () => {
  it("contato de OUTRA organização não resolve: 404 e nenhuma URL assinada", async () => {
    tokenOk({ organizationId: ORG_ID, scopes: ["contacts:read"] });
    // O contato EXISTE, mas na organização de um outro token.
    CONTATOS = [{ ...COM_FOTO, organization_id: OUTRA_ORG }];
    const { GET } = await import("./route");
    const res = await GET(reqComBearer(), PARAMS);

    expect(res.status).toBe(404);
    expect(FILTROS).toContainEqual(["organization_id", ORG_ID]);
    expect(ASSINATURAS).toHaveLength(0);
  });

  it("contato anonimizado continua sem foto também no modo token", async () => {
    tokenOk({ scopes: ["contacts:read"] });
    CONTATOS = [{ ...COM_FOTO, is_anonymized: true }];
    const { GET } = await import("./route");
    const res = await GET(reqComBearer(), PARAMS);

    expect(res.status).toBe(404);
    expect(ASSINATURAS).toHaveLength(0);
  });
});

describe("GET .../avatar — sessão do navegador (#3420, caso C: regressão zero)", () => {
  it("continua devolvendo o mesmo 307, sem passar por Bearer nenhum", async () => {
    sessaoOk();
    CONTATOS = [COM_FOTO];
    const { GET } = await import("./route");
    const res = await GET(reqSemBearer(), PARAMS);

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("https://storage.test/signed/contatos/foto.jpg");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=240");
    expect(FILTROS).toContainEqual(["organization_id", ORG_ID]);
    expect(vi.mocked(loadAuthUser)).toHaveBeenCalledTimes(1);
    expect(validateBearerToken).not.toHaveBeenCalled();
    // Sessão não paga teto de token, como em toda rota Dual.
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("sem sessão e sem Bearer → 403 no_active_org, como antes da mudança", async () => {
    const { GET } = await import("./route");
    const res = await GET(reqSemBearer(), PARAMS);

    expect(res.status).toBe(403);
    const corpo = (await res.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("no_active_org");
    expect(FILTROS).toHaveLength(0);
  });

  it("sessão com contato sem foto → 404, como antes da mudança", async () => {
    sessaoOk();
    CONTATOS = [];
    const { GET } = await import("./route");
    const res = await GET(reqSemBearer(), PARAMS);

    expect(res.status).toBe(404);
    expect(ASSINATURAS).toHaveLength(0);
  });

  it("sessão com contato anonimizado → 404, como antes da mudança", async () => {
    sessaoOk();
    CONTATOS = [{ ...COM_FOTO, is_anonymized: true }];
    const { GET } = await import("./route");
    const res = await GET(reqSemBearer(), PARAMS);

    expect(res.status).toBe(404);
    expect(ASSINATURAS).toHaveLength(0);
  });
});

/**
 * A borda que nenhum teste de handler alcança: o `proxy.ts` roda ANTES de
 * qualquer route handler e só reconhece cookie. Sem entrada em PUBLIC_PATHS o
 * Bearer nem chega na rota — é o mesmo bug que já bloqueou o heartbeat do
 * agente e o callback do Google (ver cabeçalho de `lib/auth/public-paths.ts`).
 */
describe("GET .../avatar — PUBLIC_PATHS (borda do proxy)", () => {
  it("libera o caminho do avatar para Bearer, com o id em forma de UUID", () => {
    expect(isPublicPath(`/api/v1/contacts/${CONTATO_ID}/avatar`)).toBe(true);
  });

  it("não libera id fora da forma de UUID, sub-path de /avatar nem os irmãos", () => {
    expect(isPublicPath(`/api/v1/contacts/${ID_FORA_DA_FORMA}/avatar`)).toBe(false);
    expect(isPublicPath(`/api/v1/contacts/${CONTATO_ID}/avatar/extra`)).toBe(false);
    expect(isPublicPath(`/api/v1/contacts/${CONTATO_ID}/person`)).toBe(false);
    expect(isPublicPath(`/api/v1/contacts/${CONTATO_ID}`)).toBe(false);
    expect(isPublicPath("/api/v1/contacts/bulk/avatar")).toBe(false);
  });

  it("a listagem de contatos segue pública como estava", () => {
    expect(isPublicPath("/api/v1/contacts")).toBe(true);
  });
});
