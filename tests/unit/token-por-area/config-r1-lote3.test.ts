// @vitest-environment node
/**
 * Token de integração nas rotas do lote 3 da fatia R1 (Spec 33): funis e roteamento.
 *
 *   GET    pipelines/[id]/forecast               config:read   agent (sessão)    admin (token)
 *   POST   pipelines/[id]/stages                 config:write  manager           admin
 *   PATCH  pipelines/[id]/stages/[stageId]       config:write  manager           admin
 *   DELETE pipelines/[id]/stages/[stageId]       config:write  manager           admin
 *   GET    settings/routing/channels             config:read   manager           admin   (receita B)
 *
 * Fica de FORA: o PATCH de `settings/routing/channels` (`fn_set_channel_routing` exige
 * `auth.uid()`), que segue só de sessão e recusa o token com 401 no `requireRole`.
 *
 * Cada método tem a bateria da receita R:
 *  - token de A alcança o recurso de A (2xx), sem consulta fora de A, e a escrita sai
 *    com ator de token (`actorUserId` nulo, `actorApiTokenId` preenchido);
 *  - token de B não alcança o recurso de A (404 ou a lista da própria B);
 *  - token sem o escopo é recusado (403);
 *  - token abaixo do papel (manager < admin do `tokenRole`) é recusado (403);
 *  - acima do teto do token → 429 com Retry-After, sem tocar no banco;
 *  - sessão (sem Authorization) continua pelo `requireRole` com o papel da tabela.
 *
 * Mais: etapa de A com o funil de B (e destino de A no arquivamento de B) não é
 * alcançada; a organização nunca vem do corpo; a previsão do token é da organização
 * inteira; a sessão de `routing/channels` segue barrada com MFA em dívida.
 *
 * O banco do ramo do token é `criarClienteAdminFalso`, que guarda as linhas das duas
 * organizações e ACUSA consulta sem `organization_id`. O cliente de sessão e o
 * `requireRole` lançam se o ramo do token os tocar.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, mfaEmDivida } from "@/lib/auth/server";
import type { Role } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import {
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

import * as rotaPrevisao from "@/app/api/v1/pipelines/[id]/forecast/route";
import * as rotaEtapas from "@/app/api/v1/pipelines/[id]/stages/route";
import * as rotaEtapa from "@/app/api/v1/pipelines/[id]/stages/[stageId]/route";
import * as rotaCanais from "@/app/api/v1/settings/routing/channels/route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), mfaEmDivida: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
// O nome do membro vem do GoTrue (service role): fora do que o teste mede.
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: vi.fn() }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const TODOS_OS_ESCOPOS = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";
const PESSOA_DA_SESSAO = "c0000000-0000-4000-8000-000000000001";

const PIPE_A = "11111111-1111-4111-8111-111111111111";
const PIPE_B = "22222222-2222-4222-8222-222222222222";
const E_NOVO_A = "31313131-3131-4313-8313-313131313131";
const E_PROPOSTA_A = "32323232-3232-4323-8323-323232323232";
const E_GANHO_A = "33333333-3333-4333-8333-333333333333";
const E_PERDA_A = "34343434-3434-4343-8343-343434343434";
const E_NOVO_B = "41414141-4141-4414-8414-414141414141";
const E_PROPOSTA_B = "42424242-4242-4424-8424-424242424242";
const LEAD_A1 = "51515151-5151-4515-8515-515151515151";
const LEAD_A2 = "52525252-5252-4525-8525-525252525252";
const LEAD_B1 = "61616161-6161-4616-8616-616161616161";
const CONTATO_A = "81818181-8181-4818-8818-818181818181";
const CONTATO_B = "82828282-8282-4828-8828-828282828282";
const DONO_1 = "d0000000-0000-4000-8000-000000000001";
const DONO_2 = "d0000000-0000-4000-8000-000000000002";

const CANAL_A = "e1000000-0000-4000-8000-00000000000a";
const CANAL_B = "e1000000-0000-4000-8000-00000000000b";
const ANA_A = "f0000000-0000-4000-8000-00000000000a";
const ANA_B = "f0000000-0000-4000-8000-00000000000b";
const POLITICA_A = "e2000000-0000-4000-8000-00000000000a";
const POLITICA_B = "e2000000-0000-4000-8000-00000000000b";

const MARCA_A = "MARCA-DA-ORG-A-3f1c";
const MARCA_B = "MARCA-DA-ORG-B-9d2e";
const MOMENTO = "2026-08-01T10:00:00Z";

type Linha = Record<string, unknown>;

function funil(id: string, org: string, nome: string): Linha {
  return {
    id,
    organization_id: org,
    name: nome,
    slug: nome.toLowerCase(),
    is_default: true,
    is_archived: false,
    position: 1000,
    settings: {},
    created_at: MOMENTO,
    updated_at: MOMENTO,
  };
}

function etapa(id: string, org: string, pipeline: string, nome: string, extra: Linha): Linha {
  return {
    id,
    organization_id: org,
    pipeline_id: pipeline,
    name: nome,
    slug: nome.toLowerCase(),
    is_won: false,
    is_lost: false,
    is_archived: false,
    win_probability: null,
    avisar_na_central: false,
    expected_duration_hours: null,
    agent_stage_hint: null,
    last_change_actor_kind: null,
    last_change_at: null,
    ...extra,
  };
}

function negocio(id: string, org: string, pipeline: string, stage: string, contato: string, extra: Linha): Linha {
  return {
    id,
    organization_id: org,
    pipeline_id: pipeline,
    stage_id: stage,
    contact_id: contato,
    status: "open",
    currency: "BRL",
    expected_close_date: "2026-10-10",
    ...extra,
  };
}

function linhasDoBanco(): Record<string, Linha[]> {
  return {
    crm_pipelines: [funil(PIPE_A, ORG_A, `Vendas ${MARCA_A}`), funil(PIPE_B, ORG_B, `Vendas ${MARCA_B}`)],
    crm_stages: [
      etapa(E_NOVO_A, ORG_A, PIPE_A, "Novo", { position: 1000 }),
      etapa(E_PROPOSTA_A, ORG_A, PIPE_A, "Proposta", { position: 2000, win_probability: 50 }),
      etapa(E_GANHO_A, ORG_A, PIPE_A, "Ganho", { position: 3000, is_won: true }),
      etapa(E_PERDA_A, ORG_A, PIPE_A, "Perdido", { position: 4000, is_lost: true }),
      etapa(E_NOVO_B, ORG_B, PIPE_B, "Novo", { position: 1000 }),
      etapa(E_PROPOSTA_B, ORG_B, PIPE_B, "Proposta", { position: 2000, win_probability: 100 }),
    ],
    // Dois negócios de A com DONOS diferentes: a previsão do token é da organização
    // inteira, não do recorte de uma pessoa.
    crm_leads: [
      negocio(LEAD_A1, ORG_A, PIPE_A, E_PROPOSTA_A, CONTATO_A, { value_cents: 100_000, owner_user_id: DONO_1 }),
      negocio(LEAD_A2, ORG_A, PIPE_A, E_PROPOSTA_A, CONTATO_A, { value_cents: 200_000, owner_user_id: DONO_2 }),
      negocio(LEAD_B1, ORG_B, PIPE_B, E_PROPOSTA_B, CONTATO_B, { value_cents: 777_000, owner_user_id: DONO_1 }),
    ],
    crm_lead_activities: [],
    channel_sessions: [
      {
        id: CANAL_A,
        organization_id: ORG_A,
        display_name: `Canal ${MARCA_A}`,
        phone_number: "+5511900000001",
        provider: "waha",
        archived_at: null,
        created_at: MOMENTO,
      },
      {
        id: CANAL_B,
        organization_id: ORG_B,
        display_name: `Canal ${MARCA_B}`,
        phone_number: "+5511900000002",
        provider: "waha",
        archived_at: null,
        created_at: MOMENTO,
      },
    ],
    user_organizations: [
      { organization_id: ORG_A, user_id: ANA_A, role: "agent", revoked_at: null },
      { organization_id: ORG_B, user_id: ANA_B, role: "agent", revoked_at: null },
    ],
    channel_routing_policies: [
      {
        id: POLITICA_A,
        organization_id: ORG_A,
        channel_session_id: CANAL_A,
        distribution_mode: null,
        default_assignee_user_id: null,
      },
      {
        id: POLITICA_B,
        organization_id: ORG_B,
        channel_session_id: CANAL_B,
        distribution_mode: null,
        default_assignee_user_id: null,
      },
    ],
    channel_routing_responsibles: [
      { organization_id: ORG_A, policy_id: POLITICA_A, user_id: ANA_A },
      { organization_id: ORG_B, policy_id: POLITICA_B, user_id: ANA_B },
    ],
  };
}

type Falso = ReturnType<typeof criarClienteAdminFalso>;
let falso: Falso;

function novoFalso(linhas: Record<string, Linha[]> = linhasDoBanco()): Falso {
  return criarClienteAdminFalso({ orgDona: ORG_A, linhas });
}

function linhaDe(f: Falso, tabela: string, id: string): Linha | undefined {
  return f.linhas[tabela]?.find((l) => l.id === id);
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

function reqDe(metodo: string, caminho: string, token?: string, corpo?: unknown): NextRequest {
  return new NextRequest(`http://localhost${caminho}`, {
    method: metodo,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(corpo !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
}

const comId = (id: string) => ({ params: Promise.resolve({ id }) });
const comEtapa = (id: string, stageId: string) => ({ params: Promise.resolve({ id, stageId }) });

async function corpoDe(res: Response): Promise<{ data: Linha }> {
  return (await res.clone().json()) as { data: Linha };
}

function nomesDasEtapas(corpo: Linha): string[] {
  return (corpo.etapas as Array<{ name: string }>).map((e) => e.name);
}

/** Sessão de A: `requireRole` resolvido; o cliente de sessão é o dublê de A (a RLS não é modelada). */
function sessaoDeA(papel: Role): void {
  vi.mocked(createClient).mockResolvedValue(falso.cliente as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org A", role: papel },
  } as never);
}

// ---------------------------------------------------------------------------
// A matriz: um caso por método
// ---------------------------------------------------------------------------

type Caso = {
  nome: string;
  /** Papel que a SESSÃO exige hoje (e que o ramo de sessão continua chamando). */
  papel: Role;
  /** `resource` que `requireRole` recebe na sessão. */
  resource: string;
  escopo: "config:read" | "config:write";
  escreve: boolean;
  statusDeSucesso: number;
  acao?: string;
  /** `token` indefinido = sessão. O token de B pede o MESMO caminho de A: o recurso é de A. */
  chamar: (token?: string) => Promise<Response>;
  verificaA: (res: Response, f: Falso) => Promise<void>;
  verificaB: (res: Response, f: Falso) => Promise<void>;
};

const CASOS: Caso[] = [
  {
    nome: "GET /pipelines/[id]/forecast",
    papel: "agent",
    resource: "pipeline_forecast",
    escopo: "config:read",
    escreve: false,
    statusDeSucesso: 200,
    chamar: (token) =>
      rotaPrevisao.GET(reqDe("GET", `/api/v1/pipelines/${PIPE_A}/forecast`, token), comId(PIPE_A)),
    // Organização inteira: os dois negócios de A (donos diferentes) entram, o de B não.
    verificaA: async (res) => {
      const d = (await corpoDe(res)).data;
      expect(d.pipeline_id).toBe(PIPE_A);
      expect(d.totais).toEqual([
        {
          moeda: "BRL",
          bruto_cents: 300_000,
          ponderado_cents: 150_000,
          n: 2,
          unico: { bruto_cents: 300_000, ponderado_cents: 150_000 },
          recorrente_mensal: { bruto_cents: 0, ponderado_cents: 0 },
        },
      ]);
    },
    verificaB: async (res, f) => {
      expect(res.status).toBe(404);
      expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
    },
  },
  {
    nome: "POST /pipelines/[id]/stages",
    papel: "manager",
    resource: "crm_stages",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 201,
    acao: "pipeline.stage_created",
    chamar: (token) =>
      rotaEtapas.POST(reqDe("POST", `/api/v1/pipelines/${PIPE_A}/stages`, token, { name: "Retorno" }), comId(PIPE_A)),
    verificaA: async (res, f) => {
      expect(nomesDasEtapas((await corpoDe(res)).data)).toContain("Retorno");
      const criada = f.linhas.crm_stages?.find((l) => l.name === "Retorno");
      expect(criada).toMatchObject({
        organization_id: ORG_A,
        pipeline_id: PIPE_A,
        // O ator é uma integração, não uma pessoa: a autoria da mudança é "system".
        last_change_actor_kind: "system",
      });
    },
    verificaB: async (res, f) => {
      expect(res.status).toBe(404);
      expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
      expect(f.linhas.crm_stages?.some((l) => l.name === "Retorno")).toBe(false);
    },
  },
  {
    nome: "PATCH /pipelines/[id]/stages/[stageId]",
    papel: "manager",
    resource: "crm_stages",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 200,
    acao: "pipeline.stage_updated",
    chamar: (token) =>
      rotaEtapa.PATCH(
        reqDe("PATCH", `/api/v1/pipelines/${PIPE_A}/stages/${E_NOVO_A}`, token, { name: "Primeiro contato" }),
        comEtapa(PIPE_A, E_NOVO_A),
      ),
    verificaA: async (res, f) => {
      expect(nomesDasEtapas((await corpoDe(res)).data)).toContain("Primeiro contato");
      expect(linhaDe(f, "crm_stages", E_NOVO_A)).toMatchObject({
        name: "Primeiro contato",
        last_change_actor_kind: "system",
      });
    },
    verificaB: async (res, f) => {
      expect(res.status).toBe(404);
      expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
      expect(linhaDe(f, "crm_stages", E_NOVO_A)?.name).toBe("Novo");
    },
  },
  {
    nome: "DELETE /pipelines/[id]/stages/[stageId]",
    papel: "manager",
    resource: "crm_stages",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 200,
    acao: "pipeline.stage_archived",
    // Arquiva a etapa com os dois negócios e manda-os para "Novo".
    chamar: (token) =>
      rotaEtapa.DELETE(
        reqDe("DELETE", `/api/v1/pipelines/${PIPE_A}/stages/${E_PROPOSTA_A}?destino=${E_NOVO_A}`, token),
        comEtapa(PIPE_A, E_PROPOSTA_A),
      ),
    verificaA: async (res, f) => {
      expect(nomesDasEtapas((await corpoDe(res)).data)).not.toContain("Proposta");
      expect(linhaDe(f, "crm_stages", E_PROPOSTA_A)?.is_archived).toBe(true);
      expect(linhaDe(f, "crm_leads", LEAD_A1)?.stage_id).toBe(E_NOVO_A);
      expect(linhaDe(f, "crm_leads", LEAD_A2)?.stage_id).toBe(E_NOVO_A);
      // O negócio de B nem foi cogitado.
      expect(linhaDe(f, "crm_leads", LEAD_B1)?.stage_id).toBe(E_PROPOSTA_B);
      // A linha do tempo de cada card diz quem moveu: uma integração (sistema), nunca uma pessoa.
      const atividades = f.linhas.crm_lead_activities ?? [];
      expect(atividades).toHaveLength(2);
      for (const a of atividades) {
        expect(a).toMatchObject({
          organization_id: ORG_A,
          type: "stage_changed",
          actor_kind: "system",
          performed_by_user_id: null,
          actor_agent_id: null,
        });
      }
    },
    verificaB: async (res, f) => {
      expect(res.status).toBe(404);
      expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
      expect(linhaDe(f, "crm_stages", E_PROPOSTA_A)?.is_archived).toBe(false);
      expect(linhaDe(f, "crm_leads", LEAD_A1)?.stage_id).toBe(E_PROPOSTA_A);
    },
  },
  {
    nome: "GET /settings/routing/channels",
    papel: "manager",
    resource: "settings_routing",
    escopo: "config:read",
    escreve: false,
    statusDeSucesso: 200,
    chamar: (token) => rotaCanais.GET(reqDe("GET", "/api/v1/settings/routing/channels", token)),
    verificaA: async (res) => {
      const d = (await corpoDe(res)).data as unknown as {
        channels: Array<{ id: string; display_name: string; user_ids: string[] }>;
        members: Array<{ id: string }>;
      };
      expect(d.channels.map((c) => c.id)).toEqual([CANAL_A]);
      expect(d.channels[0]?.user_ids).toEqual([ANA_A]);
      expect(d.members.map((m) => m.id)).toEqual([ANA_A]);
      expect(JSON.stringify(d)).not.toContain(MARCA_B);
    },
    // A rota não tem id: o token de B lê a configuração da PRÓPRIA B e nada de A.
    verificaB: async (res) => {
      expect(res.status).toBe(200);
      const d = (await corpoDe(res)).data as unknown as {
        channels: Array<{ id: string }>;
        members: Array<{ id: string }>;
      };
      expect(d.channels.map((c) => c.id)).toEqual([CANAL_B]);
      expect(d.members.map((m) => m.id)).toEqual([ANA_B]);
      expect(JSON.stringify(d)).not.toContain(MARCA_A);
    },
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  falso = novoFalso();
  vi.mocked(createAdminClient).mockImplementation(() => falso.cliente as never);
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(loadAuthUser).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole chamado no ramo do token");
  });
  vi.mocked(mfaEmDivida).mockImplementation(async () => {
    throw new Error("mfaEmDivida chamado no ramo do token");
  });
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 30 } as never);
  vi.mocked(nomesDosAtendentes).mockImplementation(
    async (_orgId, ids) => new Map((ids as string[]).map((id) => [id, `Nome ${id.slice(-1)}`])),
  );
});

// ---------------------------------------------------------------------------
// A bateria de 6 testes, por método
// ---------------------------------------------------------------------------

describe.each(CASOS)("$nome", (caso) => {
  it("token de A alcança o recurso de A, sem consulta fora de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(caso.statusDeSucesso);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(mfaEmDivida).not.toHaveBeenCalled();
    await caso.verificaA(res, falso);
    if (caso.escreve) {
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: caso.acao,
          organizationId: ORG_A,
          actorUserId: null,
          actorApiTokenId: TOKEN_A,
        }),
      );
    } else {
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    }
  });

  it("token de B não alcança o recurso de A", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await caso.chamar(TOKEN_B);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
    await caso.verificaB(res, falso);
    if (caso.escreve && res.status >= 400) expect(audit).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }));
  });

  it("token sem o escopo exigido é recusado (403), sem consulta", async () => {
    tokenDe(
      ORG_A,
      TOKEN_A,
      "admin",
      TODOS_OS_ESCOPOS.filter((e) => e !== caso.escopo),
    );
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel (manager < admin do tokenRole) é recusado (403), sem consulta", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, sem tocar no banco", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sessão (sem Authorization) continua pelo requireRole com o papel da tabela", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await caso.chamar(undefined);
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(caso.papel, expect.objectContaining({ resource: caso.resource }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });

  it("sessão com o portão aberto responde 2xx pelo cliente de sessão e audita como pessoa", async () => {
    sessaoDeA(caso.papel);
    vi.mocked(mfaEmDivida).mockResolvedValue(false);
    const res = await caso.chamar(undefined);
    expect(res.status).toBe(caso.statusDeSucesso);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    if (caso.escreve) {
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: caso.acao, organizationId: ORG_A, actorUserId: PESSOA_DA_SESSAO }),
      );
      // Pela sessão não há token: a chave nem entra no audit.
      expect(vi.mocked(audit).mock.calls[0]?.[0]).not.toHaveProperty("actorApiTokenId");
    }
  });
});

// ---------------------------------------------------------------------------
// Funis: a etapa e o destino também têm que ser da organização do token
// ---------------------------------------------------------------------------

describe("funis com token: etapa, destino e corpo são da organização do token", () => {
  it("PATCH na etapa de A com o funil de B → 404, linha de A intacta", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaEtapa.PATCH(
      reqDe("PATCH", `/api/v1/pipelines/${PIPE_B}/stages/${E_NOVO_A}`, TOKEN_B, { name: "Tomei" }),
      comEtapa(PIPE_B, E_NOVO_A),
    );
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(linhaDe(falso, "crm_stages", E_NOVO_A)?.name).toBe("Novo");
    expect(audit).not.toHaveBeenCalled();
  });

  it("DELETE na etapa de A com o funil de B → 404, nada arquivado nem movido", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaEtapa.DELETE(
      reqDe("DELETE", `/api/v1/pipelines/${PIPE_B}/stages/${E_PROPOSTA_A}?destino=${E_NOVO_B}`, TOKEN_B),
      comEtapa(PIPE_B, E_PROPOSTA_A),
    );
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(linhaDe(falso, "crm_stages", E_PROPOSTA_A)?.is_archived).toBe(false);
    expect(linhaDe(falso, "crm_leads", LEAD_A1)?.stage_id).toBe(E_PROPOSTA_A);
    expect(audit).not.toHaveBeenCalled();
  });

  it("DELETE na etapa de B com destino de A → 422, os negócios de B ficam onde estão", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaEtapa.DELETE(
      reqDe("DELETE", `/api/v1/pipelines/${PIPE_B}/stages/${E_PROPOSTA_B}?destino=${E_NOVO_A}`, TOKEN_B),
      comEtapa(PIPE_B, E_PROPOSTA_B),
    );
    expect(res.status).toBe(422);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(linhaDe(falso, "crm_leads", LEAD_B1)?.stage_id).toBe(E_PROPOSTA_B);
    expect(linhaDe(falso, "crm_stages", E_PROPOSTA_B)?.is_archived).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("DELETE na etapa de B com destino de B funciona e grava só dentro de B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaEtapa.DELETE(
      reqDe("DELETE", `/api/v1/pipelines/${PIPE_B}/stages/${E_PROPOSTA_B}?destino=${E_NOVO_B}`, TOKEN_B),
      comEtapa(PIPE_B, E_PROPOSTA_B),
    );
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(linhaDe(falso, "crm_leads", LEAD_B1)?.stage_id).toBe(E_NOVO_B);
    expect(linhaDe(falso, "crm_leads", LEAD_A1)?.stage_id).toBe(E_PROPOSTA_A);
    expect(linhaDe(falso, "crm_stages", E_PROPOSTA_A)?.is_archived).toBe(false);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_B, actorUserId: null, actorApiTokenId: TOKEN_B }),
    );
  });

  it("POST com organization_id no corpo → 422, nada escrito (a organização vem do token)", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaEtapas.POST(
      reqDe("POST", `/api/v1/pipelines/${PIPE_B}/stages`, TOKEN_B, { name: "Retorno", organization_id: ORG_A }),
      comId(PIPE_B),
    );
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(falso.linhas.crm_stages?.some((l) => l.name === "Retorno")).toBe(false);
  });

  it("POST do token de B no próprio funil grava com a organização de B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaEtapas.POST(
      reqDe("POST", `/api/v1/pipelines/${PIPE_B}/stages`, TOKEN_B, { name: "Retorno" }),
      comId(PIPE_B),
    );
    expect(res.status).toBe(201);
    expect(falso.linhas.crm_stages?.find((l) => l.name === "Retorno")).toMatchObject({
      organization_id: ORG_B,
      pipeline_id: PIPE_B,
    });
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("forecast do token de B no próprio funil soma só os negócios de B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaPrevisao.GET(reqDe("GET", `/api/v1/pipelines/${PIPE_B}/forecast`, TOKEN_B), comId(PIPE_B));
    expect(res.status).toBe(200);
    expect((await corpoDe(res)).data.totais).toEqual([
      {
        moeda: "BRL",
        bruto_cents: 777_000,
        ponderado_cents: 777_000,
        n: 1,
        unico: { bruto_cents: 777_000, ponderado_cents: 777_000 },
        recorrente_mensal: { bruto_cents: 0, ponderado_cents: 0 },
      },
    ]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// routing/channels: a sessão segue idêntica (MFA em dívida continua barrando)
// ---------------------------------------------------------------------------

describe("GET /settings/routing/channels: a sessão segue idêntica", () => {
  it("sessão com MFA em dívida → 403 mfa_required, sem abrir o cliente do banco", async () => {
    sessaoDeA("manager");
    vi.mocked(mfaEmDivida).mockResolvedValue(true);
    const res = await rotaCanais.GET(reqDe("GET", "/api/v1/settings/routing/channels"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    expect(createClient).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });

  it("sessão chama o requireRole com allowPlatformAdmin 'leitura' e lê pelo cliente de sessão", async () => {
    sessaoDeA("manager");
    vi.mocked(mfaEmDivida).mockResolvedValue(false);
    const res = await rotaCanais.GET(reqDe("GET", "/api/v1/settings/routing/channels"));
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({ resource: "settings_routing", allowPlatformAdmin: "leitura" }),
    );
    expect(mfaEmDivida).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("o PATCH segue só de sessão: token sem cookie recebe 401 do requireRole, sem ler o Bearer", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaCanais.PATCH(
      reqDe("PATCH", "/api/v1/settings/routing/channels", TOKEN_A, {
        channel_session_id: CANAL_A,
        user_ids: [],
        reset: false,
      }),
    );
    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({ resource: "settings_routing", allowPlatformAdmin: true }),
    );
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(falso.rpcs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Borda do proxy: cada porta nova libera o caminho com UUID e nada além dele
// ---------------------------------------------------------------------------

describe("PUBLIC_PATHS — borda das portas do lote 3", () => {
  const FORECAST = `/api/v1/pipelines/${PIPE_A}/forecast`;
  const ETAPA = `/api/v1/pipelines/${PIPE_A}/stages/${E_NOVO_A}`;
  const CANAIS = "/api/v1/settings/routing/channels";

  it("libera os caminhos novos", () => {
    expect(isPublicPath(FORECAST)).toBe(true);
    expect(isPublicPath(ETAPA)).toBe(true);
    expect(isPublicPath(CANAIS)).toBe(true);
  });

  it("não libera id fora da forma de UUID", () => {
    expect(isPublicPath("/api/v1/pipelines/abc/forecast")).toBe(false);
    expect(isPublicPath("/api/v1/pipelines/abc/stages/" + E_NOVO_A)).toBe(false);
    expect(isPublicPath(`/api/v1/pipelines/${PIPE_A}/stages/abc`)).toBe(false);
  });

  it("não libera sub-path /x nem barra final", () => {
    expect(isPublicPath(`${FORECAST}/x`)).toBe(false);
    expect(isPublicPath(`${ETAPA}/x`)).toBe(false);
    expect(isPublicPath(`${CANAIS}/x`)).toBe(false);
    expect(isPublicPath(`${FORECAST}/`)).toBe(false);
    expect(isPublicPath(`${ETAPA}/`)).toBe(false);
  });

  it("o irmão literal win-rates segue na própria porta; o [stageId] não o confunde com id", () => {
    expect(isPublicPath(`/api/v1/pipelines/${PIPE_A}/stages/win-rates`)).toBe(true);
    expect(isPublicPath(`/api/v1/pipelines/${PIPE_A}/stages/win-rates/x`)).toBe(false);
  });

  it("irmãos de settings/routing que não ganharam porta seguem fora", () => {
    expect(isPublicPath("/api/v1/settings/routing/outro")).toBe(false);
    expect(isPublicPath("/api/v1/settings/art15")).toBe(false);
  });
});
