// @vitest-environment node
/**
 * `ai/cases`, `ai/inbox`, `ai/routing-results` ACEITAM TOKEN (Spec 33, R1, tarefa 2).
 *
 * Convertidos (3 métodos):
 *
 *   GET   ai/cases                      agent  receita A
 *   GET   ai/cases/[id]                 agent  receita A
 *   PATCH ai/routing-results/[id]       admin  receita A
 *
 * Ficam de fora (PAREI, ver o relatório da ordem): ai/cases/[id]/chat GET e
 * POST, ai/cases/[id]/close POST (consultas por `pg.Pool`, que o cliente falso
 * não enxerga, e ator humano gravado com id de sessão), ai/inbox GET, PATCH e
 * resolve-all (id da sessão como SUJEITO do filtro de aviso pessoal; o GET
 * ainda usa o papel da sessão) e ai/routing-results GET (usa `org.role`).
 *
 * ─── O que este arquivo prova ───────────────────────────────────────────────
 * No ramo do token o cliente é a service role. O filtro de organização escrito
 * à mão é a única barreira; o cliente falso por organização
 * (`tests/unit/helpers/cliente-admin-falso.ts`) faz a cadeia sem o filtro não
 * alcançar linha. Os mocks são os da receita: sessão e `loadAuthUser` lançam.
 *
 * ─── O embed ────────────────────────────────────────────────────────────────
 * A lista e o detalhe de casos liam o contato por embed PostgREST
 * (`conversations:conversation_id(contacts:contact_id(...))`). Na service role
 * o embed ignora a RLS e a FK não confere organização: um caso de A que aponta
 * para a conversa de B traria nome e telefone do contato de B. No ramo do
 * token a rota lê sem embed e junta conversa e contato em consultas próprias
 * filtradas por organização. Os testes "armadilha" provam isso.
 *
 * ─── O que NÃO prova ────────────────────────────────────────────────────────
 * O falso só aplica `eq`/`in`/`is`/`neq`; `order`, `or` e embed são ignorados
 * ou só registrados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import type { Role } from "@/lib/auth/types";
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
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const USER_A = "11111111-1111-4111-8111-111111111111";

type Lado = {
  org: string;
  rotulo: string;
  caso: string;
  conversa: string;
  contato: string;
  evento: string;
  decisao: string;
  roteador: string;
  agente: string;
};

const A: Lado = {
  org: ORG_A,
  rotulo: "A",
  caso: "a1000000-0000-4000-8000-000000000001",
  conversa: "a2000000-0000-4000-8000-000000000001",
  contato: "a3000000-0000-4000-8000-000000000001",
  evento: "a4000000-0000-4000-8000-000000000001",
  decisao: "a5000000-0000-4000-8000-000000000001",
  roteador: "a6000000-0000-4000-8000-000000000001",
  agente: "a7000000-0000-4000-8000-000000000001",
};
const B: Lado = {
  org: ORG_B,
  rotulo: "B",
  caso: "b1000000-0000-4000-8000-000000000001",
  conversa: "b2000000-0000-4000-8000-000000000001",
  contato: "b3000000-0000-4000-8000-000000000001",
  evento: "b4000000-0000-4000-8000-000000000001",
  decisao: "b5000000-0000-4000-8000-000000000001",
  roteador: "b6000000-0000-4000-8000-000000000001",
  agente: "b7000000-0000-4000-8000-000000000001",
};

/** Nenhuma tabela tocada por estas rotas deixa de ter `organization_id`. */
const SEM_ORGANIZACAO = [] as const;

type Linha = Record<string, unknown>;
type Linhas = Record<string, Linha[]>;
type Metodo = "GET" | "PATCH";
type Papel = "viewer" | "agent" | "manager" | "admin";
type Escopo = "config:read" | "config:write";
type Manipulador = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;
type ModuloDeRota = Partial<Record<Metodo, Manipulador>>;

type Caso = {
  rota: string;
  carregar: () => Promise<ModuloDeRota>;
  metodo: Metodo;
  caminho: string;
  params?: Record<string, string>;
  corpo?: unknown;
  linhas: Linhas;
  papel: Papel;
  escopo: Escopo;
  papelDoToken: "admin";
  resource: string;
  audita?: string;
  esperaNaResposta: string[];
  confere?: (viva: Linhas) => void;
  /** O que a rota devolve ao token de B diante do recurso de A. */
  statusDeB: 404 | 200;
  esperaNaRespostaDeB?: string[];
};

const MOMENTO = "2026-01-01T00:00:00.000Z";

function casoDe(l: Lado, extra: Linha = {}): Linha {
  return {
    id: l.caso,
    organization_id: l.org,
    title: `Caso ${l.rotulo}`,
    summary: "resumo",
    blocker: "bloqueio",
    status: "awaiting_human",
    kind: "outro",
    source: "agent",
    opened_at: MOMENTO,
    closed_at: null,
    conversation_id: l.conversa,
    ...extra,
  };
}
function conversaDe(l: Lado): Linha {
  return { id: l.conversa, organization_id: l.org, contact_id: l.contato };
}
function contatoDe(l: Lado): Linha {
  return {
    id: l.contato,
    organization_id: l.org,
    name: `Contato ${l.rotulo}`,
    phone_number: l.rotulo === "A" ? "5511900000001" : "5521900000002",
  };
}
function eventoDe(l: Lado): Linha {
  return {
    id: l.evento,
    organization_id: l.org,
    case_id: l.caso,
    kind: "opened",
    actor_kind: "agent",
    actor_user_id: null,
    human_action: null,
    body: `Evento ${l.rotulo}`,
    created_at: MOMENTO,
  };
}
function decisaoDe(l: Lado): Linha {
  return {
    id: l.decisao,
    organization_id: l.org,
    router_id: l.roteador,
    revisao: null,
    agent_id_esperado: null,
    revisado_por: null,
    revisado_em: null,
  };
}

const LINHAS_DE_CASOS: Linhas = {
  agent_cases: [casoDe(A), casoDe(B)],
  conversations: [conversaDe(A), conversaDe(B)],
  contacts: [contatoDe(A), contatoDe(B)],
  agent_case_events: [eventoDe(A), eventoDe(B)],
};

const CASOS: Caso[] = [
  {
    rota: "app/api/v1/ai/cases/route.ts",
    carregar: () => import("@/app/api/v1/ai/cases/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: "/api/v1/ai/cases",
    linhas: LINHAS_DE_CASOS,
    papel: "agent",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "agent_cases",
    esperaNaResposta: [A.caso, "Contato A"],
    // Coleção sem id: B recebe 200 com a lista DELE.
    statusDeB: 200,
    esperaNaRespostaDeB: [B.caso, "Contato B"],
  },
  {
    rota: "app/api/v1/ai/cases/[id]/route.ts",
    carregar: () => import("@/app/api/v1/ai/cases/[id]/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: `/api/v1/ai/cases/${A.caso}`,
    params: { id: A.caso },
    linhas: LINHAS_DE_CASOS,
    papel: "agent",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "agent_cases",
    esperaNaResposta: [A.caso, "Contato A", "Evento A"],
    // `lerChamado` não acha o caso de A na organização de B: 404 "Caso não encontrado".
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/routing-results/[id]/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/routing-results/[id]/route") as unknown as Promise<ModuloDeRota>,
    metodo: "PATCH",
    caminho: `/api/v1/ai/routing-results/${A.decisao}`,
    params: { id: A.decisao },
    corpo: { revisao: "incorreto", agent_id_esperado: A.agente },
    linhas: {
      jev_router_decisions: [decisaoDe(A), decisaoDe(B)],
      ai_router_members: [
        { organization_id: ORG_A, router_id: A.roteador, agent_id: A.agente, intent_name: "venda" },
        { organization_id: ORG_B, router_id: B.roteador, agent_id: B.agente, intent_name: "venda" },
      ],
    },
    papel: "admin",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "jev_router_decisions",
    audita: "ai.router_decision_reviewed",
    esperaNaResposta: ['"alterado":true'],
    confere: (viva) => {
      // Autoria nula: id de token nunca vai para `revisado_por`.
      const alvo = viva.jev_router_decisions?.find((l) => l.id === A.decisao);
      expect(alvo?.revisao).toBe("incorreto");
      expect(alvo?.agent_id_esperado).toBe(A.agente);
      expect(alvo?.revisado_por).toBeNull();
    },
    // "Decisão não encontrada" (404): a decisão de A não existe na organização de B.
    statusDeB: 404,
  },
];

const SESSAO_NO_TOKEN = "cliente de sessão usado no ramo do token";
const BEARER = ["Bearer", "dsk_teste_unitario"].join(" ");
const ORDEM_DOS_PAPEIS: readonly Papel[] = ["viewer", "agent", "manager", "admin"];
const ESCOPO_OPOSTO: Record<Escopo, Escopo> = {
  "config:read": "config:write",
  "config:write": "config:read",
};

function nomeDe(caso: Caso): string {
  return `${caso.metodo} ${caso.caminho}`;
}
function umDegrauAbaixo(papel: Papel): Papel | undefined {
  return ORDEM_DOS_PAPEIS[ORDEM_DOS_PAPEIS.indexOf(papel) - 1];
}
function tokenDe(org: string, tokenId: string, scopes: string[], role: Role): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: tokenId, role },
    apiTokenId: tokenId,
    scopes,
  } as never);
}
function falsoDe(caso: Caso, orgDona: string, linhas: Linhas = caso.linhas) {
  const falso = criarClienteAdminFalso({ orgDona, linhas, tabelasSemOrganizacao: SEM_ORGANIZACAO });
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  return falso;
}
function requisicao(caso: Caso, comToken: boolean): NextRequest {
  const headers = new Headers();
  if (comToken) headers.set("authorization", BEARER);
  const temCorpo = caso.corpo !== undefined;
  if (temCorpo) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${caso.caminho}`, {
    method: caso.metodo,
    headers,
    ...(temCorpo ? { body: JSON.stringify(caso.corpo) } : {}),
  });
}
async function chamar(caso: Caso, comToken: boolean): Promise<Response> {
  const modulo = await caso.carregar();
  const manipulador = modulo[caso.metodo];
  if (!manipulador) throw new Error(`${caso.rota} não exporta ${caso.metodo}`);
  return manipulador(requisicao(caso, comToken), { params: Promise.resolve(caso.params ?? {}) });
}
function linhasDe(org: string, linhas: Linhas): Linhas {
  return Object.fromEntries(
    Object.entries(linhas).map(([t, lista]) => [t, lista.filter((l) => l.organization_id === org)]),
  );
}
function idsDe(org: string, linhas: Linhas): string[] {
  const ids = [org];
  for (const lista of Object.values(linhas)) {
    for (const l of lista) if (l.organization_id === org && typeof l.id === "string") ids.push(l.id);
  }
  return ids;
}
function ehSucesso(status: number): boolean {
  return status >= 200 && status < 300;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(SESSAO_NO_TOKEN);
  });
  vi.mocked(loadAuthUser).mockImplementation(async () => {
    throw new Error(SESSAO_NO_TOKEN);
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole usado no ramo do token");
  });
  vi.mocked(validateBearerToken).mockImplementation(async () => {
    throw new Error("este caso não configurou o token");
  });
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("ai/cases e ai/routing-results aceitam token de integração (Spec 33, R1)", () => {
  for (const caso of CASOS) {
    const nome = nomeDe(caso);

    it(`${nome}: token de A alcança o recurso de A`, async () => {
      const falso = falsoDe(caso, ORG_A);
      tokenDe(ORG_A, TOKEN_A, [caso.escopo], caso.papelDoToken);

      const res = await chamar(caso, true);
      const texto = await res.text();

      expect(res.status, texto).toSatisfy(ehSucesso);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
      expect(falso.cadeias.length + falso.rpcs.length).toBeGreaterThan(0);
      for (const pedaco of caso.esperaNaResposta) expect(texto).toContain(pedaco);
      for (const id of idsDe(ORG_B, caso.linhas)) expect(texto).not.toContain(id);
      expect(texto).not.toContain("Contato B");
      expect(linhasDe(ORG_B, falso.linhas)).toEqual(linhasDe(ORG_B, caso.linhas));
      caso.confere?.(falso.linhas);
      if (caso.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: caso.audita,
            actorUserId: null,
            actorApiTokenId: TOKEN_A,
            organizationId: ORG_A,
          }),
        );
      } else {
        expect(audit).not.toHaveBeenCalled();
      }
      expect(requireRole).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      expect(loadAuthUser).not.toHaveBeenCalled();
    });

    it(`${nome}: token de B não alcança o recurso de A`, async () => {
      const falso = falsoDe(caso, ORG_B);
      tokenDe(ORG_B, TOKEN_B, [caso.escopo], caso.papelDoToken);

      const res = await chamar(caso, true);
      const texto = await res.text();

      expect(res.status, texto).toBe(caso.statusDeB);
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
      for (const id of idsDe(ORG_A, caso.linhas)) expect(texto).not.toContain(id);
      expect(texto).not.toContain("Contato A");
      expect(linhasDe(ORG_A, falso.linhas)).toEqual(linhasDe(ORG_A, caso.linhas));
      for (const pedaco of caso.esperaNaRespostaDeB ?? []) expect(texto).toContain(pedaco);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${nome}: token sem o escopo é recusado`, async () => {
      const falso = falsoDe(caso, ORG_A);
      tokenDe(ORG_A, TOKEN_A, [ESCOPO_OPOSTO[caso.escopo]], caso.papelDoToken);

      const res = await chamar(caso, true);

      expect(res.status).toBe(403);
      expect(falso.cadeias).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    // Todos os métodos têm `tokenRole` admin, então o degrau abaixo é `manager`.
    const abaixo = umDegrauAbaixo(caso.papelDoToken);
    if (abaixo) {
      it(`${nome}: token abaixo do papel é recusado`, async () => {
        const falso = falsoDe(caso, ORG_A);
        tokenDe(ORG_A, TOKEN_A, [caso.escopo], abaixo);

        const res = await chamar(caso, true);

        expect(res.status).toBe(403);
        expect(falso.cadeias).toEqual([]);
        expect(falso.rpcs).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }

    it(`${nome}: acima do teto do token → 429`, async () => {
      const falso = falsoDe(caso, ORG_A);
      tokenDe(ORG_A, TOKEN_A, [caso.escopo], caso.papelDoToken);
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

      const res = await chamar(caso, true);

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(falso.cadeias).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${nome}: sessão continua com o mesmo portão`, async () => {
      const sessao = criarClienteAdminFalso({
        orgDona: ORG_A,
        linhas: caso.linhas,
        tabelasSemOrganizacao: SEM_ORGANIZACAO,
      });
      falsoDe(caso, ORG_A);
      vi.mocked(createClient).mockResolvedValue(sessao.cliente as never);
      vi.mocked(requireRole).mockResolvedValue({
        ok: true,
        user: { id: USER_A, idioma: "pt-BR" },
        org: { orgId: ORG_A, name: "Org", role: caso.papel },
      } as never);

      const res = await chamar(caso, false);
      const texto = await res.text();

      expect(res.status, texto).toSatisfy(ehSucesso);
      expect(requireRole).toHaveBeenCalledWith(
        caso.papel,
        expect.objectContaining({ resource: caso.resource }),
      );
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
      if (caso.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: caso.audita,
            actorUserId: USER_A,
            actorApiTokenId: null,
            organizationId: ORG_A,
          }),
        );
      }
      // Na sessão o recorte de visibilidade dos casos sai do cliente de SESSÃO (RLS).
      if (caso.rota.includes("/ai/cases")) {
        expect(sessao.cadeias.map((c) => c.tabela)).toContain("agent_cases");
      }
    });
  }
});

/**
 * O embed: um caso de A cuja conversa é de B. Na service role o embed
 * `conversations(contacts(...))` devolveria nome e telefone do contato de B.
 */
describe("ai/cases — o contato de outra organização não vaza pelo embed", () => {
  const ARMADILHA: Linhas = {
    ...LINHAS_DE_CASOS,
    agent_cases: [casoDe(A, { conversation_id: B.conversa }), casoDe(B)],
  };

  for (const base of CASOS.slice(0, 2)) {
    it(`${nomeDe(base)}: caso de A apontando para a conversa de B volta sem o contato de B`, async () => {
      const caso: Caso = { ...base, linhas: ARMADILHA };
      const falso = falsoDe(caso, ORG_A, ARMADILHA);
      tokenDe(ORG_A, TOKEN_A, [caso.escopo], caso.papelDoToken);

      const res = await chamar(caso, true);
      const texto = await res.text();

      expect(res.status, texto).toSatisfy(ehSucesso);
      expect(texto).not.toContain("Contato B");
      expect(texto).not.toContain("5521900000002");
      expect(texto).toContain('"contact_name":null');
      // Nenhuma leitura de conversa ou contato sem a organização do token.
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
      // O contato foi buscado por consulta própria (conversa da organização A), sem embed.
      expect(falso.cadeias.map((c) => c.tabela)).toContain("conversations");
    });
  }
});

/**
 * Método que FICA DE FORA numa rota que ganha porta: `ai/cases/[id]` tem `chat`,
 * `close` e `reply` como irmãos que não ganharam porta; o proxy recusa o Bearer
 * neles (borda abaixo). As rotas de `ai/cases` e `ai/routing-results` têm um
 * único método cada, então não há caso "<método> <caminho>: fica só de sessão".
 */

/**
 * A borda que nenhum teste de handler alcança: o `proxy.ts` roda ANTES de
 * qualquer handler e só reconhece cookie.
 *
 * `ls`: `app/api/v1/ai/cases/` → `[id]`, `alerta`, `route.ts`; `[id]/` → `chat`,
 * `close`, `reply`; `app/api/v1/ai/routing-results/` → `[id]`, `route.ts`;
 * `app/api/v1/ai/inbox/` → `[id]`, `resolve-all`, `route.ts`.
 */
describe("ai/cases e ai/routing-results — PUBLIC_PATHS (borda do proxy)", () => {
  const PORTAS = CASOS.map((c) => c.caminho);
  const COM_ID = CASOS.filter((c) => c.params);

  function comAbc(caso: Caso): string {
    return Object.values(caso.params ?? {}).reduce((c, v) => c.replaceAll(v, "abc"), caso.caminho);
  }

  it.each(PORTAS)("libera %s para Bearer, com o id em forma de UUID", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each(PORTAS)("não libera %s com /x no fim", (caminho) => {
    expect(isPublicPath(`${caminho}/x`)).toBe(false);
  });

  it.each(COM_ID.map((c) => [nomeDe(c), comAbc(c)] as const))(
    "não libera %s com abc no lugar do UUID",
    (_nome, caminho) => {
      expect(isPublicPath(caminho)).toBe(false);
    },
  );

  it.each([
    "/api/v1/ai/cases/alerta",
    "/api/v1/ai/cases/alerta/teste",
    `/api/v1/ai/cases/${A.caso}/chat`,
    `/api/v1/ai/cases/${A.caso}/close`,
    `/api/v1/ai/cases/${A.caso}/reply`,
    "/api/v1/ai/inbox",
    `/api/v1/ai/inbox/${A.caso}`,
    "/api/v1/ai/inbox/resolve-all",
  ])("não dá carona ao vizinho %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});
