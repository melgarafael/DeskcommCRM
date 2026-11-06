// @vitest-environment node
/**
 * SEIS ROTAS QUE ACEITAM TOKEN E NÃO TINHAM TESTE DE TOKEN (Spec 33, R; varredura de 06/11/2026).
 *
 * A varredura das 264 rotas que chamam `resolveAuthDual` achou seis sem nenhum teste que passe pelo
 * ramo do token (os testes ao lado delas simulam só a sessão). Este arquivo cobre o ramo do token em
 * cada uma, com o cliente admin falso de duas organizações, no mesmo molde dos outros arquivos desta
 * pasta:
 *
 *   agenda/tipos                       GET (viewer) e DELETE (manager)
 *   ai/agents/[id]/versions            GET (manager)
 *   ai/followup-flows/from-model       POST (manager)
 *   ai/routers/[id]                    GET (agent), PATCH e DELETE (admin)
 *   ai/routers/[id]/members            PUT (admin)
 *   ai/routers/[id]/test               POST (manager): só o portão e a conferência da organização
 *
 * Fica de fora, e é dito: `POST ai/agents/[id]/versions` (corpo do schema de versão é grande) e
 * `POST/PATCH agenda/tipos`; e, em `ai/routers/[id]/test`, o resultado da classificação (o teste pára
 * em 409 `state_conflict` porque o roteador simulado não está ativo, o que prova que o token de A
 * passou pelo portão e achou o roteador de A).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
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
// Só a rota `routers/[id]/test` usa: sem roteador ativo, ela pára em 409 antes de classificar nada.
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/agent/router-config", () => ({ loadActiveRouter: vi.fn(async () => null) }));

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const USER_A = "11111111-1111-4111-8111-111111111111";

type Lado = { org: string; rotulo: string; tipo: string; agente: string; versao: string; roteador: string; membro: string };

const A: Lado = {
  org: ORG_A,
  rotulo: "A",
  tipo: "a1000000-0000-4000-8000-000000000001",
  agente: "a2000000-0000-4000-8000-000000000001",
  versao: "a3000000-0000-4000-8000-000000000001",
  roteador: "a4000000-0000-4000-8000-000000000001",
  membro: "a5000000-0000-4000-8000-000000000001",
};
const B: Lado = {
  org: ORG_B,
  rotulo: "B",
  tipo: "b1000000-0000-4000-8000-000000000001",
  agente: "b2000000-0000-4000-8000-000000000001",
  versao: "b3000000-0000-4000-8000-000000000001",
  roteador: "b4000000-0000-4000-8000-000000000001",
  membro: "b5000000-0000-4000-8000-000000000001",
};

type Linha = Record<string, unknown>;
type Linhas = Record<string, Linha[]>;
type Metodo = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Papel = "viewer" | "agent" | "manager" | "admin";
type Escopo = "mcp:read" | "mcp:write" | "config:read" | "config:write";
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
  /** papel que a SESSÃO precisa ter (o `role` da rota) */
  papel: Papel;
  /** papel mínimo do TOKEN (`tokenRole ?? role`) */
  papelDoToken: Papel;
  escopo: Escopo;
  resource: string;
  audita?: string;
  /** status do token de A; padrão: qualquer 2xx */
  statusDeA?: number;
  esperaNaResposta: string[];
  confere?: (viva: Linhas) => void;
  statusDeB: number;
  /** B recebe 200 com a lista DELE, sem nada de A */
  esperaNaRespostaDeB?: string[];
  naoEsperaNaRespostaDeB?: string[];
  /** a rota não escreve nada, mesmo no sucesso de A (portão, sem efeito) */
  semEscrita?: boolean;
};

const MOMENTO = "2026-01-01T00:00:00.000Z";

const tipoDe = (l: Lado, extra: Linha = {}): Linha => ({
  id: l.tipo,
  organization_id: l.org,
  name: `Tipo ${l.rotulo}`,
  slug: `tipo-${l.rotulo.toLowerCase()}`,
  description: null,
  category: "consulta",
  duration_minutes: 30,
  location_kind: "in_person",
  location_details: null,
  requires_confirmation: false,
  is_active: true,
  default_owner_user_id: null,
  buffer_before_minutes: 0,
  buffer_after_minutes: 0,
  minimum_notice_minutes: 0,
  booking_window_days: 30,
  reminder_enabled: false,
  reminder_minutes_before: 1440,
  reminder_extra_offsets_minutes: [],
  reminder_body: null,
  reminder_bodies: null,
  default_price_cents: null,
  service_enabled: false,
  ...extra,
});

const agenteDe = (l: Lado): Linha => ({
  id: l.agente,
  organization_id: l.org,
  name: `Agente ${l.rotulo}`,
  kind: "attendant",
  archived_at: null,
});

const versaoDe = (l: Lado): Linha => ({
  id: l.versao,
  organization_id: l.org,
  agent_id: l.agente,
  version_number: 1,
  system_prompt: `Prompt ${l.rotulo}`,
  status: "draft",
  created_at: MOMENTO,
});

const roteadorDe = (l: Lado, extra: Linha = {}): Linha => ({
  id: l.roteador,
  organization_id: l.org,
  name: `Roteador ${l.rotulo}`,
  channel_session_id: null,
  is_active: false,
  config: {},
  fallback_agent_id: null,
  ...extra,
});

const membroDe = (l: Lado): Linha => ({
  id: l.membro,
  organization_id: l.org,
  router_id: l.roteador,
  agent_id: l.agente,
  intent_name: `Intenção ${l.rotulo}`,
  intent_description: "descrição",
  examples: [],
  position: 0,
  flow_pointer_id: null,
  pipeline_id: null,
  stage_id: null,
});

const CASOS: Caso[] = [
  {
    rota: "app/api/v1/agenda/tipos/route.ts",
    carregar: () => import("@/app/api/v1/agenda/tipos/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: "/api/v1/agenda/tipos",
    linhas: { calendar_event_types: [tipoDe(A), tipoDe(B)] },
    papel: "viewer",
    papelDoToken: "viewer",
    escopo: "mcp:read",
    resource: "calendar_event_types",
    esperaNaResposta: [A.tipo],
    statusDeB: 200,
    esperaNaRespostaDeB: [B.tipo],
    naoEsperaNaRespostaDeB: [A.tipo],
  },
  {
    rota: "app/api/v1/agenda/tipos/route.ts",
    carregar: () => import("@/app/api/v1/agenda/tipos/route") as unknown as Promise<ModuloDeRota>,
    metodo: "DELETE",
    caminho: "/api/v1/agenda/tipos",
    corpo: { id: A.tipo },
    linhas: { calendar_event_types: [tipoDe(A), tipoDe(B)] },
    papel: "manager",
    papelDoToken: "manager",
    escopo: "mcp:write",
    resource: "calendar_event_types",
    audita: "agenda.tipo_desativado",
    esperaNaResposta: [A.tipo],
    confere: (viva) => {
      expect(viva.calendar_event_types?.find((l) => l.id === A.tipo)?.is_active).toBe(false);
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/agents/[id]/versions/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/agents/[id]/versions/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: `/api/v1/ai/agents/${A.agente}/versions`,
    params: { id: A.agente },
    linhas: { ai_agent_versions: [versaoDe(A), versaoDe(B)] },
    papel: "manager",
    papelDoToken: "manager",
    escopo: "mcp:read",
    resource: "ai_agents",
    esperaNaResposta: [A.versao],
    // B pergunta pelo agente de A: o filtro de organização devolve lista vazia.
    statusDeB: 200,
    naoEsperaNaRespostaDeB: [A.versao, A.agente],
  },
  {
    rota: "app/api/v1/ai/followup-flows/from-model/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followup-flows/from-model/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: "/api/v1/ai/followup-flows/from-model",
    corpo: { model_id: "clinica-consulta-retomada", name: "Fluxo instalado" },
    linhas: { followup_flow_pointers: [] },
    papel: "manager",
    papelDoToken: "manager",
    escopo: "mcp:write",
    resource: "followup_flows",
    audita: "followup_flow.created",
    esperaNaResposta: ["Fluxo instalado"],
    confere: (viva) => {
      const criado = viva.followup_flow_pointers?.find((l) => l.name === "Fluxo instalado");
      expect(criado?.organization_id).toBe(ORG_A);
    },
    // Instalar é CRIAR: o token de B instala na PRÓPRIA organização (201), nunca na de A.
    statusDeB: 201,
  },
  {
    rota: "app/api/v1/ai/routers/[id]/route.ts",
    carregar: () => import("@/app/api/v1/ai/routers/[id]/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: `/api/v1/ai/routers/${A.roteador}`,
    params: { id: A.roteador },
    linhas: { ai_routers: [roteadorDe(A), roteadorDe(B)], ai_router_members: [membroDe(A), membroDe(B)] },
    papel: "agent",
    papelDoToken: "admin",
    escopo: "config:read",
    resource: "ai_routers",
    esperaNaResposta: [A.roteador, "Intenção A"],
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/routers/[id]/route.ts",
    carregar: () => import("@/app/api/v1/ai/routers/[id]/route") as unknown as Promise<ModuloDeRota>,
    metodo: "PATCH",
    caminho: `/api/v1/ai/routers/${A.roteador}`,
    params: { id: A.roteador },
    corpo: { name: "Roteador A renomeado" },
    linhas: { ai_routers: [roteadorDe(A), roteadorDe(B)] },
    papel: "admin",
    papelDoToken: "admin",
    escopo: "config:write",
    resource: "ai_routers",
    audita: "ai.router_updated",
    esperaNaResposta: [A.roteador],
    confere: (viva) => {
      expect(viva.ai_routers?.find((l) => l.id === A.roteador)?.name).toBe("Roteador A renomeado");
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/routers/[id]/route.ts",
    carregar: () => import("@/app/api/v1/ai/routers/[id]/route") as unknown as Promise<ModuloDeRota>,
    metodo: "DELETE",
    caminho: `/api/v1/ai/routers/${A.roteador}`,
    params: { id: A.roteador },
    linhas: { ai_routers: [roteadorDe(A), roteadorDe(B)] },
    papel: "admin",
    papelDoToken: "admin",
    escopo: "config:write",
    resource: "ai_routers",
    audita: "ai.router_deleted",
    esperaNaResposta: [A.roteador],
    confere: (viva) => {
      expect(viva.ai_routers?.filter((l) => l.id === A.roteador)).toHaveLength(0);
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/routers/[id]/members/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/routers/[id]/members/route") as unknown as Promise<ModuloDeRota>,
    metodo: "PUT",
    caminho: `/api/v1/ai/routers/${A.roteador}/members`,
    params: { id: A.roteador },
    // Lista vazia: a rota substitui a lista inteira, então os membros de A somem e nada entra.
    corpo: { members: [] },
    linhas: { ai_routers: [roteadorDe(A), roteadorDe(B)], ai_router_members: [membroDe(A), membroDe(B)] },
    papel: "admin",
    papelDoToken: "admin",
    escopo: "config:write",
    resource: "ai_routers",
    audita: "ai.router_members_updated",
    esperaNaResposta: ["count"],
    confere: (viva) => {
      expect(viva.ai_router_members?.filter((l) => l.router_id === A.roteador)).toHaveLength(0);
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/routers/[id]/test/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/routers/[id]/test/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/routers/${A.roteador}/test`,
    params: { id: A.roteador },
    corpo: { message: "quero marcar uma consulta" },
    linhas: { ai_routers: [roteadorDe(A), roteadorDe(B)] },
    papel: "manager",
    papelDoToken: "admin",
    escopo: "config:write",
    resource: "ai_routers",
    // O roteador simulado não está ativo: passar pelo portão e achar o roteador de A dá 409.
    statusDeA: 409,
    esperaNaResposta: ["state_conflict"],
    statusDeB: 404,
    semEscrita: true,
  },
];

// ─── Ajudantes (mesmo molde dos outros arquivos desta pasta) ─────────────────

const SESSAO_NO_TOKEN = "cliente de sessão usado no ramo do token";
const BEARER = ["Bearer", "dsk_teste_unitario"].join(" ");
const ORDEM_DOS_PAPEIS: readonly Papel[] = ["viewer", "agent", "manager", "admin"];
const ESCOPO_OPOSTO: Record<Escopo, Escopo> = {
  "mcp:read": "mcp:write",
  "mcp:write": "mcp:read",
  "config:read": "config:write",
  "config:write": "config:read",
};

const nomeDe = (c: Caso): string => `${c.metodo} ${c.caminho}`;
const umDegrauAbaixo = (p: Papel): Papel | undefined => ORDEM_DOS_PAPEIS[ORDEM_DOS_PAPEIS.indexOf(p) - 1];
const ehSucesso = (s: number): boolean => s >= 200 && s < 300;

function tokenDe(org: string, tokenId: string, scopes: string[], role: Role): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: tokenId, role },
    apiTokenId: tokenId,
    scopes,
  } as never);
}

function falsoDe(caso: Caso, orgDona: string) {
  const falso = criarClienteAdminFalso({ orgDona, linhas: caso.linhas, tabelasSemOrganizacao: [] });
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
    Object.entries(linhas)
      .map(([tabela, lista]) => [tabela, lista.filter((l) => l.organization_id === org)] as const)
      .filter(([, lista]) => lista.length > 0),
  );
}

function idsDe(org: string, linhas: Linhas): string[] {
  const ids = [org];
  for (const lista of Object.values(linhas)) {
    for (const l of lista) if (l.organization_id === org && typeof l.id === "string") ids.push(l.id);
  }
  return ids;
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

describe("seis rotas que aceitam token e não tinham teste de token (Spec 33, R)", () => {
  for (const caso of CASOS) {
    const nome = nomeDe(caso);
    const escreve = caso.metodo !== "GET";

    it(`${nome}: token de A alcança o recurso de A`, async () => {
      const falso = falsoDe(caso, ORG_A);
      tokenDe(ORG_A, TOKEN_A, [caso.escopo], caso.papelDoToken);

      const res = await chamar(caso, true);
      const texto = await res.text();

      if (caso.statusDeA) expect(res.status, texto).toBe(caso.statusDeA);
      else expect(res.status, texto).toSatisfy(ehSucesso);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: [] })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
      expect(falso.cadeias.length + falso.rpcs.length).toBeGreaterThan(0);
      for (const pedaco of caso.esperaNaResposta) expect(texto).toContain(pedaco);
      for (const id of idsDe(ORG_B, caso.linhas)) expect(texto).not.toContain(id);
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
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: [] })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
      for (const id of idsDe(ORG_A, caso.linhas)) expect(texto).not.toContain(id);
      // Nada de A foi tocado, qualquer que seja a rota.
      expect(linhasDe(ORG_A, falso.linhas)).toEqual(linhasDe(ORG_A, caso.linhas));
      // Quem só consulta ou recusa não escreve; a rota que cria (201) escreve só em B.
      if (caso.statusDeB !== 201) expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      for (const pedaco of caso.esperaNaRespostaDeB ?? []) expect(texto).toContain(pedaco);
      for (const pedaco of caso.naoEsperaNaRespostaDeB ?? []) expect(texto).not.toContain(pedaco);
      for (const [entrada] of vi.mocked(audit).mock.calls) {
        expect(entrada).toMatchObject({ organizationId: ORG_B, actorApiTokenId: TOKEN_B });
      }
    });

    it(`${nome}: token sem o escopo é recusado`, async () => {
      const falso = falsoDe(caso, ORG_A);
      tokenDe(ORG_A, TOKEN_A, [ESCOPO_OPOSTO[caso.escopo]], caso.papelDoToken);

      const res = await chamar(caso, true);

      expect(res.status).toBe(403);
      expect(falso.cadeias).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    const abaixo = umDegrauAbaixo(caso.papelDoToken);
    if (abaixo) {
      it(`${nome}: token abaixo do papel é recusado`, async () => {
        const falso = falsoDe(caso, ORG_A);
        tokenDe(ORG_A, TOKEN_A, [caso.escopo], abaixo);

        const res = await chamar(caso, true);

        expect(res.status).toBe(403);
        expect(falso.cadeias).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }

    if (escreve) {
      it(`${nome}: acima do teto do token → 429`, async () => {
        const falso = falsoDe(caso, ORG_A);
        tokenDe(ORG_A, TOKEN_A, [caso.escopo], caso.papelDoToken);
        vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

        const res = await chamar(caso, true);

        expect(res.status).toBe(429);
        expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }

    it(`${nome}: sessão continua com o mesmo portão`, async () => {
      const sessao = criarClienteAdminFalso({ orgDona: ORG_A, linhas: caso.linhas, tabelasSemOrganizacao: [] });
      falsoDe(caso, ORG_A);
      vi.mocked(createClient).mockResolvedValue(sessao.cliente as never);
      vi.mocked(requireRole).mockResolvedValue({
        ok: true,
        user: { id: USER_A, idioma: "pt-BR" },
        org: { orgId: ORG_A, name: "Org", role: caso.papel },
      } as never);

      const res = await chamar(caso, false);
      const texto = await res.text();

      if (caso.statusDeA) expect(res.status, texto).toBe(caso.statusDeA);
      else expect(res.status, texto).toSatisfy(ehSucesso);
      expect(requireRole).toHaveBeenCalledWith(caso.papel, expect.objectContaining({ resource: caso.resource }));
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
    });
  }
});
