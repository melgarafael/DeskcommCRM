/**
 * AGENDA ACEITA TOKEN DE INTEGRAÇÃO (Spec 33, fatia R2, tarefa 4).
 *
 * Guiado por tabela. Cada método convertido tem seis testes (alcança, não
 * alcança, sem escopo, abaixo do papel, teto, sessão). Cada método que FICOU
 * SÓ DE SESSÃO tem um caso: com token e sem cookie, 401 e o banco não é tocado.
 *
 * Os dublês: `criarClienteAdminFalso` (registra cada cadeia, RPC e arquivo) no
 * lugar da service role; o cliente de sessão LANÇA no ramo do token. A consulta
 * de horários livres é mockada no ponto de chamada: a prova de organização aqui
 * é a que a ROTA faz (a organização que chega ao motor). Os filtros do motor
 * foram conferidos por leitura de `lib/agenda/consulta.ts`, não por execução.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { isPublicPath } from "@/lib/auth/public-paths";

import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  linhasDaTabela,
  rpcsForaDaOrganizacao,
} from "../helpers/cliente-admin-falso";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  sessao: vi.fn(),
  admin: vi.fn(),
  rate: vi.fn(),
  validar: vi.fn(),
  consulta: vi.fn(),
  rotulos: vi.fn(),
  token: { papel: "admin" as string, escopos: [] as string[] },
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.sessao }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.rate }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: deps.validar };
});
vi.mock("@/lib/agenda/consulta", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agenda/consulta")>("@/lib/agenda/consulta");
  return { ...actual, horariosLivresDaOrg: deps.consulta };
});
vi.mock("@/lib/agenda/rotulos-dos-responsaveis", () => ({
  rotulosDosResponsaveisDaAgenda: deps.rotulos,
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const TIPO_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TIPO_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const CONTATO_A = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const CONTATO_B = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5";
const EXC_A = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
const EXC_B = "7b7b7b7b-7b7b-47b7-87b7-7b7b7b7b7b7b";
const AGENDAMENTO = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const TOKEN_A = "Bearer tok-a";
const TOKEN_B = "Bearer tok-b";

type Papel = "viewer" | "agent" | "manager" | "admin";
type Metodo = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Ctx = { params: Promise<Record<string, string>> };
type Handler = (req: NextRequest, ctx?: Ctx) => Promise<Response>;
type Modulo = Partial<Record<Metodo, Handler>>;
type Falso = ReturnType<typeof criarClienteAdminFalso>;

const ORDEM: readonly Papel[] = ["viewer", "agent", "manager", "admin"];
/** Um degrau abaixo do papel, ou `null` quando não há (viewer). */
function abaixo(papel: Papel): Papel | null {
  const i = ORDEM.indexOf(papel);
  return i > 0 ? (ORDEM[i - 1] ?? null) : null;
}

type Caso = {
  nome: string;
  modulo: () => Promise<Modulo>;
  metodo: "GET" | "POST";
  url: string;
  corpo?: unknown;
  papel: Papel;
  /** Papel do token quando a tool MCP da mesma ação exige mais (`tokenRole`). */
  papelDoToken?: Papel;
  escopo: "mcp:read" | "mcp:write";
  linhas: Record<string, Record<string, unknown>[]>;
  /** Texto que só existe nas linhas de A: aparece na resposta de A, não na de B. */
  marcaA?: string;
  /** B: "lista" (200 sem a marca de A), "cria" (201 na organização de B), "nao_acha" (404). */
  alcancaB: "lista" | "cria" | "nao_acha";
  statusA: number;
  semOrganizacao?: readonly string[];
  /** Resposta das RPCs do cliente falso, por nome (o `data` devolvido). */
  rpc?: Record<string, unknown>;
  /** Asserção extra: `"A"` ou `"B"` diz de qual token é a chamada. */
  extra?: (quem: "A" | "B") => void;
};

function pedido(caso: Caso, cabecalho?: string): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (cabecalho) headers.set("authorization", cabecalho);
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = { method: caso.metodo, headers };
  if (caso.metodo !== "GET") init.body = JSON.stringify(caso.corpo ?? {});
  return new NextRequest(`http://localhost${caso.url}`, init);
}

async function chamar(caso: Caso, cabecalho?: string): Promise<Response> {
  const handler = (await caso.modulo())[caso.metodo];
  if (!handler) throw new Error(`${caso.metodo} ausente em ${caso.nome}`);
  return handler(pedido(caso, cabecalho));
}

const CASOS: Caso[] = [
  {
    nome: "GET /api/v1/agenda/aviso",
    modulo: () => import("@/app/api/v1/agenda/aviso/route") as unknown as Promise<Modulo>,
    metodo: "GET",
    url: "/api/v1/agenda/aviso",
    papel: "admin",
    escopo: "mcp:read",
    linhas: {
      organizations: [
        { id: ORG_A, timezone: "America/Sao_Paulo" },
        { id: ORG_B, timezone: "America/Sao_Paulo" },
      ],
      config_aviso_de_agendamento: [
        { organization_id: ORG_A, usa_numero_do_aviso_de_caso: true, channel_session_id: null, telefone_destino: null, grupo_destino: "111111@g.us", ligado: true, updated_at: "2026-11-01T00:00:00Z" },
        { organization_id: ORG_B, usa_numero_do_aviso_de_caso: true, channel_session_id: null, telefone_destino: null, grupo_destino: "222222@g.us", ligado: true, updated_at: "2026-11-01T00:00:00Z" },
      ],
      config_aviso_de_caso: [],
      channel_sessions: [
        { id: "9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a", organization_id: ORG_A, display_name: "Canal da A", status: "connected", phone_number: null, waha_session_name: "a", provider: "waha", archived_at: null, created_at: "2026-01-01T00:00:00Z" },
        { id: "9b9b9b9b-9b9b-49b9-89b9-9b9b9b9b9b9b", organization_id: ORG_B, display_name: "Canal da B", status: "connected", phone_number: null, waha_session_name: "b", provider: "waha", archived_at: null, created_at: "2026-01-01T00:00:00Z" },
      ],
      entregas_de_aviso_de_agendamento: [],
    },
    marcaA: "111111@g.us",
    alcancaB: "lista",
    statusA: 200,
  },
  {
    nome: "GET /api/v1/agenda/configuracao",
    modulo: () => import("@/app/api/v1/agenda/configuracao/route") as unknown as Promise<Modulo>,
    metodo: "GET",
    url: "/api/v1/agenda/configuracao",
    papel: "viewer",
    escopo: "mcp:read",
    linhas: { organizations: [{ id: ORG_A, settings: {} }, { id: ORG_B, settings: {} }] },
    alcancaB: "lista",
    statusA: 200,
    // viewer: não há degrau abaixo; o caso "abaixo do papel" não existe para este método.
  },
  {
    // Leitura da grade. O token é `manager` (a sessão de atendente pode ver só a própria agenda;
    // o token lê a organização inteira). `donosDaAgenda` e a ocupação do Google também ficam na
    // organização do token: a RPC da ocupação recebe `p_org` e o dono SÓ da organização.
    nome: "GET /api/v1/agenda/agendamentos",
    modulo: () => import("@/app/api/v1/agenda/agendamentos/route") as unknown as Promise<Modulo>,
    metodo: "GET",
    url: "/api/v1/agenda/agendamentos?de=2026-11-10T00:00:00Z&ate=2026-11-11T00:00:00Z",
    papel: "viewer",
    papelDoToken: "manager",
    escopo: "mcp:read",
    linhas: {
      calendar_appointments: [
        { id: AGENDAMENTO, organization_id: ORG_A, title: "Consulta da A", starts_at: "2026-11-10T13:00:00Z", ends_at: "2026-11-10T14:00:00Z", time_zone: "America/Sao_Paulo", status: "confirmed", revision: 1, meeting_state: null, meeting_url: null, owner_user_id: USER_A, contact_id: null, location_kind: null, location_details: null, service_block: false, service_occurrence_id: null },
        { id: "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4", organization_id: ORG_B, title: "Consulta da B", starts_at: "2026-11-10T13:00:00Z", ends_at: "2026-11-10T14:00:00Z", time_zone: "America/Sao_Paulo", status: "confirmed", revision: 1, meeting_state: null, meeting_url: null, owner_user_id: USER_B, contact_id: null, location_kind: null, location_details: null, service_block: false, service_occurrence_id: null },
      ],
      user_organizations: [
        { user_id: USER_A, organization_id: ORG_A, role: "agent", revoked_at: null },
        { user_id: USER_B, organization_id: ORG_B, role: "agent", revoked_at: null },
      ],
    },
    rpc: { fn_agenda_ocupacao_google_do_dono: [] },
    marcaA: "Consulta da A",
    alcancaB: "lista",
    statusA: 200,
    extra: () => {
      // Todo dono perguntado à ocupação do Google pertence à organização do token.
      for (const r of falso.rpcs.filter((x) => x.nome === "fn_agenda_ocupacao_google_do_dono")) {
        expect([USER_A, USER_B]).toContain(r.args.p_owner);
      }
    },
  },
  {
    nome: "GET /api/v1/agenda/servicos",
    modulo: () => import("@/app/api/v1/agenda/servicos/route") as unknown as Promise<Modulo>,
    metodo: "GET",
    url: "/api/v1/agenda/servicos",
    papel: "viewer",
    papelDoToken: "manager",
    escopo: "mcp:read",
    linhas: {
      calendar_resources: [
        { id: "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a8a8", organization_id: ORG_A, name: "Sala da A", capacity: 1, is_active: true, revision: 1 },
        { id: "b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b8", organization_id: ORG_B, name: "Sala da B", capacity: 1, is_active: true, revision: 1 },
      ],
      calendar_service_blocks: [],
    },
    rpc: { fn_calendar_service_catalog: [] },
    marcaA: "Sala da A",
    alcancaB: "lista",
    statusA: 200,
    extra: (quem) => {
      // A RPC do catálogo recebe a organização do token, nunca outra.
      const catalogo = falso.rpcs.filter((r) => r.nome === "fn_calendar_service_catalog");
      expect(catalogo.length).toBeGreaterThan(0);
      expect(catalogo.every((r) => r.args.p_org === (quem === "A" ? ORG_A : ORG_B))).toBe(true);
    },
  },
  {
    nome: "GET /api/v1/agenda/enderecos",
    modulo: () => import("@/app/api/v1/agenda/enderecos/route") as unknown as Promise<Modulo>,
    metodo: "GET",
    url: "/api/v1/agenda/enderecos",
    papel: "agent",
    escopo: "mcp:read",
    linhas: {
      calendar_locations: [
        { id: "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3", organization_id: ORG_A, address: "Endereço da A" },
        { id: "8c8c8c8c-8c8c-48c8-88c8-8c8c8c8c8c8c", organization_id: ORG_B, address: "Endereço da B" },
      ],
    },
    marcaA: "Endereço da A",
    alcancaB: "lista",
    statusA: 200,
  },
  {
    nome: "POST /api/v1/agenda/enderecos",
    modulo: () => import("@/app/api/v1/agenda/enderecos/route") as unknown as Promise<Modulo>,
    metodo: "POST",
    url: "/api/v1/agenda/enderecos",
    corpo: { address: "Sala Nova" },
    papel: "agent",
    escopo: "mcp:write",
    linhas: { calendar_locations: [] },
    marcaA: "Sala Nova",
    alcancaB: "cria",
    statusA: 201,
  },
  {
    nome: "GET /api/v1/agenda/excecoes",
    modulo: () => import("@/app/api/v1/agenda/excecoes/route") as unknown as Promise<Modulo>,
    metodo: "GET",
    url: "/api/v1/agenda/excecoes?de=2026-11-01&ate=2026-12-31",
    papel: "agent",
    escopo: "mcp:read",
    linhas: {
      calendar_availability_exceptions: [
        { id: EXC_A, organization_id: ORG_A, user_id: USER_A, exception_date: "2026-11-10", is_unavailable: true, start_minute: 0, end_minute: 1440, reason: "A" },
        { id: EXC_B, organization_id: ORG_B, user_id: USER_B, exception_date: "2026-11-10", is_unavailable: true, start_minute: 0, end_minute: 1440, reason: "B" },
      ],
    },
    marcaA: EXC_A,
    alcancaB: "lista",
    statusA: 200,
  },
  {
    nome: "GET /api/v1/agenda/horarios-livres",
    modulo: () => import("@/app/api/v1/agenda/horarios-livres/route") as unknown as Promise<Modulo>,
    metodo: "GET",
    url: `/api/v1/agenda/horarios-livres?event_type_id=${TIPO_A}&de=2026-11-10T00:00:00Z&ate=2026-11-11T00:00:00Z`,
    papel: "viewer",
    // `crm_find_free_slots` (MCP) exige `agent`: o token para ler horários livres é `agent`.
    papelDoToken: "agent",
    escopo: "mcp:read",
    linhas: {},
    alcancaB: "lista",
    statusA: 200,
    extra: (quem) => {
      // O token de cada organização chega ao motor com a SUA organização, nunca a de outra.
      expect(deps.consulta.mock.calls.at(-1)?.[1]).toBe(quem === "A" ? ORG_A : ORG_B);
    },
  },
  {
    nome: "GET /api/v1/agenda/pessoas",
    modulo: () => import("@/app/api/v1/agenda/pessoas/route") as unknown as Promise<Modulo>,
    metodo: "GET",
    url: "/api/v1/agenda/pessoas",
    papel: "agent",
    escopo: "mcp:read",
    linhas: {
      user_organizations: [
        { user_id: USER_A, organization_id: ORG_A, role: "agent", created_at: "2026-01-01T00:00:00Z", revoked_at: null },
        { user_id: USER_B, organization_id: ORG_B, role: "agent", created_at: "2026-01-01T00:00:00Z", revoked_at: null },
      ],
    },
    marcaA: USER_A,
    alcancaB: "lista",
    statusA: 200,
  },
  {
    nome: "POST /api/v1/agenda/tipos/reativar",
    modulo: () => import("@/app/api/v1/agenda/tipos/reativar/route") as unknown as Promise<Modulo>,
    metodo: "POST",
    url: "/api/v1/agenda/tipos/reativar",
    corpo: { id: TIPO_A },
    papel: "manager",
    escopo: "mcp:write",
    linhas: {
      calendar_event_types: [
        { id: TIPO_A, organization_id: ORG_A, is_active: false },
        { id: TIPO_B, organization_id: ORG_B, is_active: false },
      ],
    },
    marcaA: TIPO_A,
    alcancaB: "nao_acha",
    statusA: 200,
  },
  {
    nome: "GET /api/v1/agenda/vinculos",
    modulo: () => import("@/app/api/v1/agenda/vinculos/route") as unknown as Promise<Modulo>,
    metodo: "GET",
    url: "/api/v1/agenda/vinculos",
    papel: "agent",
    escopo: "mcp:read",
    linhas: {
      contacts: [
        { id: CONTATO_A, organization_id: ORG_A, name: "Contato da A", display_name: null, phone_number: "5511", is_anonymized: false },
        { id: CONTATO_B, organization_id: ORG_B, name: "Contato da B", display_name: null, phone_number: "5522", is_anonymized: false },
      ],
    },
    marcaA: "Contato da A",
    alcancaB: "lista",
    statusA: 200,
  },
];

let falso: Falso;

/** Estado padrão de cada teste: token administrador com os dois escopos, sessão recusada. */
beforeEach(() => {
  vi.resetAllMocks();
  deps.support.mockResolvedValue(null);
  deps.rate.mockResolvedValue({ allowed: true });
  deps.sessao.mockImplementation(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  });
  deps.token.papel = "admin";
  deps.token.escopos = ["mcp:read", "mcp:write"];
  deps.validar.mockImplementation(async (cabecalho: string) => {
    const doB = cabecalho.includes("tok-b");
    return {
      organizationId: doB ? ORG_B : ORG_A,
      role: deps.token.papel,
      actor: { type: "api_token", id: doB ? "tok-b-id" : "tok-a-id", role: deps.token.papel },
      apiTokenId: doB ? "tok-b-id" : "tok-a-id",
      scopes: [...deps.token.escopos],
    } as never;
  });
  deps.consulta.mockResolvedValue({
    ok: true,
    slots: [],
    publicouHorarios: true,
    fusoDaRegra: "America/Sao_Paulo",
    fusoSuposto: false,
    fontesDefasadas: [],
    googleCoberturaParcial: false,
    agendaExternaNuncaLida: false,
  } as never);
  deps.rotulos.mockImplementation(async (ids: string[]) =>
    new Map(ids.map((id) => [id, { full_name: "Nome", display_label: "Nome" }])),
  );
});

function preparar(caso: Caso): void {
  falso = criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: caso.linhas,
    ...(caso.rpc ? { rpc: caso.rpc } : {}),
    tabelasSemOrganizacao: caso.semOrganizacao,
  });
  deps.admin.mockReturnValue(falso.cliente as never);
  deps.token.papel = caso.papelDoToken ?? caso.papel;
  deps.token.escopos = [caso.escopo, caso.escopo === "mcp:read" ? "mcp:write" : "mcp:read"];
}

for (const caso of CASOS) {
  describe(caso.nome, () => {
    beforeEach(() => preparar(caso));

    it(`${caso.metodo} ${caso.url}: token de A alcança o recurso de A`, async () => {
      const res = await chamar(caso, TOKEN_A);
      expect(res.status).toBe(caso.statusA);
      if (caso.marcaA) expect(await res.text()).toContain(caso.marcaA);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: caso.semOrganizacao })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
      expect(deps.role).not.toHaveBeenCalled();
      if (caso.metodo === "POST") {
        expect(deps.audit).toHaveBeenCalledWith(
          expect.objectContaining({ actorUserId: null, actorApiTokenId: "tok-a-id", organizationId: ORG_A }),
        );
      }
      caso.extra?.("A");
    });

    it(`${caso.metodo} ${caso.url}: token de B não alcança o recurso de A`, async () => {
      const res = await chamar(caso, TOKEN_B);
      const corpo = await res.text();
      if (caso.alcancaB === "lista") {
        expect(res.status).toBe(200);
        if (caso.marcaA) expect(corpo).not.toContain(caso.marcaA);
      } else if (caso.alcancaB === "cria") {
        expect(res.status).toBe(201);
        const linhas = linhasDaTabela(falso, "calendar_locations");
        expect(linhas.length).toBeGreaterThan(0);
        expect(linhas.every((l) => l.organization_id === ORG_B)).toBe(true);
        expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_B }));
      } else {
        expect(res.status).toBe(404);
        expect(deps.audit).not.toHaveBeenCalled();
        const tipoA = linhasDaTabela(falso, "calendar_event_types").find((l) => l.id === TIPO_A);
        expect(tipoA?.is_active).toBe(false);
      }
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: caso.semOrganizacao })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      if (caso.metodo === "POST" && caso.alcancaB === "nao_acha") {
        expect(cadeiasDeEscrita(falso.cadeias).every((c) => c.filtros.some(([col, v]) => col === "organization_id" && v === ORG_B))).toBe(true);
      }
      caso.extra?.("B");
    });

    it(`${caso.metodo} ${caso.url}: token sem o escopo é recusado`, async () => {
      deps.token.escopos = [caso.escopo === "mcp:read" ? "mcp:write" : "mcp:read"];
      const res = await chamar(caso, TOKEN_A);
      expect(res.status).toBe(403);
      expect(falso.cadeias).toEqual([]);
    });

    const degrau = abaixo(caso.papelDoToken ?? caso.papel);
    if (degrau !== null) {
      it(`${caso.metodo} ${caso.url}: token abaixo do papel é recusado`, async () => {
        deps.token.papel = degrau;
        const res = await chamar(caso, TOKEN_A);
        expect(res.status).toBe(403);
        expect(falso.cadeias).toEqual([]);
      });
    }

    it(`${caso.metodo} ${caso.url}: acima do teto do token → 429 com Retry-After`, async () => {
      // 1.ª chamada: teto do token (passa). 2.ª: teto da ORGANIZAÇÃO (recusa).
      deps.rate.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false });
      const res = await chamar(caso, TOKEN_A);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(falso.cadeias).toEqual([]);
    });

    it(`${caso.metodo} ${caso.url}: sessão continua com o mesmo portão`, async () => {
      deps.role.mockResolvedValue({
        ok: true,
        user: { id: USER_A, idioma: "pt-BR" },
        org: { orgId: ORG_A, role: caso.papel },
      });
      deps.sessao.mockResolvedValue(falso.cliente);
      const res = await chamar(caso);
      expect(res.status).toBe(caso.statusA);
      expect(deps.role).toHaveBeenCalledWith(caso.papel, expect.anything());
      expect(deps.rate).not.toHaveBeenCalled();
    });
  });
}

/**
 * Métodos que FICARAM SÓ DE SESSÃO nos caminhos que ganharam porta (ou nos
 * caminhos vizinhos). Com token e sem cookie, o `requireRole` recusa com 401 e
 * a service role nunca é aberta. Motivo de cada um: ver o comentário da rota.
 */
const FICA_SO_DE_SESSAO: { nome: string; modulo: string; metodo: Metodo; url: string; corpo?: unknown; ctx?: Ctx }[] = [
  // `fn_calendar_service_can_resolve` exige `auth.uid()`; `owner_user_id === auth.user.id` (minha agenda).
  { nome: "GET /api/v1/agenda/agendamentos/[id]", modulo: "@/app/api/v1/agenda/agendamentos/[id]/route", metodo: "GET", url: `/api/v1/agenda/agendamentos/${AGENDAMENTO}`, ctx: { params: Promise.resolve({ id: AGENDAMENTO }) } },
  // `fn_google_resolve` exige `auth.uid()` e o dono do compromisso.
  { nome: "POST .../google/resolver", modulo: "@/app/api/v1/agenda/agendamentos/[id]/google/resolver/route", metodo: "POST", url: `/api/v1/agenda/agendamentos/${AGENDAMENTO}/google/resolver`, corpo: { expected_domain_revision: "1", expected_google_local_revision: "1", etag: null, choice: "retry" }, ctx: { params: Promise.resolve({ id: AGENDAMENTO }) } },
  // Delega ao `resolver`, que é de sessão.
  { nome: "POST .../google/retry", modulo: "@/app/api/v1/agenda/agendamentos/[id]/google/retry/route", metodo: "POST", url: `/api/v1/agenda/agendamentos/${AGENDAMENTO}/google/retry`, ctx: { params: Promise.resolve({ id: AGENDAMENTO }) } },
  // Conexões do dono (`user_id = auth.user.id`): a pessoa da sessão é o sujeito.
  { nome: "GET /api/v1/agenda/google/calendarios", modulo: "@/app/api/v1/agenda/google/calendarios/route", metodo: "GET", url: "/api/v1/agenda/google/calendarios" },
  // `fn_google_selection` exige `auth.uid()`.
  { nome: "PATCH /api/v1/agenda/google/calendarios", modulo: "@/app/api/v1/agenda/google/calendarios/route", metodo: "PATCH", url: "/api/v1/agenda/google/calendarios", corpo: { revisions: [], sources: [], destination: AGENDAMENTO } },
  // Conexão do próprio usuário (`user_id = auth.user.id`).
  { nome: "POST /api/v1/agenda/google/calendarios/atualizar", modulo: "@/app/api/v1/agenda/google/calendarios/atualizar/route", metodo: "POST", url: "/api/v1/agenda/google/calendarios/atualizar", corpo: { connection_id: AGENDAMENTO } },
  // `fn_definir_aviso_de_agendamento` exige `auth.uid()` (papel, MFA e quem escreve).
  { nome: "PUT /api/v1/agenda/aviso", modulo: "@/app/api/v1/agenda/aviso/route", metodo: "PUT", url: "/api/v1/agenda/aviso", corpo: { usa_numero_do_aviso_de_caso: true, ligado: true } },
  // A pessoa da sessão é a dona da agenda por padrão (`user_id = auth.uid()`): sem sessão, não há dona.
  // O DELETE aceita token desde a R2 (`operacao-r2.test.ts`); o POST segue só de sessão.
  { nome: "POST /api/v1/agenda/excecoes", modulo: "@/app/api/v1/agenda/excecoes/route", metodo: "POST", url: "/api/v1/agenda/excecoes", corpo: { exception_date: "2026-11-10" } },
];

/** Carregadores estáticos: o alias `@/` só resolve em import com caminho literal. */
const CARREGADORES: Record<string, () => Promise<Modulo>> = {
  "@/app/api/v1/agenda/agendamentos/[id]/route": () =>
    import("@/app/api/v1/agenda/agendamentos/[id]/route") as unknown as Promise<Modulo>,
  "@/app/api/v1/agenda/agendamentos/[id]/google/resolver/route": () =>
    import("@/app/api/v1/agenda/agendamentos/[id]/google/resolver/route") as unknown as Promise<Modulo>,
  "@/app/api/v1/agenda/agendamentos/[id]/google/retry/route": () =>
    import("@/app/api/v1/agenda/agendamentos/[id]/google/retry/route") as unknown as Promise<Modulo>,
  "@/app/api/v1/agenda/google/calendarios/route": () =>
    import("@/app/api/v1/agenda/google/calendarios/route") as unknown as Promise<Modulo>,
  "@/app/api/v1/agenda/google/calendarios/atualizar/route": () =>
    import("@/app/api/v1/agenda/google/calendarios/atualizar/route") as unknown as Promise<Modulo>,
  "@/app/api/v1/agenda/excecoes/route": () =>
    import("@/app/api/v1/agenda/excecoes/route") as unknown as Promise<Modulo>,
  "@/app/api/v1/agenda/aviso/route": () =>
    import("@/app/api/v1/agenda/aviso/route") as unknown as Promise<Modulo>,
};

describe("métodos que ficam só de sessão (fica só de sessão: 401, banco intocado)", () => {
  for (const c of FICA_SO_DE_SESSAO) {
    it(`${c.nome}: com token e sem cookie → 401, e a service role nunca é aberta`, async () => {
      deps.support.mockResolvedValue(null);
      deps.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
      const carregar = CARREGADORES[c.modulo];
      if (!carregar) throw new Error(`sem carregador para ${c.modulo}`);
      const modulo = await carregar();
      const handler = modulo[c.metodo];
      if (!handler) throw new Error(`${c.metodo} ausente em ${c.modulo}`);
      const req = new NextRequest(`http://localhost${c.url}`, {
        method: c.metodo,
        headers: { "content-type": "application/json", authorization: TOKEN_A },
        ...(c.metodo === "GET" ? {} : { body: JSON.stringify(c.corpo ?? {}) }),
      });
      const res = await handler(req, c.ctx);
      expect(res.status).toBe(401);
      expect(deps.admin).not.toHaveBeenCalled();
      expect(deps.validar).not.toHaveBeenCalled();
    });
  }
});

/** Os caminhos que ganharam porta nesta fatia. Nenhum tem `[id]`: a borda é o caminho literal. */
const CAMINHOS_COM_PORTA = [
  "/api/v1/agenda/aviso",
  "/api/v1/agenda/configuracao",
  "/api/v1/agenda/enderecos",
  "/api/v1/agenda/excecoes",
  "/api/v1/agenda/horarios-livres",
  "/api/v1/agenda/pessoas",
  "/api/v1/agenda/tipos/reativar",
  "/api/v1/agenda/vinculos",
];

describe("PUBLIC_PATHS da agenda — rotas que já tinham porta e ganharam o GET com token", () => {
  it.each(["/api/v1/agenda/agendamentos", "/api/v1/agenda/servicos"])(
    "libera %s e não libera o sub-path nem o irmão literal",
    (caminho) => {
      expect(isPublicPath(caminho)).toBe(true);
      expect(isPublicPath(`${caminho}/x`)).toBe(false);
    },
  );
});

describe("PUBLIC_PATHS da agenda (borda do proxy)", () => {
  it.each(CAMINHOS_COM_PORTA)("libera %s e não libera o sub-path", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
    expect(isPublicPath(`${caminho}/x`)).toBe(false);
  });

  it("os irmãos que não ganharam porta seguem de sessão", () => {
    expect(isPublicPath(`/api/v1/agenda/agendamentos/${AGENDAMENTO}`)).toBe(false);
    expect(isPublicPath(`/api/v1/agenda/agendamentos/${AGENDAMENTO}/google/resolver`)).toBe(false);
    expect(isPublicPath("/api/v1/agenda/aviso/teste")).toBe(false);
    expect(isPublicPath("/api/v1/agenda/google/calendarios")).toBe(false);
    expect(isPublicPath("/api/v1/agenda/google/calendarios/atualizar")).toBe(false);
    expect(isPublicPath("/api/v1/agenda/tipos/reativar/x")).toBe(false);
  });
});
