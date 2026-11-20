// @vitest-environment node
/**
 * OPERAÇÃO, LOTE 2 DA R2, ACEITA TOKEN (Spec 33, fatia R2, plano p6).
 *
 * As rotas que sobraram da R2 passam a receber o Bearer `dsk_…` por
 * `resolveAuthDual`:
 *
 *  - `agenda/excecoes` DELETE (`tokenRole: manager`);
 *  - `contacts/duplicates/dismiss` POST (pool `pg`, receita A);
 *  - `leads/at-risk` GET (receita B: a sessão segue com `requireRole`).
 *
 * A escrita do financeiro e dos honorários (catálogo, fidelidade, lançamentos,
 * parcelas) NÃO entra (doc 376): segue só de sessão, e o 401 do token está na
 * tabela `SO_SESSAO` de `financeiro.test.ts`. As portas de leitura desses
 * caminhos seguem listadas na borda do proxy abaixo.
 *
 * O cliente do token é a service role: a RLS deixa de proteger, e o
 * `.eq("organization_id", …)` de CADA cadeia é a única barreira. O cliente
 * falso (`../helpers/cliente-admin-falso`) devolve vazio para a cadeia que
 * esquece o filtro, e `cadeiasForaDaOrganizacao` a aponta.
 *
 * Seis testes por método da tabela (alcança, B não alcança A, sem escopo, abaixo
 * do papel, teto, sessão), mais os casos próprios: o ator nulo no que é
 * gravado, o pool do `dismiss`, o POST de exceção só de sessão e a borda do
 * proxy.
 *
 * Não medido aqui: o SQL de `dispensarParDeContatos` (quem prova é o invariante
 * de banco do CI) e a RLS da sessão (o dublê da sessão a imita onde diz).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { dispensarParDeContatos } from "@/lib/contacts/dispensar-par";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "../helpers/cliente-admin-falso";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/contacts/dispensar-par", () => ({ dispensarParDeContatos: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const PESSOA_DA_SESSAO = "c0000000-0000-4000-8000-000000000001";

const CONTATO_A = "a6666666-6666-4666-8666-666666666666";
const CONTATO_A2 = "a6666667-6666-4666-8666-666666666666";
const EXC_A = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
const EXC_B = "7b7b7b7b-7b7b-47b7-87b7-7b7b7b7b7b7b";
const LEAD_A = "a7777777-7777-4777-8777-777777777777";
const LEAD_B = "b7777777-7777-4777-8777-777777777777";
const USER_EXC_A = "11111111-1111-4111-8111-111111111111";
const USER_EXC_B = "22222222-2222-4222-8222-222222222222";

type Linha = Record<string, unknown>;
type Linhas = Record<string, Linha[]>;
type Metodo = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Papel = "viewer" | "agent" | "manager" | "admin";

type Caso = {
  rota: string;
  metodo: Metodo;
  caminho: string;
  params?: Record<string, string>;
  corpo?: unknown;
  linhas: Linhas;
  papel: Papel;
  /** Papel do token quando a rota pede mais dele que da sessão (`tokenRole`). */
  papelDoToken?: Papel;
  escopo: "mcp:read" | "mcp:write";
  recurso: string;
  recursoDoTeto: string;
  rotulo?: string;
  status: number;
  /** Texto que só existe nas linhas de A. */
  marcaA?: string;
  /** Texto que só existe nas linhas de B (com `paraB: "lista"`). */
  marcaB?: string;
  /** A rota audita: com token, o ator é o token; com sessão, a pessoa. */
  audita?: boolean;
  /** O que o token de B recebe quando pede o recurso de A. */
  paraB: "lista" | "404";
  /** A cadeia de escrita existe (update/delete filtrado), mas não alcança linha: o que vale é a linha de A intacta. */
  escritaNoOp?: boolean;
};

/** Tabelas GLOBAIS da instalação, sem `organization_id` no baseline. */
const SEM_ORGANIZACAO: readonly string[] = ["platform_config", "modulos_instalados"];

const CASOS: readonly Caso[] = [
  // ─── agenda/excecoes DELETE: manager no token ────────────────────────────
  {
    rota: "agenda/excecoes",
    metodo: "DELETE",
    caminho: "/api/v1/agenda/excecoes",
    corpo: { id: EXC_A },
    linhas: {
      calendar_availability_exceptions: [
        { id: EXC_A, organization_id: ORG_A, user_id: USER_EXC_A, exception_date: "2026-11-10", reason: "A" },
        { id: EXC_B, organization_id: ORG_B, user_id: USER_EXC_B, exception_date: "2026-11-10", reason: "B" },
      ],
    },
    papel: "agent",
    papelDoToken: "manager",
    escopo: "mcp:write",
    recurso: "agenda",
    recursoDoTeto: "agenda_excecoes_apagar",
    status: 200,
    paraB: "404",
    escritaNoOp: true,
    audita: true,
  },

  // ─── leads/at-risk GET (receita B) ───────────────────────────────────────
  {
    rota: "leads/at-risk",
    metodo: "GET",
    caminho: "/api/v1/leads/at-risk",
    linhas: {
      crm_pipelines: [],
      crm_leads: [
        {
          id: LEAD_A,
          organization_id: ORG_A,
          title: "Negócio da A",
          status: "open",
          contact_id: null,
          owner_user_id: null,
          owner_kind: null,
          owner_agent_id: null,
          stage_id: null,
          pipeline_id: "a8888888-8888-4888-8888-888888888888",
          last_activity_at: "2026-01-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: LEAD_B,
          organization_id: ORG_B,
          title: "Negócio da B",
          status: "open",
          contact_id: null,
          owner_user_id: null,
          owner_kind: null,
          owner_agent_id: null,
          stage_id: null,
          pipeline_id: "b8888888-8888-4888-8888-888888888888",
          last_activity_at: "2026-01-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      demandas: [],
      crm_proposals: [],
      agent_inbox_items: [],
    },
    papel: "agent",
    papelDoToken: "manager",
    escopo: "mcp:read",
    recurso: "leads_at_risk",
    recursoDoTeto: "leads_at_risk",
    status: 200,
    marcaA: "Negócio da A",
    marcaB: "Negócio da B",
    paraB: "lista",
  },
];

const CARREGA: Record<string, () => Promise<Record<string, unknown>>> = {
  "agenda/excecoes": () => import("@/app/api/v1/agenda/excecoes/route"),
  "contacts/duplicates/dismiss": () => import("@/app/api/v1/contacts/duplicates/dismiss/route"),
  "leads/at-risk": () => import("@/app/api/v1/leads/at-risk/route"),
};

const AUTORIZACAO = { authorization: "Bearer dsk_abc_def" };

type Manipulador = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const DEGRAU_ABAIXO: Record<Papel, Papel> = {
  admin: "manager",
  manager: "agent",
  agent: "viewer",
  viewer: "viewer",
};

function nome(c: Caso): string {
  return `${c.metodo} ${c.caminho}${c.rotulo ? ` [${c.rotulo}]` : ""}`;
}

function requisicao(
  c: Pick<Caso, "metodo" | "caminho" | "corpo">,
  cabecalhos: Record<string, string> = {},
): NextRequest {
  const h = new Headers(cabecalhos);
  if (c.corpo !== undefined) h.set("content-type", "application/json");
  return new NextRequest(`http://localhost${c.caminho}`, {
    method: c.metodo,
    headers: h,
    body: c.corpo === undefined ? undefined : JSON.stringify(c.corpo),
  });
}

async function chamar(
  c: Pick<Caso, "rota" | "metodo" | "params">,
  req: NextRequest,
): Promise<Response> {
  const carregar = CARREGA[c.rota];
  if (!carregar) throw new Error(`rota sem carregador: ${c.rota}`);
  const modulo = (await carregar()) as unknown as Record<string, unknown>;
  const manipulador = modulo[c.metodo] as Manipulador;
  return manipulador(req, { params: Promise.resolve(c.params ?? {}) });
}

function tokenValido(o: { org: string; id: string; papel: string; escopos: string[] }): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: o.org,
    role: o.papel,
    actor: { type: "api_token", id: o.id, role: o.papel },
    apiTokenId: o.id,
    scopes: o.escopos,
  } as never);
}

type OpcoesDoToken = { org?: string; papel?: string; escopos?: string[]; linhas?: Linhas };

/** Chama o método com um Bearer; o cliente do banco é o falso, dono das `linhas`. */
async function comoToken(
  c: Pick<Caso, "rota" | "metodo" | "caminho" | "params" | "corpo" | "linhas" | "papel" | "papelDoToken" | "escopo">,
  o: OpcoesDoToken = {},
) {
  const org = o.org ?? ORG_A;
  const falso = criarClienteAdminFalso({
    orgDona: org,
    linhas: o.linhas ?? c.linhas,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  tokenValido({
    org,
    id: org === ORG_A ? TOKEN_A : TOKEN_B,
    papel: o.papel ?? c.papelDoToken ?? c.papel,
    escopos: o.escopos ?? [c.escopo],
  });
  const res = await chamar(c, requisicao(c, AUTORIZACAO));
  const texto = await res.text();
  return { res, texto, falso };
}

/**
 * A sessão passa pela RLS do banco: o cliente do usuário só enxerga a
 * organização dele. O dublê não modela RLS, então o `from` da sessão acrescenta
 * o filtro que ela faria, nas tabelas com organização.
 */
function sessaoComRls(cliente: unknown, org: string) {
  const base = cliente as { from: (tabela: string) => { eq: (c: string, v: unknown) => unknown } };
  return {
    ...(cliente as object),
    from: (tabela: string) => {
      const consulta = base.from(tabela);
      return SEM_ORGANIZACAO.includes(tabela) || tabela === "organizations"
        ? consulta
        : consulta.eq("organization_id", org);
    },
  };
}

/** Chama o método SEM Authorization: o caminho de sessão segue seu portão. */
async function comoSessao(
  c: Pick<Caso, "rota" | "metodo" | "caminho" | "params" | "corpo" | "linhas" | "papel">,
  o: { semRls?: boolean } = {},
) {
  const falso = criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: c.linhas,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createClient).mockImplementation(
    async () =>
      ({
        ...((o.semRls ? falso.cliente : sessaoComRls(falso.cliente, ORG_A)) as object),
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" } },
            error: null,
          }),
        },
      }) as never,
  );
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org", role: c.papel },
  } as never);
  const res = await chamar(c, requisicao(c));
  const texto = await res.text();
  return { res, texto, falso };
}

function daOrganizacao(linhas: Linhas, org: string, tabelas: string[]): Linhas {
  return Object.fromEntries(
    tabelas.map((tabela) => [tabela, (linhas[tabela] ?? []).filter((l) => l.organization_id === org)]),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  });
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole chamado no ramo do token");
  });
  vi.mocked(audit).mockResolvedValue(undefined);
  // O pool do `dismiss`: devolve `nao_encontrado` para a organização que não é dona do par.
  vi.mocked(dispensarParDeContatos).mockImplementation(async (_pool, args) =>
    args.organizationId === ORG_A
      ? { ok: true, criada: true, candidatos: [...args.contactIds].sort() as [string, string] }
      : { ok: false, motivo: "nao_encontrado" },
  );
});

// ─── Os seis testes de cada método convertido ───────────────────────────────

describe("operação (R2, lote 2) aceita token", () => {
  for (const c of CASOS) {
    const n = nome(c);
    const tabelas = Object.keys(c.linhas);

    it(`${n}: token de A alcança o recurso de A`, async () => {
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(c.status);
      expect(
        cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO }),
      ).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
      if (c.marcaA) expect(texto).toContain(c.marcaA);
      if (c.marcaB) expect(texto).not.toContain(c.marcaB);

      expect(requireRole).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      if (c.audita) {
        // Token não é pessoa: `actorUserId` nulo, o ator é o token, a organização é a da linha dele.
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, actorUserId: null, actorApiTokenId: TOKEN_A }),
        );
      } else {
        expect(audit).not.toHaveBeenCalled();
      }
    });

    it(`${n}: token de B não alcança o recurso de A`, async () => {
      const { res, texto, falso } = await comoToken(c, { org: ORG_B });

      switch (c.paraB) {
        case "lista":
          expect(res.status, texto).toBe(200);
          expect(texto).toContain(c.marcaB ?? "");
          if (c.marcaA) expect(texto).not.toContain(c.marcaA);
          expect(audit).not.toHaveBeenCalled();
          break;
        default:
          expect(res.status, texto).toBe(404);
          // `escritaNoOp`: o update/delete existe, filtrado por B, e não alcança a linha de A.
          if (!c.escritaNoOp) expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
          expect(audit).not.toHaveBeenCalled();
      }

      expect(
        cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO }),
      ).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
      // Nada de A mudou: nem linha alterada, nem apagada, nem criada.
      expect(daOrganizacao(falso.linhas, ORG_A, tabelas)).toEqual(daOrganizacao(c.linhas, ORG_A, tabelas));
    });

    it(`${n}: token sem o escopo é recusado`, async () => {
      const outro = c.escopo === "mcp:read" ? "mcp:write" : "mcp:read";
      const { res, texto, falso } = await comoToken(c, { escopos: [outro] });

      expect(res.status, texto).toBe(403);
      // A leitura da flag de módulo (SEM_ORGANIZACAO) acontece antes da autenticação; não é dado.
      expect(falso.cadeias.filter((ch) => !SEM_ORGANIZACAO.includes(ch.tabela))).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(dispensarParDeContatos).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    if ((c.papelDoToken ?? c.papel) !== "viewer") {
      it(`${n}: token abaixo do papel é recusado`, async () => {
        const { res, texto, falso } = await comoToken(c, {
          papel: DEGRAU_ABAIXO[c.papelDoToken ?? c.papel],
        });

        expect(res.status, texto).toBe(403);
        expect(falso.cadeias.filter((ch) => !SEM_ORGANIZACAO.includes(ch.tabela))).toEqual([]);
        expect(falso.rpcs).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }

    it(`${n}: acima do teto da organização → 429`, async () => {
      // O teto do token passa (primeira chamada); o da organização recusa (segunda).
      vi.mocked(checkRateLimit)
        .mockResolvedValueOnce({ allowed: true } as never)
        .mockResolvedValueOnce({ allowed: false } as never);
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(falso.cadeias.filter((ch) => !SEM_ORGANIZACAO.includes(ch.tabela))).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${c.recursoDoTeto}:tok:${TOKEN_A}`);
      expect(vi.mocked(checkRateLimit).mock.calls[1]?.[0]).toBe(`${c.recursoDoTeto}:org:${ORG_A}`);
    });

    it(`${n}: sessão continua com o mesmo portão`, async () => {
      const { res, texto } = await comoSessao(c);

      expect(res.status, texto).toBe(c.status);
      expect(requireRole).toHaveBeenCalledWith(c.papel, expect.objectContaining({ resource: c.recurso }));
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, actorUserId: PESSOA_DA_SESSAO }),
        );
      }
      // Sessão nunca leva o id de um token: a trilha só ganha `actorApiTokenId` com token.
      for (const [entrada] of vi.mocked(audit).mock.calls) {
        expect((entrada as { actorApiTokenId?: unknown }).actorApiTokenId ?? null).toBeNull();
      }
    });
  }
});

// ─── contacts/duplicates/dismiss: o pool `pg`, com o filtro no SQL ──────────

describe("contacts/duplicates/dismiss aceita token (pool pg)", () => {
  const caso = {
    rota: "contacts/duplicates/dismiss",
    metodo: "POST" as const,
    caminho: "/api/v1/contacts/duplicates/dismiss",
    corpo: { contact_ids: [CONTATO_A, CONTATO_A2] },
    linhas: {} as Linhas,
    papel: "manager" as const,
    escopo: "mcp:write" as const,
  };

  it("token de A dispensa o par na organização de A, sem pessoa gravada, e audita o token", async () => {
    const { res, texto } = await comoToken(caso);

    expect(res.status, texto).toBe(201);
    expect(dispensarParDeContatos).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispensarParDeContatos).mock.calls[0]?.[1]).toEqual({
      organizationId: ORG_A,
      contactIds: [CONTATO_A, CONTATO_A2],
      userId: null,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.duplicate_dismissed",
        organizationId: ORG_A,
        actorUserId: null,
        actorApiTokenId: TOKEN_A,
        metadata: { candidates: [CONTATO_A, CONTATO_A2] },
      }),
    );
    expect(requireRole).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("token de B com o par de A: a organização que chega ao pool é a de B, e o par não é achado (404)", async () => {
    // `organization_id` no corpo não tem campo no schema: é descartado.
    const { res, texto } = await comoToken({
      ...caso,
      corpo: { contact_ids: [CONTATO_A, CONTATO_A2], organization_id: ORG_A },
    }, { org: ORG_B });

    expect(res.status, texto).toBe(404);
    expect(vi.mocked(dispensarParDeContatos).mock.calls.map((chamada) => chamada[1].organizationId)).toEqual([ORG_B]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token sem o escopo é recusado (403) e o pool nem é aberto", async () => {
    const { res } = await comoToken(caso, { escopos: ["mcp:read"] });

    expect(res.status).toBe(403);
    expect(dispensarParDeContatos).not.toHaveBeenCalled();
  });

  it("token de agent (abaixo de manager) é recusado (403)", async () => {
    const { res } = await comoToken(caso, { papel: "agent" });

    expect(res.status).toBe(403);
    expect(dispensarParDeContatos).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("acima do teto da organização → 429, e o pool nem é aberto", async () => {
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: true } as never)
      .mockResolvedValueOnce({ allowed: false } as never);
    const { res } = await comoToken(caso);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(dispensarParDeContatos).not.toHaveBeenCalled();
    expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`contacts_duplicates_dismiss:tok:${TOKEN_A}`);
  });

  it("sessão continua com requireRole(manager): a pessoa grava a dispensa e a trilha leva a pessoa", async () => {
    const { res, texto } = await comoSessao(caso);

    expect(res.status, texto).toBe(201);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contact" }));
    expect(vi.mocked(dispensarParDeContatos).mock.calls[0]?.[1]).toEqual({
      organizationId: ORG_A,
      contactIds: [CONTATO_A, CONTATO_A2],
      userId: PESSOA_DA_SESSAO,
    });
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A, actorUserId: PESSOA_DA_SESSAO, actorApiTokenId: null }),
    );
  });
});

// ─── agenda/excecoes: o POST segue só de sessão ─────────────────────────────

describe("agenda/excecoes POST segue só de sessão", () => {
  it("token sem cookie é recusado com 401 e nada é gravado", async () => {
    const falso = criarClienteAdminFalso({
      orgDona: ORG_A,
      linhas: { calendar_availability_exceptions: [] },
      tabelasSemOrganizacao: SEM_ORGANIZACAO,
    });
    vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    tokenValido({ org: ORG_A, id: TOKEN_A, papel: "admin", escopos: ["mcp:read", "mcp:write"] });

    const res = await chamar(
      { rota: "agenda/excecoes", metodo: "POST" },
      requisicao(
        { metodo: "POST", caminho: "/api/v1/agenda/excecoes", corpo: { exception_date: "2026-11-10" } },
        AUTORIZACAO,
      ),
    );

    expect(res.status).toBe(401);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

// ─── PUBLIC_PATHS: as portas novas ──────────────────────────────────────────

describe("PUBLIC_PATHS — as portas do lote 2 da R2", () => {
  const UUID = "00000000-0000-4000-8000-000000000000";

  it.each([
    "/api/v1/agenda/excecoes",
    "/api/v1/contacts/duplicates/dismiss",
    "/api/v1/financeiro/catalogo/contas",
    "/api/v1/financeiro/catalogo/regras_de_comissao",
    "/api/v1/financeiro/fidelidade",
    "/api/v1/financeiro/lancamentos",
    `/api/v1/honorarios/contratos/${UUID}/parcelas`,
    "/api/v1/leads/at-risk",
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    // sub-path de cada porta nova
    "/api/v1/agenda/excecoes/x",
    "/api/v1/contacts/duplicates/dismiss/x",
    "/api/v1/leads/at-risk/x",
    `/api/v1/financeiro/lancamentos/${UUID}/x`,
    // lançamento por id: só escrita, segue só de sessão (doc 376), sem porta
    `/api/v1/financeiro/lancamentos/${UUID}`,
    // id fora da forma de UUID
    "/api/v1/financeiro/lancamentos/abc",
    "/api/v1/honorarios/contratos/abc/parcelas",
    // irmãos literais que seguem só de sessão
    "/api/v1/contacts/duplicates/dismissed",
    "/api/v1/leads/at-risks",
    `/api/v1/honorarios/parcelas/${UUID}/pagar`,
    `/api/v1/financeiro/comandas/${UUID}/estornar`,
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});
