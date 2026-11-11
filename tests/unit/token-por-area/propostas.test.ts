// @vitest-environment node
/**
 * Token de integração nas rotas de propostas (Spec 33, fatia R2, ordem R2-05).
 *
 * As 9 rotas que ganham porta têm 13 métodos convertidos. Por método, a mesma
 * bateria: token de A alcança o recurso de A (2xx exato, e nada de B lido ou
 * escrito); token de B não alcança o recurso de A (404, e 409 nos métodos que
 * respondem "não está mais em rascunho" para recurso de outra organização);
 * sem o escopo → 403; abaixo do papel → 403; acima do teto da organização →
 * 429; sessão continua com o mesmo portão (`requireRole` com o papel da tabela).
 *
 * `POST .../assistant` e `POST .../preencher-com-conversa` ficam só de sessão
 * (PAREI: usam o pool do Postgres com a IA). `send` (envia ao cliente final)
 * também fica de fora e não ganha porta, então não tem caso aqui.
 *
 * O banco é `criarClienteAdminFalso`: guarda linhas das duas organizações e
 * acusa cadeia sem `organization_id` (ou RPC com outra organização). O ramo de
 * token usa o cliente admin; o cliente de sessão e o `requireRole` lançam se o
 * ramo de token os tocar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { isPublicPath } from "@/lib/auth/public-paths";
import type { Role } from "@/lib/auth/types";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateBearerToken } from "@/lib/mcp/auth";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { montarPdfDaProposta } from "@/lib/propostas/pdf-da-proposta";
import { orcamentoDeIaDisponivel } from "@/lib/propostas/orcamento-de-ia-disponivel";
import { resolverModelo } from "@/lib/propostas/modelos/resolver";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { resolverAvisoDeRevisaoSeProntaOuEncerrada } from "@/lib/propostas/aviso-de-revisao";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  linhasDaTabela,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

import * as rotaColecao from "@/app/api/v1/proposals/route";
import * as rotaDetalhe from "@/app/api/v1/proposals/[id]/route";
import * as rotaAplicar from "@/app/api/v1/proposals/[id]/assistant/apply/route";
import * as rotaDisponibilidade from "@/app/api/v1/proposals/[id]/assistant/disponibilidade/route";
import * as rotaDecidir from "@/app/api/v1/proposals/[id]/decide/route";
import * as rotaDocumento from "@/app/api/v1/proposals/[id]/documento/route";
import * as rotaModelo from "@/app/api/v1/proposals/[id]/modelo/route";
import * as rotaPrevia from "@/app/api/v1/proposals/[id]/previa/route";
import * as rotaRevisar from "@/app/api/v1/proposals/[id]/revise/route";

vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-role")>()),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/propostas/porta", () => ({ sePropostasDesligadas: vi.fn() }));
vi.mock("@/lib/propostas/aviso-de-revisao", () => ({
  resolverAvisoDeRevisaoSeProntaOuEncerrada: vi.fn(),
}));
vi.mock("@/lib/propostas/orcamento-de-ia-disponivel", () => ({ orcamentoDeIaDisponivel: vi.fn() }));
vi.mock("@/lib/propostas/pdf-da-proposta", () => ({ montarPdfDaProposta: vi.fn() }));
vi.mock("@/lib/propostas/modelos/resolver", () => ({ resolverModelo: vi.fn() }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn() }));
vi.mock("@/lib/followup/retorno-crm", () => ({ cancelaRetornoNoCrm: vi.fn() }));

// ---------------------------------------------------------------------------
// Fixtures: UUID v4 reais; duas organizações; a de A tem linhas em todas as
// tabelas que as rotas tocam. Cada caso usa o recurso de A com o token de B.
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const TODOS_OS_ESCOPOS = ["mcp:read", "mcp:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";

const LEAD_A = "11111111-1111-4111-8111-111111111111";
const LEAD_B = "22222222-2222-4222-8222-222222222222";
const LEAD_A_SEM_PROPOSTA = "31313131-3131-4313-8313-313131313131";
const CONTATO_A = "33333333-3333-4333-8333-333333333333";
const CONTATO_B = "44444444-4444-4444-8444-444444444444";
const PROP_A_RASCUNHO = "55555555-5555-4555-8555-555555555555";
const PROP_A_ENVIADA = "66666666-6666-4666-8666-666666666666";
const PROP_B_RASCUNHO = "77777777-7777-4777-8777-777777777777";
const PROP_B_ENVIADA = "88888888-8888-4888-8888-888888888888";
const ITEM_A = "99999999-9999-4999-8999-999999999999";
const ITEM_B = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

/**
 * Nenhuma tabela das rotas de propostas fica sem `organization_id`: a
 * `crm_proposal_items` tem a coluna desnormalizada (baseline.sql), e as demais
 * (crm_proposals, crm_leads, contacts) a têm desde a criação. `organizations`
 * é filtrada pela própria chave `id`, tratada pelo dublê.
 */
const SEM_ORGANIZACAO = [] as const;

const BASE_PROPOSTA = {
  lead_id: LEAD_A,
  contact_id: CONTATO_A,
  conversation_id: null,
  titulo: "Proposta de A",
  condicoes: null,
  valid_until: null,
  moeda: "BRL",
  total_cents: 0,
  pricing_status: "manual",
  revision: 1,
  numero: null,
  ano: null,
  versao: 1,
  template_slug: null,
  template_version: null,
  template_snapshot: null,
  secoes_editadas: null,
  briefing_json: {},
  retorno_id: null,
  prazo_dias_uteis: null,
  pagamento: null,
  substitui_id: null,
  created_at: "2026-10-01T10:00:00Z",
};

const PROPOSTAS = [
  { ...BASE_PROPOSTA, id: PROP_A_RASCUNHO, organization_id: ORG_A, status: "rascunho" },
  {
    ...BASE_PROPOSTA,
    id: PROP_A_ENVIADA,
    organization_id: ORG_A,
    status: "enviada",
    numero: 7,
    ano: 2026,
    titulo: "Proposta enviada de A",
  },
  {
    ...BASE_PROPOSTA,
    id: PROP_B_RASCUNHO,
    organization_id: ORG_B,
    lead_id: LEAD_B,
    contact_id: CONTATO_B,
    status: "rascunho",
    titulo: "Proposta de B",
  },
  {
    ...BASE_PROPOSTA,
    id: PROP_B_ENVIADA,
    organization_id: ORG_B,
    lead_id: LEAD_B,
    contact_id: CONTATO_B,
    status: "enviada",
    numero: 3,
    ano: 2026,
    titulo: "Proposta enviada de B",
  },
];

const ITENS = [
  {
    id: ITEM_A,
    organization_id: ORG_A,
    proposal_id: PROP_A_RASCUNHO,
    product_id: null,
    descricao: "Consultoria de A",
    quantidade: 1,
    preco_unitario_cents: 150000,
    desconto_cents: 0,
    position: 1,
  },
  {
    id: ITEM_B,
    organization_id: ORG_B,
    proposal_id: PROP_B_RASCUNHO,
    product_id: null,
    descricao: "Consultoria de B",
    quantidade: 1,
    preco_unitario_cents: 90000,
    desconto_cents: 0,
    position: 1,
  },
];

const LEADS = [
  { id: LEAD_A, organization_id: ORG_A, contact_id: CONTATO_A, title: "Negócio de A" },
  { id: LEAD_A_SEM_PROPOSTA, organization_id: ORG_A, contact_id: CONTATO_A, title: "Negócio de A sem proposta" },
  { id: LEAD_B, organization_id: ORG_B, contact_id: CONTATO_B, title: "Negócio de B" },
];

const ORGANIZACOES = [
  { id: ORG_A, currency: "BRL", timezone: "America/Sao_Paulo", settings: {} },
  { id: ORG_B, currency: "BRL", timezone: "America/Sao_Paulo", settings: {} },
];

const LINHAS = {
  crm_proposals: PROPOSTAS,
  crm_proposal_items: ITENS,
  crm_leads: LEADS,
  organizations: ORGANIZACOES,
};

const ITEM_MANUAL = {
  product_id: null,
  descricao: "Item manual de A",
  quantidade: 1,
  preco_unitario_cents: 1500,
  desconto_cents: 0,
  position: 1,
};

function novoFalso() {
  return criarClienteAdminFalso({ orgDona: ORG_A, linhas: LINHAS, tabelasSemOrganizacao: SEM_ORGANIZACAO });
}

let falso: ReturnType<typeof novoFalso>;

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

type PapelDaTabela = "viewer" | "agent" | "manager";

/** O papel que um token precisa ter a menos: a recusa de "abaixo do papel". */
const DEGRAU_ABAIXO: Record<PapelDaTabela, Role | null> = {
  viewer: null, // ninguém abaixo de viewer: o caso não existe para leitura de viewer
  agent: "viewer",
  manager: "agent",
};

function outroEscopo(escopo: "mcp:read" | "mcp:write"): string {
  return escopo === "mcp:read" ? "mcp:write" : "mcp:read";
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

function req(url: string, metodo: string, token?: string, corpo?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: metodo,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
}

function paramsDe(id: string) {
  return { params: Promise.resolve({ id }) };
}

type Caso = {
  nome: string;
  papel: PapelDaTabela;
  escopo: "mcp:read" | "mcp:write";
  escrita: boolean;
  status: 200 | 201;
  /** 404 ou 409: o que a rota devolve para recurso de A vista pelo token de B. */
  recusaB: 404 | 409;
  /** Só na coleção: as ids de A que a lista de A deve trazer, e nenhuma de B. */
  colecao?: { idsDeA: string[] };
  chamar: (token: string | undefined) => Promise<Response>;
  /** Confere o efeito de escrita depois de um 2xx (linhas vivas do falso). */
  depoisDoSucesso?: () => void;
};

// ---------------------------------------------------------------------------
// Bateria: seis testes por método
// ---------------------------------------------------------------------------

function bateriaDoMetodo(caso: Caso): void {
  describe(caso.nome, () => {
    it(`token de A alcança o recurso de A (${caso.status}), sem tocar em B`, async () => {
      tokenDe(ORG_A, TOKEN_A, caso.papel);
      const res = await caso.chamar(TOKEN_A);
      expect(res.status).toBe(caso.status);
      const colecao = caso.colecao;
      if (colecao) {
        const corpo = (await res.json()) as { data: Array<{ id: string }> };
        expect(corpo.data.map((l) => l.id).sort()).toEqual([...colecao.idsDeA].sort());
      }
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      if (caso.escrita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
        );
      }
      caso.depoisDoSucesso?.();
    });

    it("token de B não alcança o recurso de A (404, 409 ou lista só de B), sem escrita", async () => {
      const antes = structuredClone(falso.linhas);
      tokenDe(ORG_B, TOKEN_B, "admin");
      const res = await caso.chamar(TOKEN_B);
      const colecao = caso.colecao;
      if (colecao) {
        expect(res.status).toBe(200);
        const corpo = (await res.json()) as { data: Array<{ id: string }> };
        expect(corpo.data.map((l) => l.id).some((id) => colecao.idsDeA.includes(id))).toBe(false);
      } else {
        expect(res.status).toBe(caso.recusaB);
      }
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(falso.linhas).toEqual(antes);
      expect(audit).not.toHaveBeenCalled();
    });

    it("token sem o escopo exigido é recusado (403), sem tocar no banco", async () => {
      tokenDe(ORG_A, TOKEN_A, "admin", [outroEscopo(caso.escopo)]);
      const res = await caso.chamar(TOKEN_A);
      expect(res.status).toBe(403);
      expect(falso.cadeias).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    const abaixo = DEGRAU_ABAIXO[caso.papel];
    if (abaixo) {
      it(`token abaixo do papel (${abaixo}) é recusado (403), sem tocar no banco`, async () => {
        tokenDe(ORG_A, TOKEN_A, abaixo);
        const res = await caso.chamar(TOKEN_A);
        expect(res.status).toBe(403);
        expect(falso.cadeias).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }

    it("acima do teto da organização → 429 com Retry-After, sem tocar no banco", async () => {
      // Token dentro do teto (balde do token), organização estourada (balde da organização).
      vi.mocked(checkRateLimit)
        .mockResolvedValueOnce({ allowed: true, count: 1, limit: 30 } as never)
        .mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
      tokenDe(ORG_A, TOKEN_A, caso.papel);
      const res = await caso.chamar(TOKEN_A);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(falso.cadeias).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    it("sessão continua com o mesmo portão (requireRole com o papel da tabela)", async () => {
      vi.mocked(requireRole).mockResolvedValueOnce({
        ok: false,
        response: new Response(null, { status: 403 }),
      } as never);
      const res = await caso.chamar(undefined);
      expect(res.status).toBe(403);
      expect(requireRole).toHaveBeenCalledWith(caso.papel, expect.objectContaining({ resource: "crm_proposals" }));
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(falso.cadeias).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Casos: um por método convertido (13), na ordem da tabela do plano
// ---------------------------------------------------------------------------

const CASOS: Caso[] = [
  {
    nome: "GET /api/v1/proposals — lista",
    papel: "viewer", // viewer: sem caso de "abaixo do papel" (não há degrau abaixo)
    escopo: "mcp:read",
    escrita: false,
    status: 200,
    recusaB: 404,
    colecao: { idsDeA: [PROP_A_RASCUNHO, PROP_A_ENVIADA] },
    chamar: (t) => rotaColecao.GET(req("/api/v1/proposals", "GET", t)),
  },
  {
    nome: "POST /api/v1/proposals — cria rascunho",
    papel: "agent",
    escopo: "mcp:write",
    escrita: true,
    status: 201,
    recusaB: 404,
    chamar: (t) =>
      rotaColecao.POST(
        req("/api/v1/proposals", "POST", t, { lead_id: LEAD_A_SEM_PROPOSTA, titulo: "Proposta nova", itens: [] }),
      ),
    depoisDoSucesso: () => {
      expect(
        linhasDaTabela(falso, "crm_proposals").some(
          (l) => l.titulo === "Proposta nova" && l.organization_id === ORG_A && l.lead_id === LEAD_A_SEM_PROPOSTA,
        ),
      ).toBe(true);
    },
  },
  {
    nome: "GET /api/v1/proposals/[id] — lê uma proposta",
    papel: "viewer",
    escopo: "mcp:read",
    escrita: false,
    status: 200,
    recusaB: 404,
    chamar: (t) => rotaDetalhe.GET(req(`/api/v1/proposals/${PROP_A_RASCUNHO}`, "GET", t), paramsDe(PROP_A_RASCUNHO)),
  },
  {
    nome: "PATCH /api/v1/proposals/[id] — edita rascunho",
    papel: "agent",
    escopo: "mcp:write",
    escrita: true,
    status: 200,
    recusaB: 409,
    chamar: (t) =>
      rotaDetalhe.PATCH(
        req(`/api/v1/proposals/${PROP_A_RASCUNHO}`, "PATCH", t, {
          revision: 1,
          titulo: "Proposta de A editada",
          itens: [ITEM_MANUAL],
        }),
        paramsDe(PROP_A_RASCUNHO),
      ),
    depoisDoSucesso: () => {
      expect(linhasDaTabela(falso, "crm_proposals").find((l) => l.id === PROP_A_RASCUNHO)?.revision).toBe(2);
    },
  },
  {
    nome: "DELETE /api/v1/proposals/[id] — descarta rascunho",
    papel: "manager",
    escopo: "mcp:write",
    escrita: true,
    status: 200,
    recusaB: 409,
    chamar: (t) =>
      rotaDetalhe.DELETE(req(`/api/v1/proposals/${PROP_A_RASCUNHO}`, "DELETE", t), paramsDe(PROP_A_RASCUNHO)),
    depoisDoSucesso: () => {
      expect(linhasDaTabela(falso, "crm_proposals").find((l) => l.id === PROP_A_RASCUNHO)?.status).toBe("cancelada");
    },
  },
  {
    nome: "POST /api/v1/proposals/[id]/assistant/apply — aplica mudanças do assistente",
    papel: "agent",
    escopo: "mcp:write",
    escrita: true,
    status: 200,
    recusaB: 404,
    chamar: (t) =>
      rotaAplicar.POST(
        req(`/api/v1/proposals/${PROP_A_RASCUNHO}/assistant/apply`, "POST", t, {
          revision: 1,
          mudancas: [{ tipo: "editar_proposta", campo: "titulo", de: "x", para: "y" }],
        }),
        paramsDe(PROP_A_RASCUNHO),
      ),
    depoisDoSucesso: () => {
      expect(linhasDaTabela(falso, "crm_proposals").find((l) => l.id === PROP_A_RASCUNHO)?.titulo).toBe("y");
    },
  },
  {
    nome: "GET /api/v1/proposals/[id]/assistant/disponibilidade — orçamento de IA",
    papel: "agent",
    escopo: "mcp:read",
    escrita: false,
    status: 200,
    recusaB: 404,
    chamar: (t) =>
      rotaDisponibilidade.GET(
        req(`/api/v1/proposals/${PROP_A_RASCUNHO}/assistant/disponibilidade`, "GET", t),
        paramsDe(PROP_A_RASCUNHO),
      ),
  },
  {
    nome: "POST /api/v1/proposals/[id]/decide — decide proposta enviada",
    papel: "agent",
    escopo: "mcp:write",
    escrita: true,
    status: 200,
    recusaB: 409,
    chamar: (t) =>
      rotaDecidir.POST(
        req(`/api/v1/proposals/${PROP_A_ENVIADA}/decide`, "POST", t, { decisao: "aceita" }),
        paramsDe(PROP_A_ENVIADA),
      ),
    depoisDoSucesso: () => {
      expect(linhasDaTabela(falso, "crm_proposals").find((l) => l.id === PROP_A_ENVIADA)?.status).toBe("aceita");
    },
  },
  {
    nome: "GET /api/v1/proposals/[id]/documento — lê o documento",
    papel: "viewer",
    escopo: "mcp:read",
    escrita: false,
    status: 200,
    recusaB: 404,
    chamar: (t) =>
      rotaDocumento.GET(req(`/api/v1/proposals/${PROP_A_RASCUNHO}/documento`, "GET", t), paramsDe(PROP_A_RASCUNHO)),
  },
  {
    nome: "PATCH /api/v1/proposals/[id]/documento — edita uma seção do rascunho",
    papel: "manager",
    escopo: "mcp:write",
    escrita: true,
    status: 200,
    recusaB: 404,
    chamar: (t) =>
      rotaDocumento.PATCH(
        req(`/api/v1/proposals/${PROP_A_RASCUNHO}/documento`, "PATCH", t, {
          secaoId: "abertura",
          texto: "Texto da abertura",
        }),
        paramsDe(PROP_A_RASCUNHO),
      ),
    depoisDoSucesso: () => {
      expect(linhasDaTabela(falso, "crm_proposals").find((l) => l.id === PROP_A_RASCUNHO)?.secoes_editadas).toEqual({
        abertura: "Texto da abertura",
      });
    },
  },
  {
    nome: "PATCH /api/v1/proposals/[id]/modelo — confirma o modelo",
    papel: "manager",
    escopo: "mcp:write",
    escrita: true,
    status: 200,
    recusaB: 404,
    chamar: (t) =>
      rotaModelo.PATCH(
        req(`/api/v1/proposals/${PROP_A_RASCUNHO}/modelo`, "PATCH", t, { template_slug: "modelo-a" }),
        paramsDe(PROP_A_RASCUNHO),
      ),
    depoisDoSucesso: () => {
      expect(linhasDaTabela(falso, "crm_proposals").find((l) => l.id === PROP_A_RASCUNHO)?.template_slug).toBe(
        "modelo-a",
      );
    },
  },
  {
    nome: "GET /api/v1/proposals/[id]/previa — PDF que o cliente recebe, sem enviar",
    papel: "agent",
    escopo: "mcp:read",
    escrita: false,
    status: 200,
    recusaB: 404,
    chamar: (t) => rotaPrevia.GET(req(`/api/v1/proposals/${PROP_A_RASCUNHO}/previa`, "GET", t), paramsDe(PROP_A_RASCUNHO)),
  },
  {
    nome: "POST /api/v1/proposals/[id]/revise — cria a v2 de uma proposta enviada",
    papel: "manager",
    escopo: "mcp:write",
    escrita: true,
    status: 201,
    recusaB: 404,
    chamar: (t) =>
      rotaRevisar.POST(
        req(`/api/v1/proposals/${PROP_A_ENVIADA}/revise`, "POST", t, { motivo: "Ajuste de preço" }),
        paramsDe(PROP_A_ENVIADA),
      ),
    depoisDoSucesso: () => {
      expect(
        linhasDaTabela(falso, "crm_proposals").some(
          (l) => l.substitui_id === PROP_A_ENVIADA && l.organization_id === ORG_A,
        ),
      ).toBe(true);
    },
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  falso = novoFalso();
  // Cliente admin do token: o dublê. Sem a sessão, o mesmo dublê não existe.
  vi.mocked(createAdminClient).mockImplementation(() => falso.cliente as never);
  // Tripwires: se o ramo de token tocar a sessão, a chamada quebra.
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole chamado no ramo do token");
  });
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(sePropostasDesligadas).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 30 } as never);
  vi.mocked(resolverModelo).mockResolvedValue({ slug: "modelo-a", version: 1 } as never);
  vi.mocked(orcamentoDeIaDisponivel).mockResolvedValue({ disponivel: true, motivo: null } as never);
  vi.mocked(montarPdfDaProposta).mockResolvedValue({ ok: true, buffer: new ArrayBuffer(4) } as never);
  vi.mocked(emitLeadActivity).mockResolvedValue({ ok: true } as never);
  vi.mocked(resolverAvisoDeRevisaoSeProntaOuEncerrada).mockResolvedValue(undefined);
});

describe("propostas — token de integração por método", () => {
  for (const caso of CASOS) bateriaDoMetodo(caso);
});

describe("fica só de sessão (PAREI): assistant e preencher-com-conversa, POST", () => {
  it("POST /proposals/[id]/assistant: token sem cookie → 401, sem cliente admin", async () => {
    const rota = await import("@/app/api/v1/proposals/[id]/assistant/route");
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rota.POST(
      req(`/api/v1/proposals/${PROP_A_RASCUNHO}/assistant`, "POST", TOKEN_A, { instrucao: "baixa 10%" }),
      paramsDe(PROP_A_RASCUNHO),
    );
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(validateBearerToken).not.toHaveBeenCalled();
  });

  it("POST /proposals/[id]/preencher-com-conversa: token sem cookie → 401, sem cliente admin", async () => {
    const rota = await import("@/app/api/v1/proposals/[id]/preencher-com-conversa/route");
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rota.POST(
      req(`/api/v1/proposals/${PROP_A_RASCUNHO}/preencher-com-conversa`, "POST", TOKEN_A),
      paramsDe(PROP_A_RASCUNHO),
    );
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Borda do proxy: cada porta nova libera o caminho com UUID e nada além dele
// ---------------------------------------------------------------------------

describe("PUBLIC_PATHS — borda do proxy (propostas)", () => {
  const COM_ID = [
    "/api/v1/proposals/[id]",
    "/api/v1/proposals/[id]/assistant/apply",
    "/api/v1/proposals/[id]/assistant/disponibilidade",
    "/api/v1/proposals/[id]/decide",
    "/api/v1/proposals/[id]/documento",
    "/api/v1/proposals/[id]/modelo",
    "/api/v1/proposals/[id]/previa",
    "/api/v1/proposals/[id]/revise",
  ];
  // Irmãos do mesmo nível que NÃO ganharam porta: seguem fora do proxy.
  const IRMAOS_SO_DE_SESSAO = [
    "/api/v1/proposals/[id]/assistant",
    "/api/v1/proposals/[id]/preencher-com-conversa",
    "/api/v1/proposals/[id]/send",
  ];

  it("libera o caminho da coleção e os caminhos com id em forma de UUID", () => {
    expect(isPublicPath("/api/v1/proposals")).toBe(true);
    for (const c of COM_ID) expect(isPublicPath(c.replace("[id]", PROP_A_RASCUNHO))).toBe(true);
  });

  it("não libera id fora da forma de UUID", () => {
    for (const c of COM_ID) expect(isPublicPath(c.replace("[id]", "abc"))).toBe(false);
    expect(isPublicPath("/api/v1/proposals/abc")).toBe(false);
  });

  it("não libera sub-path /x em nenhum caminho da lista", () => {
    for (const c of COM_ID) expect(isPublicPath(`${c.replace("[id]", PROP_A_RASCUNHO)}/x`)).toBe(false);
    expect(isPublicPath("/api/v1/proposals/x")).toBe(false);
  });

  it("irmãos que não ganharam porta seguem fora, mesmo com UUID", () => {
    for (const c of IRMAOS_SO_DE_SESSAO) expect(isPublicPath(c.replace("[id]", PROP_A_RASCUNHO))).toBe(false);
  });
});
