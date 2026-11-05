// @vitest-environment node
/**
 * Token de integração na área de atendentes e equipe (Spec 33, fatia R1, ordem R1-12).
 *
 * Só DUAS rotas ganham porta, e só o GET de cada uma (leitura de lista):
 *  - `attendants/availability` GET: roster de atendimento. No token, o e-mail de
 *    login NÃO sai (a sessão continua recebendo como antes);
 *  - `team/assignable` GET: destinos de transferência (user_id, nome e papel; sem e-mail).
 *
 * Fora da porta, por decisão da ordem (pessoas e papéis): `team` GET (lista com e-mail
 * de login e último acesso), `attendants/availability/[user_id]` PATCH (muda a
 * disponibilidade de uma pessoa e compara com o `auth.uid()` da sessão), `attendants/presence`
 * POST, e todo convite, troca de papel, revogação e reativação em `team/*`.
 * (`attendants/sector/[user_id]` PUT, `attendants/sectors` GET/POST e `sectors/[id]`
 * PATCH/DELETE passaram a aceitar token na R1 lote 2: ver `config-r1-lote2.test.ts`.)
 *
 * Por caso (token de A alcança, token de B não alcança, escopo, papel, teto, sessão,
 * ramo sem service role) e um bloco de borda para as duas entradas de `PUBLIC_PATHS`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { isPublicPath } from "@/lib/auth/public-paths";
import type { Role } from "@/lib/auth/types";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { isServiceRoleConfigured } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-role")>()),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  mfaEmDivida: vi.fn(),
  mfaEmDividaEstrita: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
  isServiceRoleConfigured: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const TODOS_OS_ESCOPOS = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";

const ANA_A = "11111111-1111-4111-8111-111111111111";
const BRUNO_A = "12121212-1212-4121-8121-121212121212";
const VIEWER_A = "13131313-1313-4131-8131-131313131313";
const ANA_B = "21212121-2121-4212-8212-212121212121";

/**
 * Tabelas SEM `organization_id`: nenhuma das duas rotas lê uma. As quatro que elas
 * tocam (`user_organizations`, `attendant_availability`, `attendant_sector_members`,
 * `conversations`) têm a coluna no `supabase/baseline.sql`.
 */
const SEM_ORGANIZACAO = [] as const;

const LINHAS = {
  user_organizations: [
    { user_id: ANA_A, organization_id: ORG_A, role: "agent", revoked_at: null, created_at: "2026-08-01T10:00:00Z" },
    { user_id: BRUNO_A, organization_id: ORG_A, role: "manager", revoked_at: null, created_at: "2026-08-02T10:00:00Z" },
    { user_id: VIEWER_A, organization_id: ORG_A, role: "viewer", revoked_at: null, created_at: "2026-08-03T10:00:00Z" },
    { user_id: ANA_B, organization_id: ORG_B, role: "agent", revoked_at: null, created_at: "2026-08-01T10:00:00Z" },
  ],
  attendant_availability: [
    {
      user_id: ANA_A,
      organization_id: ORG_A,
      is_available: true,
      capacity: 5,
      schedule: { timezone: "America/Sao_Paulo", windows: [] },
      updated_at: "2026-08-04T12:00:00Z",
      last_heartbeat_at: null,
    },
    {
      user_id: ANA_B,
      organization_id: ORG_B,
      is_available: true,
      capacity: 3,
      schedule: { timezone: "America/Sao_Paulo", windows: [] },
      updated_at: "2026-08-04T12:00:00Z",
      last_heartbeat_at: null,
    },
  ],
  attendant_sector_members: [],
  conversations: [],
};

type Caso = {
  nome: string;
  caminho: string;
  importar: () => Promise<{ GET: (req: NextRequest) => Promise<Response> }>;
  /** Papel da tabela do plano (a sessão e o `role` do `resolveAuthDual`). */
  papel: Role;
  /** `resource` que a rota passa ao `requireRole` (o portão da sessão). */
  recurso: string;
  /** Balde do teto por token/org (2º argumento de `tetoDeEscritaDoToken` na rota). */
  recursoTeto: string;
  /** A linha traz e-mail de login? Só a sessão recebe (availability). */
  comEmail: boolean;
  /** Ids da organização A que a resposta do token de A precisa trazer. */
  doA: string[];
  /** Ids da organização B que a resposta do token de B precisa trazer. */
  doB: string[];
  /** Ids que o ramo SEM service role devolve para a org A (só o que a tabela da rota tem). */
  semServiceRoleA: string[];
};

const CASOS: Caso[] = [
  {
    nome: "GET /api/v1/attendants/availability",
    caminho: "/api/v1/attendants/availability",
    importar: () => import("@/app/api/v1/attendants/availability/route"),
    papel: "agent",
    recurso: "attendant_availability",
    recursoTeto: "attendants_availability",
    comEmail: true,
    doA: [ANA_A, BRUNO_A],
    doB: [ANA_B],
    semServiceRoleA: [ANA_A],
  },
  {
    nome: "GET /api/v1/team/assignable",
    caminho: "/api/v1/team/assignable",
    importar: () => import("@/app/api/v1/team/assignable/route"),
    papel: "agent",
    recurso: "team",
    recursoTeto: "team_assignable",
    comEmail: false,
    doA: [ANA_A, BRUNO_A],
    doB: [ANA_B],
    semServiceRoleA: [ANA_A, BRUNO_A],
  },
];

let falso: ReturnType<typeof criarClienteAdminFalso>;

function novoFalso() {
  return criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: LINHAS,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
}

/**
 * O `auth.admin` que o dublê não tem: nome por usuário. O e-mail vem preenchido de
 * propósito, para o teste ver se ele sai no token (não deve sair). Cada consulta fica
 * registrada em `getUserByIdEspiao.mock.calls`, para o teste provar quem foi pedido.
 */
const getUserByIdEspiao = vi.fn(async (id: string) => ({
  data: {
    user: {
      id,
      email: `${id.slice(0, 8)}@falso.test`,
      user_metadata: { full_name: `Nome ${id.slice(0, 4)}` },
      last_sign_in_at: null,
    },
  },
}));

function clienteAdminComNomes(clienteFalso: unknown) {
  const base = clienteFalso as { from: (tabela: string) => unknown };
  return {
    from: (tabela: string) => base.from(tabela),
    auth: { admin: { getUserById: getUserByIdEspiao } },
  };
}

function consultadosNoAuth(): string[] {
  return getUserByIdEspiao.mock.calls.map(([id]) => id);
}

function tokenDe(org: string, token: string, role: Role, scopes: string[] = TODOS_OS_ESCOPOS): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: token, role },
    apiTokenId: token,
    scopes,
  } as never);
}

function sessaoDeAna(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ANA_A, idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org", role: "agent" },
  } as never);
}

function reqGet(caminho: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost${caminho}`, {
    method: "GET",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function chamar(caso: Caso, token?: string): Promise<Response> {
  const { GET } = await caso.importar();
  return GET(reqGet(caso.caminho, token));
}

/** Chave real do teto: `${recurso}:tok:${id do token}` e `${recurso}:org:${org}`. */
function afirmarChavesDoTeto(caso: Caso, token: string, org: string): void {
  expect(checkRateLimit).toHaveBeenCalledWith(
    `${caso.recursoTeto}:tok:${token}`,
    expect.any(Number),
    expect.any(Number),
  );
  expect(checkRateLimit).toHaveBeenCalledWith(
    `${caso.recursoTeto}:org:${org}`,
    expect.any(Number),
    expect.any(Number),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  falso = novoFalso();
  vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
  vi.mocked(createAdminClient).mockReturnValue(clienteAdminComNomes(falso.cliente) as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  // O ramo do token NÃO pode tocar o cliente de sessão nem o usuário da sessão.
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(loadAuthUser).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: new Response(null, { status: 401 }),
  } as never);
});

// ---------------------------------------------------------------------------
// Os casos, por rota
// ---------------------------------------------------------------------------

for (const caso of CASOS) {
  describe(caso.nome, () => {
    it("token de A alcança o recurso de A: 2xx, sem viewer, sem e-mail, nome do auth.admin, nada de B", async () => {
      tokenDe(ORG_A, TOKEN_A, "admin");

      const res = await chamar(caso, TOKEN_A);

      expect(res.status).toBe(200);
      const texto = await res.text();
      for (const id of caso.doA) expect(texto).toContain(id);
      for (const id of caso.doB) expect(texto).not.toContain(id);
      // Viewer nunca entra no roster nem na lista de destinos.
      expect(texto).not.toContain(VIEWER_A);
      // Nome vem do auth.admin (o dublê põe "Nome <4 primeiros caracteres do id>").
      expect(texto).toContain(`Nome ${ANA_A.slice(0, 4)}`);
      expect(texto).toContain(`Nome ${BRUNO_A.slice(0, 4)}`);
      // E-mail de login não sai no token (a sessão continua recebendo).
      expect(texto).not.toContain("@falso.test");
      const linhas = JSON.parse(texto).data as Array<Record<string, unknown>>;
      for (const linha of linhas) expect(linha.email ?? null).toBeNull();

      // Nenhum id de B foi consultado no auth.admin; os de A foram.
      const consultados = consultadosNoAuth();
      expect(consultados).toEqual(expect.arrayContaining(caso.doA));
      for (const id of caso.doB) expect(consultados).not.toContain(id);

      afirmarChavesDoTeto(caso, TOKEN_A, ORG_A);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    });

    it("token de B não alcança o recurso de A: a lista é só de B, e nenhum id de A é consultado", async () => {
      tokenDe(ORG_B, TOKEN_B, "admin");

      const res = await chamar(caso, TOKEN_B);

      expect(res.status).toBe(200);
      const texto = await res.text();
      for (const id of caso.doA) expect(texto).not.toContain(id);
      for (const id of caso.doB) expect(texto).toContain(id);
      expect(texto).not.toContain(VIEWER_A);
      expect(texto).not.toContain("@falso.test");

      const consultados = consultadosNoAuth();
      expect(consultados).toContain(ANA_B);
      for (const id of caso.doA) expect(consultados).not.toContain(id);

      afirmarChavesDoTeto(caso, TOKEN_B, ORG_B);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    });

    it("token sem config:read é recusado (403, forbidden_role), sem leitura e sem teto", async () => {
      // Escopo da OUTRA operação (escrita) num GET. O escopo é checado antes do teto.
      tokenDe(ORG_A, TOKEN_A, "admin", ["config:write"]);

      const res = await chamar(caso, TOKEN_A);

      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden_role");
      expect(falso.cadeias).toEqual([]);
      expect(getUserByIdEspiao).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
    });

    it("token abaixo do papel (manager < tokenRole admin) é recusado (403, forbidden_role), sem leitura e sem teto", async () => {
      tokenDe(ORG_A, TOKEN_A, "manager");

      const res = await chamar(caso, TOKEN_A);

      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden_role");
      expect(falso.cadeias).toEqual([]);
      expect(getUserByIdEspiao).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
    });

    it("acima do teto DO TOKEN → 429 com Retry-After, sem leitura, e a org NÃO é contada", async () => {
      tokenDe(ORG_A, TOKEN_A, "admin");
      vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false } as never);

      const res = await chamar(caso, TOKEN_A);

      expect(res.status).toBe(429);
      expect((await res.json()).error.code).toBe("rate_limited");
      expect(res.headers.get("Retry-After")).not.toBeNull();
      expect(falso.cadeias).toEqual([]);
      // Sequencial: o teto do token recusou, então o agregado da org não é consultado.
      expect(checkRateLimit).toHaveBeenCalledTimes(1);
      expect(checkRateLimit).toHaveBeenCalledWith(`${caso.recursoTeto}:tok:${TOKEN_A}`, expect.any(Number), expect.any(Number));
    });

    it("acima do teto AGREGADO DA ORGANIZAÇÃO (token dentro do seu teto) → 429, sem leitura", async () => {
      tokenDe(ORG_A, TOKEN_A, "admin");
      vi.mocked(checkRateLimit)
        .mockResolvedValueOnce({ allowed: true } as never)
        .mockResolvedValueOnce({ allowed: false } as never);

      const res = await chamar(caso, TOKEN_A);

      expect(res.status).toBe(429);
      expect((await res.json()).error.code).toBe("rate_limited");
      expect(res.headers.get("Retry-After")).not.toBeNull();
      expect(falso.cadeias).toEqual([]);
      expect(getUserByIdEspiao).not.toHaveBeenCalled();
      afirmarChavesDoTeto(caso, TOKEN_A, ORG_A);
    });

    it("sessão mantém o mesmo portão e a mesma lista de sessão: requireRole(papel, recurso), e-mail só para a sessão", async () => {
      sessaoDeAna();
      vi.mocked(createClient).mockResolvedValue(falso.cliente as never);

      const res = await chamar(caso);

      expect(res.status).toBe(200);
      expect(requireRole).toHaveBeenCalledWith(caso.papel, expect.objectContaining({ resource: caso.recurso }));
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
      const texto = await res.text();
      expect(texto).not.toContain(VIEWER_A);
      for (const id of caso.doA) expect(texto).toContain(id);
      if (caso.comEmail) {
        // A sessão de atendimento continua vendo o e-mail de login.
        expect(texto).toContain("@falso.test");
      } else {
        expect(texto).not.toContain("@falso.test");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Ramo SEM service role (dev): o token lê só a org do token, sem nome nem e-mail
// ---------------------------------------------------------------------------

for (const caso of CASOS) {
  describe(`${caso.nome} — token sem service role configurado`, () => {
    it("lista só da org do token, sem nome nem e-mail, sem consulta ao auth.admin, sem viewer", async () => {
      vi.mocked(isServiceRoleConfigured).mockReturnValue(false);
      tokenDe(ORG_A, TOKEN_A, "admin");

      const res = await chamar(caso, TOKEN_A);

      expect(res.status).toBe(200);
      const texto = await res.text();
      const linhas = JSON.parse(texto).data as Array<Record<string, unknown>>;
      const ids = linhas.map((l) => l.user_id as string);
      expect([...ids].sort()).toEqual([...caso.semServiceRoleA].sort());
      for (const id of caso.doB) expect(texto).not.toContain(id);
      expect(texto).not.toContain(VIEWER_A);
      expect(texto).not.toContain("@falso.test");
      for (const linha of linhas) {
        expect(linha.email ?? null).toBeNull();
        expect((linha.name ?? linha.full_name ?? null) as unknown).toBeNull();
      }
      expect(getUserByIdEspiao).not.toHaveBeenCalled();
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Bloco de borda das duas entradas de PUBLIC_PATHS
// ---------------------------------------------------------------------------

describe("entradas de PUBLIC_PATHS da área (bloco de borda)", () => {
  it("attendants/availability: exata; o [user_id] irmão e os irmãos literais seguem só de sessão", () => {
    expect(isPublicPath("/api/v1/attendants/availability")).toBe(true);
    expect(isPublicPath("/api/v1/attendants/availability/x")).toBe(false);
    expect(isPublicPath(`/api/v1/attendants/availability/${ANA_A}`)).toBe(false);
    expect(isPublicPath("/api/v1/attendants/presence")).toBe(false);
  });

  it("team/assignable: exata; team, invite e [user_id] irmãos seguem só de sessão", () => {
    expect(isPublicPath("/api/v1/team/assignable")).toBe(true);
    expect(isPublicPath("/api/v1/team/assignable/x")).toBe(false);
    expect(isPublicPath("/api/v1/team")).toBe(false);
    expect(isPublicPath("/api/v1/team/invite")).toBe(false);
    expect(isPublicPath("/api/v1/team/invites")).toBe(false);
    expect(isPublicPath(`/api/v1/team/${ANA_A}`)).toBe(false);
  });
});
