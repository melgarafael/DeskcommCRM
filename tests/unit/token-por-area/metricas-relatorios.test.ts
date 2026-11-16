// @vitest-environment node
/**
 * TOKEN DE INTEGRAÇÃO POR ÁREA — MÉTRICAS (`metrics`) E RELATÓRIOS (`reports`)
 * (Spec 33, fatia R3, tarefa 1).
 *
 * No ramo do token, `resolveAuthDual` entrega `createAdminClient()`: a service
 * role, que contorna a RLS. O que protege a organização ali é o filtro
 * `.eq("organization_id", authz.organizationId)` (e o `p_org` das RPCs) que cada
 * rota escreve à mão. Métricas e relatórios SOMAM a organização inteira: um
 * filtro esquecido não devolve 404, devolve um número maior com cara de certo.
 * Por isso o cenário tem linhas das DUAS organizações e a soma de cada token é
 * conferida (A=2 não pode virar 5).
 *
 * Sete testes por rota (tabela `CASOS`), mais o bloco de borda do proxy:
 *   1. token de A alcança o recurso de A (soma de A, nenhuma linha de B);
 *   2. token de B não alcança o recurso de A (as linhas de B saem do cenário:
 *      sobra "nada", e nada de A aparece);
 *   3. com as linhas das duas organizações, o token de B soma só as dele;
 *   4. token sem o escopo da operação é recusado (403);
 *   5. token com papel um degrau abaixo é recusado (403);
 *   6. acima do teto do token → 429 com Retry-After, sem tocar o dado;
 *   7. a sessão continua pelo mesmo portão de antes.
 *
 * As RPCs (`fn_attendant_metrics`, `fn_relatorio_financeiro`,
 * `fn_tags_de_conversa_em_uso`) são dubladas por uma função que só devolve o
 * dado da organização que o `p_org` nomeia: o que o teste prova é QUAL
 * organização a rota nomeou. O corpo das funções (filtram `p_org` em toda
 * tabela; nenhuma usa `auth.uid()`) foi lido na última definição do
 * `supabase/baseline.sql`.
 *
 * `metrics/atrito` GET, `metrics/funil` GET, `metrics/metas` GET,
 * `metrics/channels` GET e `reports/activities` GET são cobertos em
 * `analise.test.ts` (R3, conversão dos GET de análise).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { MODELOS_DE_PORTA, caminhoDoModelo } from "@/lib/auth/portas-de-token";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "../helpers/cliente-admin-falso";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const SESSAO_NO_TOKEN = "cliente de sessão usado no ramo do token";

/**
 * Tabelas SEM a coluna `organization_id` (conferidas no `supabase/baseline.sql`):
 * nenhuma das que estas rotas leem. `organizations` NÃO entra aqui: o falso e
 * `cadeiasForaDaOrganizacao` a tratam pela coluna `id`.
 */
const SEM_ORGANIZACAO = [] as const;

type Papel = "viewer" | "agent" | "manager" | "admin";
type Escopo = "mcp:read" | "mcp:write";
type Tabelas = Record<string, Record<string, unknown>[]>;
type Falso = ReturnType<typeof criarClienteAdminFalso>;
type Linha = Record<string, unknown>;

type Caso = {
  rota: string;
  metodo: "GET" | "PATCH";
  caminho: string;
  executar: (req: NextRequest) => Promise<Response>;
  corpo?: unknown;
  linhas: Tabelas;
  /** RPC → payload por organização (a função dublada devolve o da `p_org`). */
  rpc?: Record<string, Record<string, unknown>>;
  papel: Papel;
  escopo: Escopo;
  recurso: string;
  /** marcas que só a organização A pode ver na resposta */
  soDeA: string[];
  /** marcas que só a organização B pode ver na resposta */
  soDeB: string[];
  /** o número (ou lista) que a resposta declara, para conferir a SOMA */
  leitura?: (data: unknown) => unknown;
  valorA?: unknown;
  valorB?: unknown;
  valorVazio?: unknown;
  /** a rota escreve (PATCH) */
  escreve?: true;
  audita?: string;
  /** a rota lê pelo cliente de sessão (e não só pelo admin) no ramo da sessão */
  clienteDaSessao: boolean;
};

// ───────────────────────────── cenário ─────────────────────────────

const ATENDENTE_A = "a1000000-0000-4000-8000-0000000000a1";
const ATENDENTE_B = "b1000000-0000-4000-8000-0000000000b1";

const RPC_ATENDENTES: Record<string, unknown> = {
  [ORG_A]: {
    excluded_tag: null,
    excluded_conversations: 0,
    funnel: [{ stage_id: "e-a", stage_name: "Etapa-de-A", position: 1, count: 2 }],
    attendants: [
      {
        user_id: ATENDENTE_A,
        won: 2,
        lost: 0,
        conversations_handled: 4,
        avg_first_response_seconds: 100,
        median_first_response_seconds: 90,
      },
    ],
  },
  [ORG_B]: {
    excluded_tag: null,
    excluded_conversations: 0,
    funnel: [{ stage_id: "e-b", stage_name: "Etapa-de-B", position: 1, count: 7 }],
    attendants: [
      {
        user_id: ATENDENTE_B,
        won: 5,
        lost: 1,
        conversations_handled: 9,
        avg_first_response_seconds: 200,
        median_first_response_seconds: 150,
      },
    ],
  },
};

function perda(id: string, org: string, motivo: string, etapa: string, funil: string): Linha {
  return {
    id,
    organization_id: org,
    status: "lost",
    lost_reason: motivo,
    lost_from_stage_id: etapa,
    value_cents: 100,
    currency: "BRL",
    pipeline_id: funil,
    closed_at: "2026-09-15T12:00:00.000Z",
  };
}

const LINHAS_DAS_PERDAS: Tabelas = {
  crm_pipelines: [
    { id: "f-a", organization_id: ORG_A, settings: {} },
    { id: "f-b", organization_id: ORG_B, settings: {} },
  ],
  crm_stages: [
    { id: "e-a", organization_id: ORG_A, name: "Etapa-de-A" },
    { id: "e-b", organization_id: ORG_B, name: "Etapa-de-B" },
  ],
  crm_leads: [
    perda("p1", ORG_A, "Motivo-de-A", "e-a", "f-a"),
    perda("p2", ORG_A, "Motivo-de-A", "e-a", "f-a"),
    perda("p3", ORG_B, "Motivo-de-B", "e-b", "f-b"),
    perda("p4", ORG_B, "Motivo-de-B", "e-b", "f-b"),
    perda("p5", ORG_B, "Motivo-de-B", "e-b", "f-b"),
  ],
};

function ganho(id: string, org: string, status = "won"): Linha {
  return { id, organization_id: org, status, closed_at: "2026-10-10T12:00:00.000Z" };
}

const LINHAS_DA_SERIE: Tabelas = {
  organizations: [
    { id: ORG_A, timezone: "UTC" },
    { id: ORG_B, timezone: "UTC" },
  ],
  crm_leads: [
    ganho("g1", ORG_A),
    ganho("g2", ORG_A),
    ganho("g3", ORG_A, "lost"),
    ganho("g4", ORG_B),
    ganho("g5", ORG_B),
    ganho("g6", ORG_B),
  ],
};

const SETTINGS_A = { outra: "chave-de-A", atrito: { abandono_horas: 72, outra: 1 } };
const SETTINGS_B = { outra: "chave-de-B" };
const LINHAS_DO_ATRITO: Tabelas = {
  organizations: [
    { id: ORG_A, settings: SETTINGS_A },
    { id: ORG_B, settings: SETTINGS_B },
  ],
};

const RPC_FINANCEIRO: Record<string, unknown> = {
  [ORG_A]: {
    entradas_cents: 1000,
    saidas_cents: 100,
    saldo_cents: 900,
    por_forma: [{ nome: "Pix-de-A", quantidade: 1, total_cents: 1000 }],
  },
  [ORG_B]: {
    entradas_cents: 9999,
    saidas_cents: 10,
    saldo_cents: 9989,
    por_forma: [{ nome: "Pix-de-B", quantidade: 4, total_cents: 9999 }],
  },
};

function conversa(id: string, org: string, tag: string): Linha {
  return {
    id,
    organization_id: org,
    tags: [tag],
    status: "open",
    created_at: "2026-10-10T12:00:00.000Z",
    service_started_at: "2026-10-10T12:00:00.000Z",
    service_closed_at: null,
    awaiting_since: null,
    last_outbound_at: null,
  };
}

const LINHAS_DAS_ETIQUETAS: Tabelas = {
  conversations: [
    conversa("c1", ORG_A, "tag-de-a"),
    conversa("c2", ORG_A, "tag-de-a"),
    conversa("c3", ORG_B, "tag-de-b"),
    conversa("c4", ORG_B, "tag-de-b"),
    conversa("c5", ORG_B, "tag-de-b"),
  ],
};
const RPC_ETIQUETAS: Record<string, unknown> = {
  [ORG_A]: [{ tag: "tag-de-a" }],
  [ORG_B]: [{ tag: "tag-de-b" }],
};

const JANELA = "from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z";

type Dados = Record<string, unknown> | null;
const dados = (d: unknown): Dados => d as Dados;

const CASOS: Caso[] = [
  {
    rota: "app/api/v1/metrics/attendants/route.ts",
    metodo: "GET",
    caminho: `/api/v1/metrics/attendants?${JANELA}`,
    executar: async (req) => (await import("@/app/api/v1/metrics/attendants/route")).GET(req),
    linhas: {},
    rpc: { fn_attendant_metrics: RPC_ATENDENTES },
    papel: "agent",
    escopo: "mcp:read",
    recurso: "metrics",
    soDeA: ["Etapa-de-A", ATENDENTE_A],
    soDeB: ["Etapa-de-B", ATENDENTE_B],
    leitura: (d) => (dados(d)?.attendants as Array<{ won: number }>).map((a) => a.won),
    valorA: [2],
    valorB: [5],
    valorVazio: [],
    clienteDaSessao: true,
  },
  {
    rota: "app/api/v1/metrics/lost/route.ts",
    metodo: "GET",
    caminho: `/api/v1/metrics/lost?${JANELA}`,
    executar: async (req) => (await import("@/app/api/v1/metrics/lost/route")).GET(req),
    linhas: LINHAS_DAS_PERDAS,
    papel: "manager",
    escopo: "mcp:read",
    recurso: "metrics",
    soDeA: ["Motivo-de-A", "Etapa-de-A"],
    soDeB: ["Motivo-de-B", "Etapa-de-B"],
    leitura: (d) => dados(d)?.total,
    valorA: 2,
    valorB: 3,
    valorVazio: 0,
    // A rota lê pelo cliente de serviço nos dois ramos.
    clienteDaSessao: false,
  },
  {
    rota: "app/api/v1/metrics/serie/route.ts",
    metodo: "GET",
    caminho: "/api/v1/metrics/serie?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z&granularidade=mes",
    executar: async (req) => (await import("@/app/api/v1/metrics/serie/route")).GET(req),
    linhas: LINHAS_DA_SERIE,
    papel: "agent",
    escopo: "mcp:read",
    recurso: "metrics",
    soDeA: [],
    soDeB: [],
    leitura: (d) => dados(d)?.total,
    valorA: 2,
    valorB: 3,
    valorVazio: 0,
    clienteDaSessao: true,
  },
  {
    rota: "app/api/v1/metrics/atrito/route.ts",
    metodo: "PATCH",
    caminho: "/api/v1/metrics/atrito",
    executar: async (req) => (await import("@/app/api/v1/metrics/atrito/route")).PATCH(req),
    corpo: { abandono_horas: 96 },
    linhas: LINHAS_DO_ATRITO,
    papel: "manager",
    escopo: "mcp:write",
    recurso: "metrics",
    soDeA: [],
    soDeB: [],
    escreve: true,
    audita: "metrics.atrito_regua_changed",
    // A rota escreve pelo cliente de serviço nos dois ramos.
    clienteDaSessao: false,
  },
  {
    rota: "app/api/v1/reports/financeiro/route.ts",
    metodo: "GET",
    caminho: "/api/v1/reports/financeiro?de=2026-10-01&ate=2026-10-31",
    executar: async (req) => (await import("@/app/api/v1/reports/financeiro/route")).GET(req),
    linhas: {},
    rpc: { fn_relatorio_financeiro: RPC_FINANCEIRO },
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "reports",
    soDeA: ["Pix-de-A"],
    soDeB: ["Pix-de-B"],
    leitura: (d) => dados(d)?.entradas_cents ?? null,
    valorA: 1000,
    valorB: 9999,
    valorVazio: null,
    clienteDaSessao: true,
  },
  {
    rota: "app/api/v1/reports/tags/route.ts",
    metodo: "GET",
    caminho: "/api/v1/reports/tags?de=2026-10-01&ate=2026-10-31&tz=UTC",
    executar: async (req) => (await import("@/app/api/v1/reports/tags/route")).GET(req),
    linhas: LINHAS_DAS_ETIQUETAS,
    rpc: { fn_tags_de_conversa_em_uso: RPC_ETIQUETAS },
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "reports",
    soDeA: ["tag-de-a"],
    soDeB: ["tag-de-b"],
    leitura: (d) =>
      (dados(d)?.linhas as Array<{ etiqueta: string; conversas: number }>).map(
        (l) => `${l.etiqueta}:${l.conversas}`,
      ),
    valorA: ["tag-de-a:2"],
    valorB: ["tag-de-b:3"],
    valorVazio: [],
    clienteDaSessao: true,
  },
];

// ───────────────────────────── ajudantes ─────────────────────────────

const ORDEM: readonly Papel[] = ["viewer", "agent", "manager", "admin"];

function umDegrauAbaixo(papel: Papel): Papel | null {
  const i = ORDEM.indexOf(papel);
  return i > 0 ? (ORDEM[i - 1] ?? null) : null;
}

/** O dono da linha: `organizations` é dona de si mesma, pela coluna `id`. */
function donoDa(tabela: string, linha: Linha): unknown {
  return tabela === "organizations" ? linha.id : linha.organization_id;
}

/** O cenário sem nenhuma linha da organização `org`. */
function semLinhasDe(org: string, linhas: Tabelas): Tabelas {
  return Object.fromEntries(
    Object.entries(linhas).map(([tabela, lista]) => [tabela, lista.filter((l) => donoDa(tabela, l) !== org)]),
  );
}

/** As RPCs dubladas: só devolvem o dado da organização que o `p_org` nomeia. */
function rpcDe(c: Caso, orgs: string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(c.rpc ?? {}).map(([nome, porOrg]) => [
      nome,
      (args: Record<string, unknown>) => ({ data: orgs.includes(String(args.p_org)) ? (porOrg[String(args.p_org)] ?? null) : null }),
    ]),
  );
}

/**
 * O falso ganha `auth.admin.getUserById` (o enriquecimento de nome de
 * `metrics/attendants`): o resto é do falso, que lança no que não conhece.
 */
function comAuthAdmin(cliente: unknown): unknown {
  return new Proxy(cliente as object, {
    get(alvo, prop, receptor) {
      if (prop === "auth") {
        return {
          admin: {
            getUserById: async (id: string) => ({
              data: { user: { email: `${id}@exemplo.test`, user_metadata: { full_name: `Nome de ${id}` } } },
            }),
          },
        };
      }
      return Reflect.get(alvo, prop, receptor);
    },
  });
}

function falsoDe(org: string, linhas: Tabelas, c: Caso, orgs: string[]): Falso {
  const f = criarClienteAdminFalso({
    orgDona: org,
    linhas,
    rpc: rpcDe(c, orgs),
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  return { ...f, cliente: comAuthAdmin(f.cliente) };
}

function linhasMudadas(antes: Tabelas, depois: Tabelas) {
  const mudadas: Array<{ tabela: string; linha: Linha }> = [];
  for (const [tabela, lista] of Object.entries(depois)) {
    const antigas = new Set((antes[tabela] ?? []).map((l) => JSON.stringify(l)));
    for (const linha of lista) {
      if (!antigas.has(JSON.stringify(linha))) mudadas.push({ tabela, linha });
    }
  }
  return mudadas;
}

function emitirTokens(opcoes: { scopes: string[]; role: Papel }): void {
  vi.mocked(validateBearerToken).mockImplementation(async (cabecalho) => {
    const quem = cabecalho?.includes(TOKEN_B)
      ? { org: ORG_B, id: TOKEN_B }
      : cabecalho?.includes(TOKEN_A)
        ? { org: ORG_A, id: TOKEN_A }
        : null;
    if (!quem) throw new McpAuthError(-32001, 401, "Invalid token.");
    return {
      organizationId: quem.org,
      role: opcoes.role,
      actor: { type: "api_token", id: quem.id, role: opcoes.role },
      apiTokenId: quem.id,
      scopes: opcoes.scopes,
    };
  });
}

function requisicao(c: Caso, headers: Record<string, string>): NextRequest {
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = { method: c.metodo, headers };
  if (c.corpo !== undefined) {
    init.body = JSON.stringify(c.corpo);
    init.headers = { ...headers, "content-type": "application/json" };
  }
  return new NextRequest(`http://localhost${c.caminho}`, init);
}

async function ler(res: Response): Promise<{ texto: string; data: unknown }> {
  const texto = await res.text();
  const json = texto ? (JSON.parse(texto) as { data?: unknown }) : {};
  return { texto, data: json.data ?? null };
}

function comToken(qual: "A" | "B"): Record<string, string> {
  return { authorization: `Bearer ${qual === "A" ? TOKEN_A : TOKEN_B}` };
}

function nadaTocado(f: Falso): void {
  expect(f.cadeias).toEqual([]);
  expect(f.rpcs).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(SESSAO_NO_TOKEN);
  });
  vi.mocked(loadAuthUser).mockImplementation(async () => {
    throw new Error(SESSAO_NO_TOKEN);
  });
  vi.mocked(createAdminClient).mockImplementation(() => {
    throw new Error("cliente admin sem cenário");
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("sessão consultada no ramo do token");
  });
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(audit).mockResolvedValue(undefined);
  vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
});

// ───────────────────────────── os sete testes por caso ─────────────────────────────

for (const c of CASOS) {
  const rotulo = `${c.metodo} ${c.caminho.split("?")[0]}`;
  const papelDoToken = c.papel;
  const nomesDeRpc = Object.keys(c.rpc ?? {});

  /** Tudo o que a rota leu ou chamou ficou dentro de `org`. */
  function confereDentroDe(f: Falso, org: string): void {
    expect(cadeiasForaDaOrganizacao(f.cadeias, org, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
    expect(rpcsForaDaOrganizacao(f.rpcs, org)).toEqual([]);
    expect(arquivosForaDaOrganizacao(f.uploads, org)).toEqual([]);
    // A RPC foi chamada, com a organização NOMEADA (ausência não passa).
    expect(f.rpcs.map((r) => r.nome)).toEqual(nomesDeRpc);
    for (const r of f.rpcs) expect(r.args.p_org).toBe(org);
    // Controle de vacuidade: a rota consultou mesmo alguma coisa.
    expect(f.cadeias.length + f.rpcs.length).toBeGreaterThan(0);
  }

  describe(`token por área — ${rotulo}`, () => {
    it(`${rotulo}: token de A alcança o recurso de A`, async () => {
      const f = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: papelDoToken });

      const res = await c.executar(requisicao(c, comToken("A")));
      const { texto, data } = await ler(res);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      for (const marca of c.soDeA) expect(texto).toContain(marca);
      for (const marca of c.soDeB) expect(texto).not.toContain(marca);
      // A SOMA de A não inclui nenhuma linha de B.
      if (c.leitura) expect(c.leitura(data)).toEqual(c.valorA);

      confereDentroDe(f, ORG_A);
      const mudadas = linhasMudadas(c.linhas, f.linhas);
      expect(mudadas.filter((m) => donoDa(m.tabela, m.linha) !== ORG_A)).toEqual([]);

      expect(requireRole).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      if (c.metodo !== "GET") expect(requireSupportWrite).toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            organizationId: ORG_A,
            action: c.audita,
            actorUserId: null,
            actorApiTokenId: TOKEN_A,
          }),
        );
        expect(mudadas.length).toBeGreaterThan(0);
        // A organização de B ficou como estava.
        expect(f.linhas.organizations?.find((l) => l.id === ORG_B)).toEqual(
          c.linhas.organizations?.find((l) => l.id === ORG_B),
        );
        const a = f.linhas.organizations?.find((l) => l.id === ORG_A)?.settings as Linha;
        expect(a.outra).toBe("chave-de-A");
        expect((a.atrito as Linha).abandono_horas).toBe(96);
        expect((a.atrito as Linha).outra).toBe(1);
      } else {
        expect(audit).not.toHaveBeenCalled();
      }
    });

    it(`${rotulo}: token de B não alcança o recurso de A`, async () => {
      // As linhas de B saem do cenário: o recurso de A existe, e B não tem nada.
      const entrada = semLinhasDe(ORG_B, c.linhas);
      const f = falsoDe(ORG_B, entrada, c, [ORG_A]);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: papelDoToken });

      const res = await c.executar(requisicao(c, comToken("B")));
      const { texto, data } = await ler(res);

      // Soma sem linha nenhuma: 200 com a lista vazia ou o zero (nunca o 404:
      // agregado de organização sem dado não é recurso inexistente).
      expect(res.status).toBe(200);
      for (const marca of c.soDeA) expect(texto).not.toContain(marca);
      if (c.leitura) expect(c.leitura(data)).toEqual(c.valorVazio);

      confereDentroDe(f, ORG_B);
      const mudadas = linhasMudadas(entrada, f.linhas);
      // Nada de A foi lido nem alterado.
      expect(mudadas.filter((m) => donoDa(m.tabela, m.linha) === ORG_A)).toEqual([]);
      if (c.escreve) {
        // PATCH: a organização de B não existe no cenário, então nada foi gravado.
        expect(mudadas).toEqual([]);
        expect(f.linhas.organizations?.find((l) => l.id === ORG_A)).toEqual(
          entrada.organizations?.find((l) => l.id === ORG_A),
        );
        for (const [chamada] of vi.mocked(audit).mock.calls) {
          expect(chamada).toEqual(
            expect.objectContaining({ organizationId: ORG_B, actorUserId: null, actorApiTokenId: TOKEN_B }),
          );
        }
      } else {
        expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      }
    });

    it(`${rotulo}: com as linhas das duas organizações, o token de B soma só as dele`, async () => {
      const f = falsoDe(ORG_B, c.linhas, c, [ORG_A, ORG_B]);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: papelDoToken });

      const res = await c.executar(requisicao(c, comToken("B")));
      const { texto, data } = await ler(res);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      for (const marca of c.soDeB) expect(texto).toContain(marca);
      for (const marca of c.soDeA) expect(texto).not.toContain(marca);
      // A SOMA de B não inclui nenhuma linha de A.
      if (c.leitura) expect(c.leitura(data)).toEqual(c.valorB);

      confereDentroDe(f, ORG_B);
      const mudadas = linhasMudadas(c.linhas, f.linhas);
      expect(mudadas.filter((m) => donoDa(m.tabela, m.linha) !== ORG_B)).toEqual([]);
      if (c.escreve) {
        // A organização de A ficou como estava; a de B mudou.
        expect(f.linhas.organizations?.find((l) => l.id === ORG_A)).toEqual(
          c.linhas.organizations?.find((l) => l.id === ORG_A),
        );
        expect(mudadas.length).toBeGreaterThan(0);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_B, actorUserId: null, actorApiTokenId: TOKEN_B }),
        );
      }
    });

    it(`${rotulo}: token sem o escopo da operação é recusado`, async () => {
      const f = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      // O escopo da OUTRA operação: `mcp:read` num método de escrita, `mcp:write` num GET.
      const outro: Escopo = c.escopo === "mcp:read" ? "mcp:write" : "mcp:read";
      emitirTokens({ scopes: [outro], role: papelDoToken });

      const res = await c.executar(requisicao(c, comToken("A")));

      expect(res.status).toBe(403);
      nadaTocado(f);
      expect(audit).not.toHaveBeenCalled();
    });

    const abaixo = umDegrauAbaixo(papelDoToken);
    if (abaixo) {
      it(`${rotulo}: token abaixo do papel é recusado`, async () => {
        const f = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
        vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
        emitirTokens({ scopes: [c.escopo], role: abaixo });

        const res = await c.executar(requisicao(c, comToken("A")));

        expect(res.status).toBe(403);
        nadaTocado(f);
        expect(audit).not.toHaveBeenCalled();
      });
    }
    // Papel `viewer` não tem degrau abaixo: não existe token de papel menor que
    // ele, então o caso "abaixo do papel" não existe para `reports/financeiro` e
    // `reports/tags`.

    it(`${rotulo}: acima do teto do token → 429`, async () => {
      const f = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: papelDoToken });
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

      const res = await c.executar(requisicao(c, comToken("A")));

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${c.recurso}:tok:${TOKEN_A}`);
      // O teto vem antes de tocar o banco.
      nadaTocado(f);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${rotulo}: sessão continua com o mesmo portão`, async () => {
      // Sem `Authorization`: o portão é o de sempre, com o papel da tabela.
      const instalacao = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
      const sessao = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
      vi.mocked(createAdminClient).mockReturnValue(instalacao.cliente as never);
      vi.mocked(createClient).mockResolvedValue(sessao.cliente as never);
      vi.mocked(requireRole).mockResolvedValue({
        ok: true,
        user: { id: USUARIO, idioma: "pt-BR" },
        org: { orgId: ORG_A, name: "Org", role: c.papel },
      } as never);

      const res = await c.executar(requisicao(c, {}));
      const { texto, data } = await ler(res);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(requireRole).toHaveBeenCalledWith(c.papel, expect.objectContaining({ resource: c.recurso }));
      for (const marca of c.soDeA) expect(texto).toContain(marca);
      for (const marca of c.soDeB) expect(texto).not.toContain(marca);
      if (c.leitura) expect(c.leitura(data)).toEqual(c.valorA);
      expect(validateBearerToken).not.toHaveBeenCalled();
      // A sessão não tem teto: o contador nem é tocado.
      expect(checkRateLimit).not.toHaveBeenCalled();
      if (c.clienteDaSessao) expect(sessao.cadeias.length + sessao.rpcs.length).toBeGreaterThan(0);
      expect(cadeiasForaDaOrganizacao(sessao.cadeias, ORG_A)).toEqual([]);
      expect(rpcsForaDaOrganizacao(sessao.rpcs, ORG_A)).toEqual([]);
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, action: c.audita, actorUserId: USUARIO }),
        );
        for (const [chamada] of vi.mocked(audit).mock.calls) {
          expect(chamada.actorApiTokenId ?? null).toBeNull();
        }
      }
    });
  });
}

// ───────────────────────────── a borda do proxy ─────────────────────────────

/**
 * O `proxy.ts` roda ANTES de qualquer route handler e só reconhece cookie. Sem
 * a porta em `PUBLIC_PATHS` o Bearer nem chega à rota. A porta é estreita:
 * `$` no fim e nenhum irmão literal de carona.
 *
 * Os irmãos vêm do `ls` das pastas: `metrics/` e `reports/`. Nenhuma das seis
 * rotas tem segmento dinâmico. As portas de `channels`, `funil`, `metas` e
 * `activities` são conferidas em `analise.test.ts`.
 */
describe("PUBLIC_PATHS — as portas de metrics e reports (borda do proxy)", () => {
  const PORTAS = [
    "/api/v1/metrics/atrito",
    "/api/v1/metrics/attendants",
    "/api/v1/metrics/lost",
    "/api/v1/metrics/serie",
    "/api/v1/reports/financeiro",
    "/api/v1/reports/tags",
  ];

  it.each(PORTAS)("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    // sub-path de cada porta
    ...PORTAS.map((p) => `${p}/x`),
    ...PORTAS.map((p) => `${p}/00000000-0000-4000-8000-000000000000`),
    // irmão literal que não ganhou porta
    "/api/v1/metrics/nao-existe",
    "/api/v1/reports/nao-existe",
    // os pais
    "/api/v1/metrics",
    "/api/v1/reports",
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });

  it("as seis portas estão nos modelos de leitura", () => {
    const caminhos = MODELOS_DE_PORTA.map(caminhoDoModelo);
    for (const modelo of PORTAS) expect(caminhos).toContain(modelo);
  });
});
