// @vitest-environment node
/**
 * FINANCEIRO E HONORÁRIOS ACEITAM TOKEN (Spec 33, fatia R2, tarefa 8).
 *
 * Os métodos convertidos (leitura de catálogo, comandas, itens, fila de
 * faturamento, fidelidade, lançamentos e contratos/parcelas de honorários)
 * recebem o Bearer `dsk_…` por `resolveAuthDual`. O cliente do token é a
 * service role: a RLS deixa de proteger, e o `.eq("organization_id", …)` de
 * CADA cadeia é a única barreira entre a organização do token e as demais. O
 * cliente falso (`../helpers/cliente-admin-falso`) vê isso.
 *
 * FICAM DE FORA, só de sessão (funções do banco que exigem `auth.uid()`):
 * honorários `pagar`, comandas `estornar`/`finalizar`, `faturar-lote`. Eles têm
 * caso próprio: o token é recusado com 401 e nada é escrito. Catálogo
 * POST/PATCH/DELETE, fidelidade POST, lançamentos POST/PATCH/DELETE e parcelas
 * POST aceitam token desde a R2 (lote 2): ver `operacao-r2.test.ts`.
 *
 * Seis testes por método convertido (receita R2), mais o 429 do teto por
 * organização e os casos de borda do proxy.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  linhasDaTabela,
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
const CONTATO_B = "b6666666-6666-4666-8666-666666666666";
const CONTA_A = "a2222222-2222-4222-8222-222222222222";
const CONTA_B = "b2222222-2222-4222-8222-222222222222";
const AGENDA_A = "a3333333-3333-4333-8333-333333333333";
const AGENDA_B = "b3333333-3333-4333-8333-333333333333";
const LANC_A = "a4444444-4444-4444-8444-444444444444";
const LANC_B = "b4444444-4444-4444-8444-444444444444";
const CONTRATO_A = "a5555555-5555-4555-8555-555555555555";
const CONTRATO_B = "b5555555-5555-4555-8555-555555555555";
const SALE_A = "a1111111-1111-4111-8111-111111111111";
const SALE_B = "b1111111-1111-4111-8111-111111111111";
const ITEM_A = "a7777777-7777-4777-8777-777777777777";
const ITEM_B = "b7777777-7777-4777-8777-777777777777";
const PARCELA_A = "a8888888-8888-4888-8888-888888888888";
const PARCELA_B = "b8888888-8888-4888-8888-888888888888";
const PONTO_A = "a9999999-9999-4999-8999-999999999999";
const PONTO_B = "b9999999-9999-4999-8999-999999999999";

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
  escopo: "mcp:read" | "mcp:write";
  recurso: string;
  recursoDoTeto?: string;
  rpc?: Record<string, unknown>;
  rotulo?: string;
  status: number;
  colecao?: { daA: string; daB: string };
  audita?: boolean;
  /** O que o token de B recebe quando pede o recurso de A. */
  paraB?: "lista" | "lista_vazia" | "404" | "422" | "cria";
  /** Tabela onde o método de B cria linha (só com `paraB: "cria"`). */
  tabelaCriada?: string;
  /** Quando a rota não chama `createAdminClient` antes do portão de sessão. */
  adminNaoChamado?: boolean;
};

/** Módulo financeiro ligado nesta instalação (a flag é lida antes do portão). */
const MODULOS = { modulos_instalados: [{ modulo: "financeiro", estado: "ativo" }] };
/** Moeda de cada organização (lida por `moedaDaOrganizacao`). */
const ORGS = {
  organizations: [
    { id: ORG_A, currency: "BRL" },
    { id: ORG_B, currency: "BRL" },
  ],
};

/** Tabelas GLOBAIS da instalação, sem `organization_id` no baseline. */
const SEM_ORGANIZACAO: readonly string[] = ["platform_config", "modulos_instalados"];

type Venda = Linha;
const VENDA_A: Venda = {
  id: SALE_A,
  organization_id: ORG_A,
  number: 1,
  status: "open",
  discount_cents: 0,
  total_cents: 0,
  notes: "comanda da A",
  created_at: "2026-11-01T10:00:00.000Z",
};
const VENDA_B: Venda = {
  id: SALE_B,
  organization_id: ORG_B,
  number: 2,
  status: "open",
  discount_cents: 0,
  total_cents: 0,
  notes: "comanda da B",
  created_at: "2026-11-01T10:00:00.000Z",
};

const CASOS: readonly Caso[] = [
  // ─── Catálogo (leitura): viewer ──────────────────────────────────────────
  {
    rota: "financeiro/catalogo/[tipo]",
    metodo: "GET",
    caminho: "/api/v1/financeiro/catalogo/contas",
    params: { tipo: "contas" },
    linhas: {
      ...MODULOS,
      ...ORGS,
      financial_accounts: [
        { id: CONTA_A, organization_id: ORG_A, name: "Conta da A", kind: "cash", currency: "BRL", is_active: true },
        { id: CONTA_B, organization_id: ORG_B, name: "Conta da B", kind: "cash", currency: "BRL", is_active: true },
      ],
    },
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "financeiro",
    recursoDoTeto: "financeiro_catalogo",
    status: 200,
    paraB: "lista",
    colecao: { daA: "Conta da A", daB: "Conta da B" },
  },

  // ─── Comandas: listar e abrir ────────────────────────────────────────────
  {
    rota: "financeiro/comandas",
    metodo: "GET",
    caminho: "/api/v1/financeiro/comandas",
    linhas: { ...MODULOS, ...ORGS, sales: [VENDA_A, VENDA_B] },
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "financeiro",
    recursoDoTeto: "financeiro_comandas_listar",
    status: 200,
    paraB: "lista",
    colecao: { daA: "comanda da A", daB: "comanda da B" },
  },
  {
    rota: "financeiro/comandas",
    metodo: "POST",
    caminho: "/api/v1/financeiro/comandas",
    corpo: { contact_id: CONTATO_A, notes: "abertura da A" },
    linhas: {
      ...MODULOS,
      ...ORGS,
      contacts: [
        { id: CONTATO_A, organization_id: ORG_A, name: "Cliente da A" },
        { id: CONTATO_B, organization_id: ORG_B, name: "Cliente da B" },
      ],
      sales: [],
      calendar_appointments: [],
    },
    rpc: { fn_proximo_numero_de_comanda: 7 },
    papel: "agent",
    escopo: "mcp:write",
    recurso: "financeiro",
    recursoDoTeto: "financeiro_comandas_abrir",
    status: 200,
    // O corpo referencia o contato de A: o token de B recebe 422, e nada é gravado.
    paraB: "422",
    audita: true,
  },

  // ─── Uma comanda ─────────────────────────────────────────────────────────
  {
    rota: "financeiro/comandas/[id]",
    metodo: "GET",
    caminho: `/api/v1/financeiro/comandas/${SALE_A}`,
    params: { id: SALE_A },
    linhas: { ...MODULOS, ...ORGS, sales: [VENDA_A, VENDA_B] },
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "financeiro",
    recursoDoTeto: "financeiro_comanda_ler",
    status: 200,
    paraB: "404",
    colecao: { daA: "comanda da A", daB: "comanda da B" },
  },
  {
    rota: "financeiro/comandas/[id]",
    metodo: "PATCH",
    caminho: `/api/v1/financeiro/comandas/${SALE_A}`,
    params: { id: SALE_A },
    corpo: { discount_cents: 100 },
    linhas: { ...MODULOS, ...ORGS, sales: [VENDA_A, VENDA_B] },
    papel: "agent",
    escopo: "mcp:write",
    recurso: "financeiro",
    recursoDoTeto: "financeiro_comanda_alterar",
    status: 200,
    paraB: "404",
    audita: true,
  },

  // ─── Itens da comanda ────────────────────────────────────────────────────
  {
    rota: "financeiro/comandas/[id]/itens",
    metodo: "POST",
    caminho: `/api/v1/financeiro/comandas/${SALE_A}/itens`,
    params: { id: SALE_A },
    corpo: { description: "Corte", quantity: 1, unit_price_cents: 5000 },
    linhas: {
      ...MODULOS,
      ...ORGS,
      sales: [VENDA_A, VENDA_B],
      sale_items: [],
      commission_rules: [],
      calendar_appointments: [],
    },
    papel: "agent",
    escopo: "mcp:write",
    recurso: "financeiro",
    recursoDoTeto: "financeiro_comanda_item_incluir",
    status: 200,
    paraB: "404",
    audita: true,
  },
  {
    rota: "financeiro/comandas/[id]/itens/[itemId]",
    metodo: "DELETE",
    caminho: `/api/v1/financeiro/comandas/${SALE_A}/itens/${ITEM_A}`,
    params: { id: SALE_A, itemId: ITEM_A },
    linhas: {
      ...MODULOS,
      ...ORGS,
      sales: [VENDA_A, VENDA_B],
      sale_items: [
        { id: ITEM_A, organization_id: ORG_A, sale_id: SALE_A, description: "Item da A" },
        { id: ITEM_B, organization_id: ORG_B, sale_id: SALE_B, description: "Item da B" },
      ],
    },
    papel: "agent",
    escopo: "mcp:write",
    recurso: "financeiro",
    recursoDoTeto: "financeiro_comanda_item_remover",
    status: 200,
    paraB: "404",
    audita: true,
  },

  // ─── Fila de faturamento (leitura) ───────────────────────────────────────
  {
    rota: "financeiro/comandas/pendentes",
    metodo: "GET",
    caminho: "/api/v1/financeiro/comandas/pendentes?de=2000-01-01T00:00:00.000Z",
    linhas: {
      ...MODULOS,
      ...ORGS,
      calendar_appointments: [
        {
          id: AGENDA_A,
          organization_id: ORG_A,
          title: "Atendimento da A",
          starts_at: "2001-06-01T10:00:00.000Z",
          contact_id: CONTATO_A,
          event_type_id: null,
          status: "confirmed",
        },
        {
          id: AGENDA_B,
          organization_id: ORG_B,
          title: "Atendimento da B",
          starts_at: "2001-06-01T11:00:00.000Z",
          contact_id: CONTATO_B,
          event_type_id: null,
          status: "confirmed",
        },
      ],
      sales: [],
      calendar_event_types: [],
    },
    papel: "agent",
    escopo: "mcp:read",
    recurso: "financeiro",
    recursoDoTeto: "financeiro_comandas_pendentes",
    status: 200,
    paraB: "lista",
    colecao: { daA: "Atendimento da A", daB: "Atendimento da B" },
  },

  // ─── Fidelidade (só o saldo e o extrato) ─────────────────────────────────
  {
    rota: "financeiro/fidelidade",
    metodo: "GET",
    caminho: `/api/v1/financeiro/fidelidade?contact_id=${CONTATO_A}`,
    linhas: {
      ...MODULOS,
      ...ORGS,
      loyalty_ledger: [
        { id: PONTO_A, organization_id: ORG_A, contact_id: CONTATO_A, points: 10, reason: "Ponto da A", created_at: "2026-11-01T10:00:00.000Z" },
        { id: PONTO_B, organization_id: ORG_B, contact_id: CONTATO_B, points: 5, reason: "Ponto da B", created_at: "2026-11-01T10:00:00.000Z" },
      ],
    },
    // O saldo depende da organização do argumento, como no banco: um RPC que
    // devolvesse 10 para qualquer `p_org` esconderia o vazamento.
    rpc: { fn_saldo_de_fidelidade: (args: Record<string, unknown>) => ({ data: args.p_org === ORG_A ? 10 : 0 }) },
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "financeiro",
    recursoDoTeto: "financeiro_fidelidade_saldo",
    status: 200,
    // O contato pedido é de A: para o token de B o extrato vem vazio.
    paraB: "lista_vazia",
    colecao: { daA: "Ponto da A", daB: "Ponto da B" },
  },

  // ─── Lançamentos (só a leitura do extrato) ───────────────────────────────
  {
    rota: "financeiro/lancamentos",
    metodo: "GET",
    caminho: "/api/v1/financeiro/lancamentos",
    linhas: {
      ...ORGS,
      financial_entries: [
        { id: LANC_A, organization_id: ORG_A, account_id: CONTA_A, direction: "in", amount_cents: 100, currency: "BRL", description: "Lançamento da A", entry_date: "2026-11-01", status: "pending", origin: "manual", created_at: "2026-11-01T10:00:00.000Z" },
        { id: LANC_B, organization_id: ORG_B, account_id: CONTA_B, direction: "in", amount_cents: 200, currency: "BRL", description: "Lançamento da B", entry_date: "2026-11-01", status: "pending", origin: "manual", created_at: "2026-11-01T10:00:00.000Z" },
      ],
    },
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "financeiro",
    recursoDoTeto: "financeiro_lancamentos_listar",
    status: 200,
    paraB: "lista",
    colecao: { daA: "Lançamento da A", daB: "Lançamento da B" },
  },

  // ─── Honorários: contratos e parcelas ────────────────────────────────────
  {
    rota: "honorarios/contratos",
    metodo: "GET",
    caminho: "/api/v1/honorarios/contratos",
    linhas: {
      ...ORGS,
      honorarios_contratos: [
        { id: CONTRATO_A, organization_id: ORG_A, lead_id: null, modelo: "fixo", valor_fixo_cents: 100, percentual_exito: null, repasse_advogado_pct: null, created_at: "2026-11-01T10:00:00.000Z" },
        { id: CONTRATO_B, organization_id: ORG_B, lead_id: null, modelo: "fixo", valor_fixo_cents: 200, percentual_exito: null, repasse_advogado_pct: null, created_at: "2026-11-01T10:00:00.000Z" },
      ],
    },
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "honorarios_contratos",
    recursoDoTeto: "honorarios_contratos_listar",
    status: 200,
    paraB: "lista",
    colecao: { daA: CONTRATO_A, daB: CONTRATO_B },
  },
  {
    rota: "honorarios/contratos",
    metodo: "POST",
    caminho: "/api/v1/honorarios/contratos",
    corpo: { modelo: "fixo", valor_fixo_cents: 500000 },
    linhas: {
      ...ORGS,
      honorarios_contratos: [
        { id: CONTRATO_A, organization_id: ORG_A, modelo: "fixo", valor_fixo_cents: 100 },
        { id: CONTRATO_B, organization_id: ORG_B, modelo: "fixo", valor_fixo_cents: 200 },
      ],
    },
    papel: "manager",
    escopo: "mcp:write",
    recurso: "honorarios_contratos",
    recursoDoTeto: "honorarios_contratos_criar",
    status: 200,
    // Não referencia nada de A: o token de B cria o contrato na organização B.
    paraB: "cria",
    tabelaCriada: "honorarios_contratos",
    audita: true,
  },
  {
    rota: "honorarios/contratos/[id]/parcelas",
    metodo: "GET",
    caminho: `/api/v1/honorarios/contratos/${CONTRATO_A}/parcelas`,
    params: { id: CONTRATO_A },
    linhas: {
      ...ORGS,
      honorarios_parcelas: [
        { id: PARCELA_A, organization_id: ORG_A, contrato_id: CONTRATO_A, numero: 1, vencimento: "2026-12-01", valor_cents: 100, currency: "BRL", financial_entry_id: null, status: "pendente" },
        { id: PARCELA_B, organization_id: ORG_B, contrato_id: CONTRATO_B, numero: 1, vencimento: "2026-12-01", valor_cents: 200, currency: "BRL", financial_entry_id: null, status: "pendente" },
      ],
    },
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "honorarios_parcelas",
    recursoDoTeto: "honorarios_parcelas_listar",
    status: 200,
    paraB: "lista_vazia",
    colecao: { daA: PARCELA_A, daB: PARCELA_B },
  },
];

/**
 * Métodos que FICAM DE FORA (só de sessão). Com token, o `requireRole` da rota
 * recusa com 401, e nada é gravado. Estes casos são o que impede a conversão
 * de vazar para dinheiro por engano.
 */
const SO_SESSAO: readonly Caso[] = [
  // Comandas: finalizar, estornar e faturar em lote movem dinheiro.
  { rota: "financeiro/comandas/[id]/estornar", metodo: "POST", caminho: `/api/v1/financeiro/comandas/${SALE_A}/estornar`, params: { id: SALE_A }, corpo: { reason: "erro de lançamento" }, linhas: { ...MODULOS, ...ORGS, sales: [VENDA_A] }, papel: "manager", escopo: "mcp:write", recurso: "financeiro", status: 401, adminNaoChamado: false },
  { rota: "financeiro/comandas/[id]/finalizar", metodo: "POST", caminho: `/api/v1/financeiro/comandas/${SALE_A}/finalizar`, params: { id: SALE_A }, corpo: { payment_method_id: "a1212121-1212-4121-8121-121212121212", loyalty_points: 0 }, linhas: { ...MODULOS, ...ORGS, sales: [VENDA_A] }, papel: "agent", escopo: "mcp:write", recurso: "financeiro", status: 401, adminNaoChamado: false },
  { rota: "financeiro/comandas/faturar-lote", metodo: "POST", caminho: "/api/v1/financeiro/comandas/faturar-lote", corpo: {}, linhas: { ...MODULOS, ...ORGS, sales: [] }, papel: "agent", escopo: "mcp:write", recurso: "financeiro", status: 401, adminNaoChamado: false },
  // Honorários: pagar uma parcela e gerar parcela de cobrança.
  { rota: "honorarios/parcelas/[id]/pagar", metodo: "POST", caminho: `/api/v1/honorarios/parcelas/${PARCELA_A}/pagar`, params: { id: PARCELA_A }, corpo: {}, linhas: { ...ORGS, honorarios_parcelas: [{ id: PARCELA_A, organization_id: ORG_A, status: "pendente" }] }, papel: "manager", escopo: "mcp:write", recurso: "honorarios_parcelas", status: 401, adminNaoChamado: true },
];

const CARREGA: Record<string, () => Promise<Record<string, unknown>>> = {
  "financeiro/catalogo/[tipo]": () => import("@/app/api/v1/financeiro/catalogo/[tipo]/route"),
  "financeiro/comandas": () => import("@/app/api/v1/financeiro/comandas/route"),
  "financeiro/comandas/pendentes": () => import("@/app/api/v1/financeiro/comandas/pendentes/route"),
  "financeiro/comandas/[id]": () => import("@/app/api/v1/financeiro/comandas/[id]/route"),
  "financeiro/comandas/[id]/itens": () => import("@/app/api/v1/financeiro/comandas/[id]/itens/route"),
  "financeiro/comandas/[id]/itens/[itemId]": () =>
    import("@/app/api/v1/financeiro/comandas/[id]/itens/[itemId]/route"),
  "financeiro/comandas/[id]/estornar": () => import("@/app/api/v1/financeiro/comandas/[id]/estornar/route"),
  "financeiro/comandas/[id]/finalizar": () => import("@/app/api/v1/financeiro/comandas/[id]/finalizar/route"),
  "financeiro/comandas/faturar-lote": () => import("@/app/api/v1/financeiro/comandas/faturar-lote/route"),
  "financeiro/fidelidade": () => import("@/app/api/v1/financeiro/fidelidade/route"),
  "financeiro/lancamentos": () => import("@/app/api/v1/financeiro/lancamentos/route"),
  "financeiro/lancamentos/[id]": () => import("@/app/api/v1/financeiro/lancamentos/[id]/route"),
  "honorarios/contratos": () => import("@/app/api/v1/honorarios/contratos/route"),
  "honorarios/contratos/[id]/parcelas": () =>
    import("@/app/api/v1/honorarios/contratos/[id]/parcelas/route"),
  "honorarios/parcelas/[id]/pagar": () => import("@/app/api/v1/honorarios/parcelas/[id]/pagar/route"),
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
async function comoToken(c: Caso, o: OpcoesDoToken = {}) {
  const org = o.org ?? ORG_A;
  const falso = criarClienteAdminFalso({
    orgDona: org,
    linhas: o.linhas ?? c.linhas,
    rpc: c.rpc,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  tokenValido({
    org,
    id: org === ORG_A ? TOKEN_A : TOKEN_B,
    papel: o.papel ?? c.papel,
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
async function comoSessao(c: Caso) {
  const falso = criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: c.linhas,
    rpc: c.rpc,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createClient).mockImplementation(async () => ({
    ...(sessaoComRls(falso.cliente, ORG_A) as object),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" } },
        error: null,
      }),
    },
  } as never));
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

function json<T>(texto: string): T {
  return JSON.parse(texto) as T;
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

// ─── Os seis testes de cada método convertido ───────────────────────────────

describe("financeiro e honorários aceitam token", () => {
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
      if (c.colecao) {
        expect(texto).toContain(c.colecao.daA);
        expect(texto).not.toContain(c.colecao.daB);
      }

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
      const { res, texto, falso } = await comoToken(c, { org: ORG_B });

      switch (c.paraB) {
        case "lista":
          expect(res.status, texto).toBe(200);
          expect(texto).toContain(c.colecao?.daB ?? "");
          if (c.colecao) expect(texto).not.toContain(c.colecao.daA);
          expect(audit).not.toHaveBeenCalled();
          break;
        case "lista_vazia": {
          expect(res.status, texto).toBe(200);
          // Lista (parcelas) ou o extrato dentro do objeto (fidelidade): vazio para B.
          const dados = json<{ data: unknown }>(texto).data;
          const lista = Array.isArray(dados) ? dados : (dados as { extrato?: unknown[] }).extrato;
          expect(lista).toEqual([]);
          if (c.colecao) expect(texto).not.toContain(c.colecao.daA);
          expect(audit).not.toHaveBeenCalled();
          break;
        }
        case "422":
          expect(res.status, texto).toBe(422);
          expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
          expect(audit).not.toHaveBeenCalled();
          break;
        case "cria": {
          expect(res.status, texto).toBe(c.status);
          expect(texto).not.toContain(c.colecao?.daA ?? CONTRATO_A);
          const tabela = c.tabelaCriada ?? "";
          const criadas = linhasDaTabela(falso, tabela).filter(
            (l) => !(c.linhas[tabela] ?? []).some((antiga) => antiga.id === l.id),
          );
          expect(criadas).toHaveLength(1);
          expect(criadas[0]?.organization_id).toBe(ORG_B);
          expect(audit).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: ORG_B, actorApiTokenId: TOKEN_B }),
          );
          expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }));
          break;
        }
        default:
          expect(res.status, texto).toBe(404);
          expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
          expect(audit).not.toHaveBeenCalled();
      }

      expect(
        cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO }),
      ).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
      expect(daOrganizacao(falso.linhas, ORG_A, tabelas)).toEqual(daOrganizacao(c.linhas, ORG_A, tabelas));
    });

    it(`${n}: token sem o escopo é recusado`, async () => {
      const outro = c.escopo === "mcp:read" ? "mcp:write" : "mcp:read";
      const { res, texto, falso } = await comoToken(c, { escopos: [outro] });

      expect(res.status, texto).toBe(403);
      // Leitura da flag de módulo (SEM_ORGANIZACAO) acontece antes da autenticação; não é dado.
      expect(falso.cadeias.filter((ch) => !SEM_ORGANIZACAO.includes(ch.tabela))).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    if (c.papel !== "viewer") {
      it(`${n}: token abaixo do papel é recusado`, async () => {
        const { res, texto, falso } = await comoToken(c, { papel: DEGRAU_ABAIXO[c.papel] });

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
      const recurso = c.recursoDoTeto ?? c.recurso;
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${recurso}:tok:${TOKEN_A}`);
      expect(vi.mocked(checkRateLimit).mock.calls[1]?.[0]).toBe(`${recurso}:org:${ORG_A}`);
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

// ─── O que segue só de sessão: o token é recusado, nada é gravado ───────────

describe("o que segue só de sessão em financeiro e honorários", () => {
  for (const c of SO_SESSAO) {
    it(`${nome(c)}: token sem cookie é recusado com 401 e não grava`, async () => {
      const falso = criarClienteAdminFalso({
        orgDona: ORG_A,
        linhas: c.linhas,
        tabelasSemOrganizacao: SEM_ORGANIZACAO,
      });
      vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
      // O portão de sessão, sem cookie, responde 401: é o que `requireRole` faz.
      vi.mocked(requireRole).mockResolvedValue({
        ok: false,
        response: new Response(null, { status: 401 }),
      } as never);
      tokenValido({ org: ORG_A, id: TOKEN_A, papel: "admin", escopos: ["mcp:read", "mcp:write"] });

      const res = await chamar(c, requisicao(c, AUTORIZACAO));

      expect(res.status).toBe(401);
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
      // Onde a rota não lê o módulo antes do portão, o cliente de admin nem é criado.
      if (c.adminNaoChamado) expect(createAdminClient).not.toHaveBeenCalled();
    });
  }
});

// ─── Cancelar comanda segue só de sessão, também no PATCH ───────────────────

describe("cancelar comanda segue só de sessão", () => {
  it("token de A com {cancel:true} na própria comanda → 403, a comanda segue aberta e nada é escrito", async () => {
    const c: Caso = {
      rota: "financeiro/comandas/[id]",
      metodo: "PATCH",
      caminho: `/api/v1/financeiro/comandas/${SALE_A}`,
      params: { id: SALE_A },
      corpo: { cancel: true },
      linhas: { ...MODULOS, ...ORGS, sales: [VENDA_A, VENDA_B] },
      papel: "agent",
      escopo: "mcp:write",
      recurso: "financeiro",
      status: 403,
    };
    const { res, texto, falso } = await comoToken(c);

    expect(res.status, texto).toBe(403);
    expect(json<{ error: { code: string } }>(texto).error.code).toBe("forbidden");
    expect(texto).toContain("Cancelar a comanda é só pela sessão.");
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(linhasDaTabela(falso, "sales").find((l) => l.id === SALE_A)?.status).toBe("open");
    expect(audit).not.toHaveBeenCalled();
  });
});

// ─── PUBLIC_PATHS: as portas de financeiro e honorários ─────────────────────

describe("PUBLIC_PATHS — as portas de financeiro e honorários", () => {
  const UUID = "00000000-0000-4000-8000-000000000000";

  it.each([
    "/api/v1/financeiro/catalogo/contas",
    "/api/v1/financeiro/catalogo/formas_de_pagamento",
    "/api/v1/financeiro/catalogo/planos_de_conta",
    "/api/v1/financeiro/catalogo/regras_de_comissao",
    "/api/v1/financeiro/catalogo/recorrencias",
    "/api/v1/financeiro/comandas",
    "/api/v1/financeiro/comandas/pendentes",
    `/api/v1/financeiro/comandas/${UUID}`,
    `/api/v1/financeiro/comandas/${UUID}/itens`,
    `/api/v1/financeiro/comandas/${UUID}/itens/${UUID}`,
    "/api/v1/financeiro/fidelidade",
    "/api/v1/financeiro/lancamentos",
    `/api/v1/financeiro/lancamentos/${UUID}`,
    "/api/v1/honorarios/contratos",
    `/api/v1/honorarios/contratos/${UUID}/parcelas`,
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    // segmento que não é a classe de tipo do catálogo
    "/api/v1/financeiro/catalogo/abc",
    "/api/v1/financeiro/catalogo/contas/x",
    // id fora da forma de UUID e sub-paths
    "/api/v1/financeiro/comandas/abc",
    `/api/v1/financeiro/comandas/${UUID}/x`,
    // irmãos literais que seguem só de sessão: estornar, finalizar, faturar em lote
    `/api/v1/financeiro/comandas/${UUID}/estornar`,
    `/api/v1/financeiro/comandas/${UUID}/finalizar`,
    "/api/v1/financeiro/comandas/faturar-lote",
    `/api/v1/financeiro/comandas/${UUID}/itens/abc`,
    // lançamento por id aceita token (R2 lote 2), mas só com id em forma de UUID
    "/api/v1/financeiro/lancamentos/abc",
    `/api/v1/financeiro/lancamentos/${UUID}/x`,
    `/api/v1/financeiro/fidelidade/${UUID}`,
    // honorários: contrato por id, pagar e parcela de cobrança (fica de sessão)
    `/api/v1/honorarios/contratos/${UUID}`,
    `/api/v1/honorarios/contratos/${UUID}/parcelas/x`,
    `/api/v1/honorarios/parcelas/${UUID}/pagar`,
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});
