/**
 * TAREFAS, DEMANDAS E CHAMADAS ACEITAM TOKEN (Spec 33, fatia R2, tarefa 9).
 *
 * `resolveAuthDual` entrega, no ramo do token, a service role: a RLS deixa de
 * proteger e o `.eq("organization_id", authz.organizationId)` de CADA cadeia é a
 * única barreira entre a organização do token e as demais. Um dublê que devolve
 * a mesma linha para qualquer consulta não vê a falta dele; o cliente falso
 * (`../helpers/cliente-admin-falso`) vê: uma cadeia de tabela com
 * `organization_id` que não filtra a organização não alcança linha nenhuma, e
 * `cadeiasForaDaOrganizacao` aponta qual foi.
 *
 * Seis testes por método (a receita da R2): o token de A alcança o recurso de
 * A; o token de B não alcança; sem o escopo; abaixo do papel; acima do teto; e a
 * sessão segue com o mesmo portão. Depois, as garantias que só o ramo do token
 * precisa, o método que FICA DE FORA (`POST /api/v1/calls`) e a borda do proxy.
 *
 * ─── Decisões do teste, para quem for ler um vermelho ──────────────────────
 *
 * - "Token de B não alcança" em coleção (`GET /tasks`, `GET /calls`): a lista de
 *   B traz SÓ o que é de B (a de A não aparece), em vez de "lista vazia" — B
 *   tem linhas na mesma tabela de propósito, para o caso "token de A" provar
 *   que a de B também não vaza para o outro lado.
 * - "Token de B não alcança" em método que altera um recurso por id
 *   (`PATCH`/`DELETE`): a cadeia de escrita É emitida (o `update`/`delete` por
 *   id é a primeira coisa que a rota faz, sem ler antes), filtrada por B, e não
 *   alcança linha. O que o teste prova é o EFEITO: 404, as linhas de A
 *   idênticas às de antes, nenhuma cadeia fora de B e nenhum `audit`.
 *   `cadeiasDeEscrita` vazio só vale onde a rota lê antes de escrever.
 * - "Abaixo do papel": `GET /tasks` exige `viewer`, o degrau mais baixo. Não há
 *   papel abaixo dele, então o caso não existe para esse método.
 * - `tokenRole`: nenhuma tool MCP faz a mesma ação de tarefas, demandas e
 *   chamadas (`crm_close_demand` encerra o NEGÓCIO e pede `agent`, o mesmo papel
 *   da rota). O token vale o papel da sessão.
 * - Toda tabela destas cadeias tem a coluna `organization_id` (conferido no
 *   `supabase/baseline.sql`), então a lista de exceções é vazia.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { portaDaAplicacao, type Db } from "@/lib/db";
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
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  portaDaAplicacao: vi.fn(),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

// Depois do vi.mock acima: pega a versão mockada.
const { validateBearerToken } = await import("@/lib/mcp/auth");

// ─── Organizações, tokens e linhas ──────────────────────────────────────────

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const PESSOA_DA_SESSAO = "c0000000-0000-4000-8000-000000000001";
const RESPONSAVEL_A = "a5555555-5555-4555-8555-555555555555";
const RESPONSAVEL_B = "b5555555-5555-4555-8555-555555555555";

const TAREFA_A = "a1111111-1111-4111-8111-111111111111";
const TAREFA_B = "b1111111-1111-4111-8111-111111111111";
const TAREFA_LEGADA_A = "a1111111-1111-4111-8111-222222222222";
const NEGOCIO_A = "a2222222-2222-4222-8222-222222222222";
const NEGOCIO_B = "b2222222-2222-4222-8222-222222222222";
const DEMANDA_A = "a3333333-3333-4333-8333-333333333333";
const DEMANDA_B = "b3333333-3333-4333-8333-333333333333";
const CHAMADA_A = "a4444444-4444-4444-8444-444444444444";
const CHAMADA_B = "b4444444-4444-4444-8444-444444444444";
const CONTATO_A = "a6666666-6666-4666-8666-666666666666";
const CONTATO_B = "b6666666-6666-4666-8666-666666666666";

/**
 * Tabelas destas cadeias SEM a coluna `organization_id`. Nenhuma: `crm_tasks`,
 * `crm_leads`, `contacts`, `demandas`, `voice_calls`, `user_organizations` e
 * `crm_lead_activities` a têm (`supabase/baseline.sql`).
 */
const SEM_ORGANIZACAO = [] as const;

type Linha = Record<string, unknown>;
type Linhas = Record<string, Linha[]>;

const TAREFA_DA_A: Linha = {
  id: TAREFA_A,
  organization_id: ORG_A,
  title: "Ligar de volta",
  description: null,
  due_date: null,
  priority: "medium",
  status: "pending",
  lead_id: NEGOCIO_A,
  contact_id: null,
  demanda_id: null,
  assigned_to: null,
  created_by: null,
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-01T10:00:00.000Z",
};
const TAREFA_DA_B: Linha = {
  ...TAREFA_DA_A,
  id: TAREFA_B,
  organization_id: ORG_B,
  title: "Tarefa da outra empresa",
  lead_id: NEGOCIO_B,
};
const NEGOCIOS: Linha[] = [
  { id: NEGOCIO_A, organization_id: ORG_A, title: "Negócio da A", contact_id: CONTATO_A },
  { id: NEGOCIO_B, organization_id: ORG_B, title: "Negócio secreto da B", contact_id: CONTATO_B },
];
const CONTATOS: Linha[] = [
  { id: CONTATO_A, organization_id: ORG_A, is_personal: false },
  { id: CONTATO_B, organization_id: ORG_B, is_personal: true },
];
const DEMANDAS: Linha[] = [
  {
    id: DEMANDA_A,
    organization_id: ORG_A,
    contact_id: CONTATO_A,
    estado: "aberta",
    revision: 1,
    fechada_em: null,
    proximo_passo: null,
    proximo_passo_em: null,
  },
  {
    id: DEMANDA_B,
    organization_id: ORG_B,
    contact_id: CONTATO_B,
    estado: "aberta",
    revision: 1,
    fechada_em: null,
    proximo_passo: null,
    proximo_passo_em: null,
  },
];
const EQUIPE: Linha[] = [
  { user_id: RESPONSAVEL_A, organization_id: ORG_A, role: "agent", revoked_at: null },
  { user_id: RESPONSAVEL_B, organization_id: ORG_B, role: "agent", revoked_at: null },
];
const CHAMADAS: Linha[] = [
  {
    id: CHAMADA_A,
    organization_id: ORG_A,
    provider: "sip",
    direction: "outbound",
    status: "ended",
    end_reason: null,
    peer_phone: "+5511911110000",
    handled_by: "ai",
    started_at: "2026-11-01T10:00:00.000Z",
    answered_at: "2026-11-01T10:00:05.000Z",
    ended_at: "2026-11-01T10:00:20.000Z",
    duration_ms: 15000,
    transcript: null,
    contact_id: null,
  },
  {
    id: CHAMADA_B,
    organization_id: ORG_B,
    provider: "sip",
    direction: "outbound",
    status: "ended",
    end_reason: null,
    peer_phone: "+5521922220000",
    handled_by: "ai",
    started_at: "2026-11-01T11:00:00.000Z",
    answered_at: "2026-11-01T11:00:05.000Z",
    ended_at: "2026-11-01T11:00:20.000Z",
    duration_ms: 15000,
    transcript: null,
    contact_id: null,
  },
];

const LINHAS_DE_TAREFAS: Linhas = { crm_tasks: [TAREFA_DA_A, TAREFA_DA_B], crm_leads: NEGOCIOS };
const LINHAS_DE_TAREFAS_COM_VINCULOS: Linhas = {
  ...LINHAS_DE_TAREFAS,
  contacts: CONTATOS,
  demandas: DEMANDAS,
  user_organizations: EQUIPE,
};
const LINHAS_DE_DEMANDAS: Linhas = { demandas: DEMANDAS };
const LINHAS_DE_CHAMADAS: Linhas = { voice_calls: CHAMADAS, contacts: CONTATOS };

/** O que só a organização A conhece, e o que só a B conhece: nenhum dos dois pode cruzar. */
const SO_DA_A = [TAREFA_A, NEGOCIO_A, DEMANDA_A, CHAMADA_A, ORG_A, "Ligar de volta", "+5511911110000"];
const SO_DA_B = [
  TAREFA_B,
  NEGOCIO_B,
  DEMANDA_B,
  CHAMADA_B,
  ORG_B,
  "Tarefa da outra empresa",
  "Negócio secreto da B",
  "+5521922220000",
];

/**
 * O que a função `fn_demanda_encerrar` faz no banco, na parte que importa aqui:
 * a demanda é achada por `id` E `organization_id = p_org`; fora disso, `P0002`.
 */
function encerrarDemandaFalso(args: Record<string, unknown>): { data?: unknown; error?: unknown } {
  const viva = DEMANDAS.find((d) => d.id === args.p_demanda && d.organization_id === args.p_org);
  if (!viva) return { error: { code: "P0002", message: "demanda_not_found" } };
  return { data: { id: viva.id, organization_id: viva.organization_id, estado: "resolvida", revision: 2 } };
}

// ─── Os casos: um por método convertido ─────────────────────────────────────

const CARREGA = {
  tasks: () => import("@/app/api/v1/tasks/route"),
  "tasks/[id]": () => import("@/app/api/v1/tasks/[id]/route"),
  "demandas/[id]": () => import("@/app/api/v1/demandas/[id]/route"),
  calls: () => import("@/app/api/v1/calls/route"),
} as const;

type Metodo = "GET" | "POST" | "PATCH" | "DELETE";
type Papel = "viewer" | "agent" | "manager" | "admin";

type Caso = {
  /** Qual `route.ts` (a chave de `CARREGA`). */
  rota: keyof typeof CARREGA;
  metodo: Metodo;
  /** O caminho como o proxy o vê, com a query quando houver. */
  caminho: string;
  params?: Record<string, string>;
  /** Válido para o Zod da rota. */
  corpo?: unknown;
  /** Recurso da organização A (mais uma linha da B na mesma tabela). */
  linhas: Linhas;
  /** O papel que a rota exige da sessão (a tabela do plano). */
  papel: Papel;
  escopo: "mcp:read" | "mcp:write";
  papelDoToken?: "admin";
  /** O `resource` do `resolveAuthDual` e do teto do token. */
  recurso: string;
  rpc?: Record<string, unknown>;
  /** Desambigua dois casos do mesmo método e caminho. */
  rotulo?: string;
  /** O status do sucesso. */
  status: number;
  /** A resposta é uma coleção: o que é de A e o que é de B. */
  colecao?: { daA: string; daB: string };
  /** O método grava `audit`. */
  audita?: boolean;
  /** O método cria uma linha nova em `crm_tasks`. */
  cria?: boolean;
};

const LISTA_DE_TAREFAS: Caso = {
  rota: "tasks",
  metodo: "GET",
  caminho: "/api/v1/tasks",
  linhas: LINHAS_DE_TAREFAS,
  papel: "viewer",
  escopo: "mcp:read",
  recurso: "crm_tasks",
  status: 200,
  colecao: { daA: TAREFA_A, daB: TAREFA_B },
};
const CRIAR_TAREFA: Caso = {
  rota: "tasks",
  metodo: "POST",
  caminho: "/api/v1/tasks",
  corpo: { title: "Nova tarefa", priority: "high" },
  linhas: LINHAS_DE_TAREFAS,
  papel: "agent",
  escopo: "mcp:write",
  recurso: "crm_tasks",
  status: 201,
  audita: true,
  cria: true,
};
const EDITAR_TAREFA: Caso = {
  rota: "tasks/[id]",
  metodo: "PATCH",
  caminho: `/api/v1/tasks/${TAREFA_A}`,
  params: { id: TAREFA_A },
  corpo: { status: "done" },
  linhas: LINHAS_DE_TAREFAS,
  papel: "agent",
  escopo: "mcp:write",
  recurso: "crm_tasks",
  status: 200,
  audita: true,
};
const APAGAR_TAREFA: Caso = {
  rota: "tasks/[id]",
  metodo: "DELETE",
  caminho: `/api/v1/tasks/${TAREFA_A}`,
  params: { id: TAREFA_A },
  linhas: LINHAS_DE_TAREFAS,
  papel: "agent",
  escopo: "mcp:write",
  recurso: "crm_tasks",
  status: 200,
  audita: true,
};
const PROXIMO_PASSO_DA_DEMANDA: Caso = {
  rota: "demandas/[id]",
  metodo: "PATCH",
  caminho: `/api/v1/demandas/${DEMANDA_A}`,
  params: { id: DEMANDA_A },
  corpo: { proximo_passo: "Ligar amanhã às 10h" },
  linhas: LINHAS_DE_DEMANDAS,
  papel: "agent",
  escopo: "mcp:write",
  recurso: "demandas",
  rotulo: "próximo passo",
  status: 200,
  audita: true,
};
const ENCERRAR_DEMANDA: Caso = {
  rota: "demandas/[id]",
  metodo: "PATCH",
  caminho: `/api/v1/demandas/${DEMANDA_A}`,
  params: { id: DEMANDA_A },
  corpo: { action: "encerrar", expected_revision: 1, desfecho: "resolvida" },
  linhas: LINHAS_DE_DEMANDAS,
  papel: "agent",
  escopo: "mcp:write",
  recurso: "demandas",
  rpc: { fn_demanda_encerrar: encerrarDemandaFalso },
  rotulo: "encerrar",
  status: 200,
  audita: true,
};
const LISTA_DE_CHAMADAS: Caso = {
  rota: "calls",
  metodo: "GET",
  caminho: "/api/v1/calls",
  linhas: LINHAS_DE_CHAMADAS,
  papel: "manager",
  escopo: "mcp:read",
  recurso: "voice_calls",
  status: 200,
  colecao: { daA: CHAMADA_A, daB: CHAMADA_B },
};

const CASOS: readonly Caso[] = [
  LISTA_DE_TAREFAS,
  CRIAR_TAREFA,
  EDITAR_TAREFA,
  APAGAR_TAREFA,
  PROXIMO_PASSO_DA_DEMANDA,
  ENCERRAR_DEMANDA,
  LISTA_DE_CHAMADAS,
];

// ─── Ferramentas do teste ───────────────────────────────────────────────────

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

function requisicao(c: Caso, cabecalhos: Record<string, string> = {}): NextRequest {
  const h = new Headers(cabecalhos);
  if (c.corpo !== undefined) h.set("content-type", "application/json");
  return new NextRequest(`http://localhost${c.caminho}`, {
    method: c.metodo,
    headers: h,
    body: c.corpo === undefined ? undefined : JSON.stringify(c.corpo),
  });
}

async function chamar(c: Caso, req: NextRequest): Promise<Response> {
  const modulo = (await CARREGA[c.rota]()) as unknown as Record<string, unknown>;
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
async function comoToken(c: Caso, o: OpcoesDoToken = {}) {
  const org = o.org ?? ORG_A;
  const linhas = o.linhas ?? c.linhas;
  const falso = criarClienteAdminFalso({
    orgDona: org,
    linhas,
    rpc: c.rpc,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  const porta = portaFalsa(linhas);
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  vi.mocked(portaDaAplicacao).mockReturnValue(porta.porta);
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

/** Chama o método SEM Authorization: `requireRole` resolve uma sessão da organização A. */
async function comoSessao(c: Caso) {
  const falso = criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: c.linhas,
    rpc: c.rpc,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  const porta = portaFalsa(c.linhas);
  vi.mocked(createClient).mockResolvedValue(falso.cliente as never);
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  vi.mocked(portaDaAplicacao).mockReturnValue(porta.porta);
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

function json<T>(texto: string): T {
  return JSON.parse(texto) as T;
}

/** Dublê da porta SQL: responde `user_organizations` (responsável) e `demandas`
 * com base nas `linhas` do caso, e `query` (atividade) com lista vazia. */
function portaFalsa(linhas: Linhas): { porta: Db; consultas: Array<{ sql: string; parametros: readonly unknown[] }> } {
  const consultas: Array<{ sql: string; parametros: readonly unknown[] }> = [];
  const porta: Db = {
    async query(sql, parametros = []) {
      consultas.push({ sql, parametros });
      return [];
    },
    async queryOne(sql, parametros = []) {
      consultas.push({ sql, parametros });
      if (sql.includes("user_organizations")) {
        const [orgId, userId] = parametros as [string, string];
        const linha = (linhas.user_organizations ?? []).find(
          (l) => l.organization_id === orgId && l.user_id === userId && l.revoked_at === null && l.role !== "viewer",
        );
        return (linha ?? null) as never;
      }
      if (sql.includes("demandas")) {
        const [orgId, demandaId] = parametros as [string, string];
        const linha = (linhas.demandas ?? []).find((l) => l.organization_id === orgId && l.id === demandaId);
        return (linha ?? null) as never;
      }
      return null;
    },
  };
  return { porta, consultas };
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
});

// ─── Os seis testes de cada método ──────────────────────────────────────────

describe("tarefas, demandas e chamadas aceitam token", () => {
  for (const c of CASOS) {
    const n = nome(c);
    const tabelas = Object.keys(c.linhas);

    it(`${n}: token de A alcança o recurso de A`, async () => {
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(c.status);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
      for (const deB of SO_DA_B) expect(texto).not.toContain(deB);
      if (c.colecao) expect(texto).toContain(c.colecao.daA);

      expect(requireRole).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, actorUserId: null, actorApiTokenId: TOKEN_A }),
        );
      } else {
        expect(audit).not.toHaveBeenCalled();
      }
    });

    it(`${n}: token de B não alcança o recurso de A`, async () => {
      const idsAntes = new Set((c.linhas.crm_tasks ?? []).map((l) => l.id));
      const { res, texto, falso } = await comoToken(c, { org: ORG_B });

      if (c.colecao) {
        // Coleção: a lista de B traz só o que é de B.
        expect(res.status, texto).toBe(200);
        for (const deA of SO_DA_A) expect(texto).not.toContain(deA);
        expect(texto).toContain(c.colecao.daB);
        expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      } else if (c.cria) {
        // Criação: a linha nasce em B, e nada de A é lido ou alterado.
        expect(res.status, texto).toBe(c.status);
        for (const deA of SO_DA_A) expect(texto).not.toContain(deA);
        const criadas = (falso.linhas.crm_tasks ?? []).filter((l) => !idsAntes.has(l.id));
        expect(criadas).toHaveLength(1);
        expect(criadas[0]?.organization_id).toBe(ORG_B);
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_B, actorApiTokenId: TOKEN_B }));
        expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }));
      } else {
        // O recurso é de A: para B ele não existe. Código que a rota devolve: 404.
        expect(res.status, texto).toBe(404);
        expect(audit).not.toHaveBeenCalled();
      }

      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
      // Nada de A mudou, nem a linha que B tentou alcançar.
      expect(daOrganizacao(falso.linhas, ORG_A, tabelas)).toEqual(daOrganizacao(c.linhas, ORG_A, tabelas));
    });

    it(`${n}: token sem o escopo é recusado`, async () => {
      const outro = c.escopo === "mcp:read" ? "mcp:write" : "mcp:read";
      const { res, texto, falso } = await comoToken(c, { escopos: [outro] });

      expect(res.status, texto).toBe(403);
      expect(falso.cadeias).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    if (c.papel === "viewer") {
      // `viewer` é o degrau mais baixo da escada: não existe papel abaixo dele,
      // então não há token "abaixo do papel" para este método.
    } else {
      it(`${n}: token abaixo do papel é recusado`, async () => {
        const { res, texto, falso } = await comoToken(c, { papel: DEGRAU_ABAIXO[c.papelDoToken ?? c.papel] });

        expect(res.status, texto).toBe(403);
        expect(falso.cadeias).toEqual([]);
        expect(falso.rpcs).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }

    it(`${n}: acima do teto do token → 429`, async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(falso.cadeias).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${c.recurso}:tok:${TOKEN_A}`);
    });

    it(`${n}: sessão continua com o mesmo portão`, async () => {
      const { res, texto, falso } = await comoSessao(c);

      expect(res.status, texto).toBe(c.status);
      // O papel da tabela, no `requireRole` de sempre.
      expect(requireRole).toHaveBeenCalledWith(c.papel, expect.objectContaining({ resource: c.recurso }));
      // Sessão não passa pelo autenticador do token nem pelo teto dele.
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, actorUserId: PESSOA_DA_SESSAO, actorApiTokenId: null }),
        );
      }
      if (c.cria) {
        // Quem assina a tarefa é a pessoa da sessão.
        const criada = (falso.linhas.crm_tasks ?? []).find((l) => l.created_by === PESSOA_DA_SESSAO);
        expect(criada?.organization_id).toBe(ORG_A);
      }
    });
  }
});

// ─── O que só o ramo do token precisa garantir ──────────────────────────────

describe("o ramo do token em tarefas, demandas e chamadas", () => {
  it("GET /api/v1/tasks?assigned_to=me: token não é pessoa → 422, sem tocar o banco", async () => {
    const c: Caso = { ...LISTA_DE_TAREFAS, caminho: "/api/v1/tasks?assigned_to=me" };
    const { res, texto, falso } = await comoToken(c);

    expect(res.status, texto).toBe(422);
    expect(falso.cadeias).toEqual([]);
  });

  it("GET /api/v1/tasks?assigned_to=me: a sessão segue resolvendo `me` pela pessoa logada", async () => {
    const c: Caso = { ...LISTA_DE_TAREFAS, caminho: "/api/v1/tasks?assigned_to=me" };
    const { res, texto, falso } = await comoSessao(c);

    expect(res.status, texto).toBe(200);
    expect(falso.cadeias[0]?.filtros).toContainEqual(["assigned_to", PESSOA_DA_SESSAO]);
  });

  it("GET /api/v1/tasks?pipeline_id=: o filtro de funil exige o embed do negócio, então o token recebe 422 sem tocar o banco", async () => {
    // O filtro `lead.pipeline_id` só funciona com `lead:crm_leads!inner(...)`, e o
    // embed é o que o ramo do token não usa (service role não passa pela RLS).
    const c: Caso = {
      ...LISTA_DE_TAREFAS,
      caminho: "/api/v1/tasks?pipeline_id=11111111-1111-4111-8111-111111111111",
    };
    const { res, texto, falso } = await comoToken(c);

    expect(res.status, texto).toBe(422);
    expect(falso.cadeias).toEqual([]);
  });

  it("GET /api/v1/tasks?pipeline_id=: a sessão segue filtrando pelo funil do negócio", async () => {
    const c: Caso = {
      ...LISTA_DE_TAREFAS,
      caminho: "/api/v1/tasks?pipeline_id=11111111-1111-4111-8111-111111111111",
    };
    const { res, texto, falso } = await comoSessao(c);

    expect(res.status, texto).toBe(200);
    expect(falso.cadeias[0]?.filtros).toContainEqual([
      "lead.pipeline_id",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("GET /api/v1/tasks?assigned_to=ninguem: o token lista as sem responsável", async () => {
    const c: Caso = { ...LISTA_DE_TAREFAS, caminho: "/api/v1/tasks?assigned_to=ninguem" };
    const { res, texto, falso } = await comoToken(c);

    expect(res.status, texto).toBe(200);
    expect(falso.cadeias[0]?.filtros).toContainEqual(["assigned_to", null]);
    expect(texto).toContain(TAREFA_A);
  });

  it("GET /api/v1/tasks: tarefa de A presa a negócio de B não entrega o negócio de B", async () => {
    // `crm_tasks.lead_id` é FK simples: a conferência do Postgres não olha a
    // organização. Com o embed e a service role, o título de B sairia daqui.
    const legada: Linha = { ...TAREFA_DA_A, id: TAREFA_LEGADA_A, lead_id: NEGOCIO_B };
    const { res, texto } = await comoToken(LISTA_DE_TAREFAS, {
      linhas: { crm_tasks: [TAREFA_DA_A, legada, TAREFA_DA_B], crm_leads: NEGOCIOS },
    });

    expect(res.status, texto).toBe(200);
    expect(texto).not.toContain("Negócio secreto da B");
    const tarefas = json<{ data: { tasks: Array<{ id: string; lead: unknown }> } }>(texto).data.tasks;
    expect(tarefas.find((t) => t.id === TAREFA_LEGADA_A)?.lead).toBeNull();
    expect(tarefas.find((t) => t.id === TAREFA_A)?.lead).toEqual({ id: NEGOCIO_A, title: "Negócio da A" });
    expect(tarefas.find((t) => t.id === TAREFA_B)).toBeUndefined();
  });

  const VINCULOS_DE_B: Array<[string, Record<string, string>]> = [
    ["lead_id", { lead_id: NEGOCIO_B }],
    ["contact_id", { contact_id: CONTATO_B }],
    ["demanda_id", { demanda_id: DEMANDA_B }],
    ["assigned_to", { assigned_to: RESPONSAVEL_B }],
  ];

  it.each(VINCULOS_DE_B)("POST /api/v1/tasks: %s de B com o token de A → 422 e nada gravado", async (_campo, extra) => {
    const c: Caso = {
      ...CRIAR_TAREFA,
      corpo: { title: "Nova tarefa", ...extra },
      linhas: LINHAS_DE_TAREFAS_COM_VINCULOS,
    };
    const { res, texto, falso } = await comoToken(c);

    expect(res.status, texto).toBe(422);
    expect(falso.linhas.crm_tasks).toHaveLength(2);
    expect(audit).not.toHaveBeenCalled();
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
  });

  it("POST /api/v1/tasks: negócio, contato, demanda e responsável da própria organização passam, e o token não assina", async () => {
    const c: Caso = {
      ...CRIAR_TAREFA,
      corpo: {
        title: "Nova tarefa",
        lead_id: NEGOCIO_A,
        contact_id: CONTATO_A,
        demanda_id: DEMANDA_A,
        assigned_to: RESPONSAVEL_A,
      },
      linhas: LINHAS_DE_TAREFAS_COM_VINCULOS,
    };
    const { res, texto, falso } = await comoToken(c);

    expect(res.status, texto).toBe(201);
    const criada = (falso.linhas.crm_tasks ?? []).find((l) => l.title === "Nova tarefa");
    expect(criada).toMatchObject({ organization_id: ORG_A, assigned_to: RESPONSAVEL_A, created_by: null });
    // O id do token não vai para coluna com FK para `auth.users`.
    expect(JSON.stringify(criada)).not.toContain(TOKEN_A);
    expect(json<{ data: { task: { lead: unknown } } }>(texto).data.task.lead).toEqual({
      id: NEGOCIO_A,
      title: "Negócio da A",
    });
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
  });

  it("PATCH /api/v1/tasks/[id]: lead_id de B com o token de A → 422 e a tarefa não muda", async () => {
    const c: Caso = { ...EDITAR_TAREFA, corpo: { lead_id: NEGOCIO_B }, linhas: LINHAS_DE_TAREFAS_COM_VINCULOS };
    const { res, texto, falso } = await comoToken(c);

    expect(res.status, texto).toBe(422);
    const tabelas = Object.keys(c.linhas);
    expect(daOrganizacao(falso.linhas, ORG_A, tabelas)).toEqual(daOrganizacao(c.linhas, ORG_A, tabelas));
    expect(audit).not.toHaveBeenCalled();
  });

  it("PATCH /api/v1/tasks/[id]: `lead_id: null` desvincula o negócio", async () => {
    const c: Caso = { ...EDITAR_TAREFA, corpo: { lead_id: null } };
    const { res, texto, falso } = await comoToken(c);

    expect(res.status, texto).toBe(200);
    expect(json<{ data: { task: { lead: unknown } } }>(texto).data.task.lead).toBeNull();
    expect((falso.linhas.crm_tasks ?? []).find((l) => l.id === TAREFA_A)?.lead_id).toBeNull();
  });

  it("PATCH /api/v1/demandas/[id] encerrar: o token passa a organização da linha dele e nenhuma pessoa", async () => {
    const { res, texto, falso } = await comoToken(ENCERRAR_DEMANDA);

    expect(res.status, texto).toBe(200);
    const chamada = falso.rpcs.find((r) => r.nome === "fn_demanda_encerrar");
    expect(chamada?.args).toMatchObject({ p_org: ORG_A, p_demanda: DEMANDA_A, p_actor: null });
  });

  it("PATCH /api/v1/demandas/[id] encerrar: a sessão segue assinando com a pessoa logada", async () => {
    const { res, texto, falso } = await comoSessao(ENCERRAR_DEMANDA);

    expect(res.status, texto).toBe(200);
    const chamada = falso.rpcs.find((r) => r.nome === "fn_demanda_encerrar");
    expect(chamada?.args).toMatchObject({ p_org: ORG_A, p_actor: PESSOA_DA_SESSAO });
  });

  it("GET /api/v1/calls: as duas consultas (chamadas e contatos pessoais) filtram a organização do token", async () => {
    const { res, texto, falso } = await comoToken(LISTA_DE_CHAMADAS);

    expect(res.status, texto).toBe(200);
    const tabelasTocadas = falso.cadeias.map((c) => c.tabela).sort();
    expect(tabelasTocadas).toEqual(["contacts", "voice_calls"]);
    for (const cadeia of falso.cadeias) {
      expect(cadeia.filtros).toContainEqual(["organization_id", ORG_A]);
    }
  });
});

// ─── O método que FICA DE FORA ──────────────────────────────────────────────

describe("o que segue só de sessão", () => {
  it("POST /api/v1/calls: fica só de sessão", async () => {
    // O caminho `/api/v1/calls` ganhou porta por causa do GET. O POST (originar
    // ligação) continua com `requireRole`, que sem cookie recusa com 401.
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    const modulo = await CARREGA.calls();
    const res = await modulo.POST(
      new NextRequest("http://localhost/api/v1/calls", {
        method: "POST",
        headers: { ...AUTORIZACAO, "content-type": "application/json" },
        body: JSON.stringify({ toNumber: "+5511999990000" }),
      }),
    );

    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "voice_calls" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

// ─── A borda que nenhum teste de handler alcança: o proxy ───────────────────

/**
 * O `proxy.ts` roda ANTES de qualquer route handler e só reconhece cookie. Sem
 * entrada em PUBLIC_PATHS o Bearer nem chega à rota. A porta precisa ser
 * ESTREITA: id em forma de UUID, âncora nos dois lados.
 *
 * Irmãos literais (`ls app/api/v1/<pasta>`): `tasks/` tem só `[id]` e
 * `route.ts`; `demandas/` tem só `[id]`; `calls/` tem só `route.ts`. Nenhum
 * irmão literal ficou sem porta, então a borda é id fora da forma de UUID,
 * sub-path e o pai sem rota.
 */
describe("PUBLIC_PATHS — as portas de tarefas, demandas e chamadas", () => {
  const UUID = "00000000-0000-4000-8000-000000000000";

  it.each([
    "/api/v1/tasks",
    `/api/v1/tasks/${UUID}`,
    `/api/v1/tasks/${UUID.toUpperCase()}`,
    `/api/v1/demandas/${UUID}`,
    "/api/v1/calls",
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    // id fora da forma de UUID
    "/api/v1/tasks/abc",
    "/api/v1/tasks/x",
    "/api/v1/demandas/abc",
    // sub-path
    `/api/v1/tasks/${UUID}/x`,
    `/api/v1/demandas/${UUID}/x`,
    "/api/v1/tasks/x/y",
    "/api/v1/calls/x",
    `/api/v1/calls/${UUID}`,
    "/api/v1/calls/abc",
    // o pai de `demandas/[id]` não é rota
    "/api/v1/demandas",
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});
