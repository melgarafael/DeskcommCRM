// @vitest-environment node
/**
 * Token de integração nas rotas de `ai (demais)` (Spec 33, fatia R1).
 *
 * 17 métodos de 13 rotas aceitam token (`config:read` na leitura, `config:write`
 * na escrita, papel admin via `tokenRole`). Cada método é exercitado com um CORPO
 * VÁLIDO pelo Zod da rota e um banco falso com linhas das DUAS organizações. Para
 * cada um, este arquivo prova:
 *  - token de A recebe 200 exato, não toca linha nem RPC de outra organização e,
 *    quando a rota grava, a escrita leva a organização A;
 *  - o audit de uma escrita sai com ator de token (`actorUserId` nulo) e
 *    `actorApiTokenId` preenchido;
 *  - token de B não lê nem grava fora de B e não devolve marca de A;
 *  - token sem o escopo da operação é recusado (403);
 *  - token abaixo do papel (manager < admin do tokenRole) é recusado (403);
 *  - acima do teto do token → 429 com Retry-After, sem nenhuma cadeia de banco;
 *  - sessão (sem Authorization) continua pelo `requireRole` com o papel da tabela.
 *
 * Por fora da matriz, cada caso que depende de um filtro que o banco falso não
 * mede tem a sua asserção própria: a organização que chega ao orçamento, à RPC
 * de uso, ao funil da evolução, ao agente pedido em `operator-metrics` e à chave
 * de mapas de A (com e sem `api_key` no corpo).
 *
 * Os 4 métodos que FICAM DE FORA (só sessão) recusam o token com 401 e não
 * chegam ao `createAdminClient`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { PORTAS_DE_TOKEN } from "@/lib/auth/portas-de-token";
import type { Role } from "@/lib/auth/types";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { getBudgetStatus } from "@/lib/ai/budget/check";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateBearerToken } from "@/lib/mcp/auth";
import { testarChaveDeMapas } from "@/lib/mapas/credencial";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import {
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

const { CHAVE_A } = vi.hoisted(() => ({ CHAVE_A: "AIzaSyCHAVE_DA_ORG_A_0000000000" }));

vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-role")>()),
  requireRole: vi.fn(),
  orgAtivaDaApi: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  mfaEmDivida: vi.fn(),
  mfaEmDividaEstrita: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
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
vi.mock("@/lib/ai/budget/check", () => ({ getBudgetStatus: vi.fn() }));
// A chave gravada de A é "cifra-A"; o decifrado é a chave de teste. Sem isto, o
// caso "mapas/testar sem corpo" não tem como provar que leu a chave de A.
vi.mock("@/lib/webhooks/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhooks/secrets")>()),
  encryptWebhookSecret: vi.fn(),
  decryptWebhookSecret: vi.fn(),
}));
// A geocodificação é rede externa. O teste afirma COM QUAL chave e para QUAL
// organização a rota chamou; o que o Google responderia não muda essa pergunta.
vi.mock("@/lib/mapas/credencial", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mapas/credencial")>()),
  testarChaveDeMapas: vi.fn(),
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const ESCOPOS_DE_CONFIG = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";

/** Marcas que só existem nas linhas de A: se aparecem na resposta de B, há vazamento. */
const MARCA_A = "MARCA-DA-ORG-A-3f1c";
const MARCA_B = "MARCA-DA-ORG-B-9d2e";
const AGENTE_A = "aaaaaaaa-aaaa-4aaa-8aaa-00000000000a";
const AGENTE_B = "bbbbbbbb-bbbb-4bbb-8bbb-00000000000b";
const PIPE_A = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000p1";
const PIPE_B = "bbbbbbbb-bbbb-4bbb-8bbb-0000000000p2";
/** Chave de mapas válida pelo Zod (`chaveDeMapasSchema`), usada no corpo do PUT. */
const CHAVE_NOVA = "AIzaSyTESTE_chave-de-mapas-0123456789";

type Metodo = "GET" | "PUT" | "PATCH" | "POST" | "DELETE";
type Escopo = "config:read" | "config:write";
type Manipulador = (req: NextRequest) => Promise<Response>;
type Linha = Record<string, unknown>;

type Caso = {
  caminho: string;
  metodo: Metodo;
  /** Papel da tabela do plano (o que a sessão exige hoje). */
  papel: Role;
  /** Escopo da operação: leitura ou escrita. */
  escopo: Escopo;
  rota: () => Promise<unknown>;
  /** Query string sem `?`. */
  query?: string;
  /** Corpo JSON VÁLIDO pelo Zod da rota. Ausente = a rota lê corpo vazio. */
  corpo?: unknown;
  /** Tabelas do banco falso que este caso substitui (ex.: mapas sem chave antes do PUT). */
  banco?: Record<string, Linha[]>;
  /** A rota grava: a escrita do token de A tem de levar a organização A. */
  escreve?: boolean;
  /** Ação de auditoria da escrita; o token de A deixa ator de token, sem usuário. */
  auditoria?: string;
  /** A rota não consulta o banco por conta própria (o orçamento vem de `getBudgetStatus`). */
  semConsultaDireta?: boolean;
};

const USO_VAZIO = {
  totais: {
    chamadas: 0,
    custo_cents: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    turnos: 0,
    custo_dos_turnos_cents: 0,
  },
  dias: [],
  purposes: [],
  inbounds: {},
  handoffs: {},
};

/** Linhas das DUAS organizações, em cada tabela que as rotas desta área leem ou gravam. */
function bancoComAsDuasOrganizacoes(): Record<string, Linha[]> {
  const agora = new Date().toISOString();
  return {
    ai_agents: [
      { id: AGENTE_A, organization_id: ORG_A, name: MARCA_A, kind: "agent", is_active: true, paused_at: null, published_version_id: "v-a", archived_at: null },
      { id: AGENTE_B, organization_id: ORG_B, name: MARCA_B, kind: "agent", is_active: true, paused_at: null, published_version_id: "v-b", archived_at: null },
    ],
    channel_sessions: [
      { id: "sessao-a", organization_id: ORG_A, display_name: MARCA_A, provider: "waha", status: "WORKING", archived_at: null, created_at: agora },
      { id: "sessao-b", organization_id: ORG_B, display_name: MARCA_B, provider: "waha", status: "WORKING", archived_at: null, created_at: agora },
    ],
    channel_knobs: [],
    organizations: [
      { id: ORG_A, name: MARCA_A, timezone: "America/Sao_Paulo", locale: "pt-BR", settings: { voz: { voice_id: "voz-a" } } },
      { id: ORG_B, name: MARCA_B, timezone: "America/Sao_Paulo", locale: "pt-BR", settings: {} },
    ],
    ai_provider_credentials: [
      { id: "cred-a", organization_id: ORG_A, provider: "elevenlabs", is_active: true, label: MARCA_A, models_available: ["voz-a"], validated_at: agora, created_at: agora },
    ],
    ai_budgets: [
      { organization_id: ORG_A, monthly_limit_cents: 1000, alarm_threshold_pct: 80, enforcement_mode: "avisar", enforcement_effective_at: null },
    ],
    org_guardrail_layers: [{ organization_id: ORG_A, layer: "promessa_semantica", enabled: true }],
    map_provider_credentials: [
      { id: "mapa-a", organization_id: ORG_A, provider: "google_maps", api_key_last4: "0000", api_key_encrypted: "cifra-A", updated_at: agora },
    ],
    llm_calls: [
      { id: "llm-a", organization_id: ORG_A, purpose: MARCA_A, provider: "anthropic", model: MARCA_A, status: "ok", created_at: agora },
    ],
    agent_turn_traces: [
      { id: "trace-a", organization_id: ORG_A, model: MARCA_A, status: "completed", is_dry_run: false, created_at: agora },
    ],
    crm_pipelines: [
      { id: PIPE_A, organization_id: ORG_A, name: "Funil A" },
      { id: PIPE_B, organization_id: ORG_B, name: "Funil B" },
    ],
    crm_stages: [
      { id: "etapa-a", organization_id: ORG_A, pipeline_id: PIPE_A, agent_stage_hint: "qualificacao", is_archived: false },
      { id: "etapa-b", organization_id: ORG_B, pipeline_id: PIPE_B, agent_stage_hint: "qualificacao", is_archived: false },
    ],
  };
}

/** Métodos convertidos: 17 (13 rotas). Corpos válidos pelo Zod de cada rota. */
const CASOS: Caso[] = [
  { caminho: "/api/v1/ai/automatico-ativo", metodo: "GET", papel: "agent", escopo: "config:read", rota: () => import("@/app/api/v1/ai/automatico-ativo/route") },
  { caminho: "/api/v1/ai/budget", metodo: "GET", papel: "manager", escopo: "config:read", rota: () => import("@/app/api/v1/ai/budget/route"), semConsultaDireta: true },
  { caminho: "/api/v1/ai/budget", metodo: "PATCH", papel: "admin", escopo: "config:write", rota: () => import("@/app/api/v1/ai/budget/route"), corpo: { monthly_limit_cents: 5000 }, escreve: true, auditoria: "ai.budget_limit_changed" },
  { caminho: "/api/v1/ai/evolution", metodo: "GET", papel: "manager", escopo: "config:read", rota: () => import("@/app/api/v1/ai/evolution/route") },
  { caminho: "/api/v1/ai/guardrail-layers", metodo: "PUT", papel: "admin", escopo: "config:write", rota: () => import("@/app/api/v1/ai/guardrail-layers/route"), corpo: { layer: "promessa_semantica", enabled: false }, escreve: true, auditoria: "ai.guardrail_layer_changed" },
  { caminho: "/api/v1/ai/mapas", metodo: "GET", papel: "manager", escopo: "config:read", rota: () => import("@/app/api/v1/ai/mapas/route") },
  // Sem chave de A gravada antes do PUT: o upsert não pode achar duas linhas na leitura seguinte.
  { caminho: "/api/v1/ai/mapas", metodo: "PUT", papel: "admin", escopo: "config:write", rota: () => import("@/app/api/v1/ai/mapas/route"), corpo: { api_key: CHAVE_NOVA }, banco: { map_provider_credentials: [] }, escreve: true, auditoria: "ai.maps_credential_saved" },
  { caminho: "/api/v1/ai/mapas", metodo: "DELETE", papel: "admin", escopo: "config:write", rota: () => import("@/app/api/v1/ai/mapas/route"), escreve: true, auditoria: "ai.maps_credential_removed" },
  { caminho: "/api/v1/ai/mapas/testar", metodo: "POST", papel: "admin", escopo: "config:write", rota: () => import("@/app/api/v1/ai/mapas/testar/route") },
  { caminho: "/api/v1/ai/operator-metrics", metodo: "GET", papel: "manager", escopo: "config:read", rota: () => import("@/app/api/v1/ai/operator-metrics/route") },
  { caminho: "/api/v1/ai/pacing", metodo: "GET", papel: "agent", escopo: "config:read", rota: () => import("@/app/api/v1/ai/pacing/route") },
  { caminho: "/api/v1/ai/runs", metodo: "GET", papel: "manager", escopo: "config:read", rota: () => import("@/app/api/v1/ai/runs/route") },
  { caminho: "/api/v1/ai/style-adjustments", metodo: "PUT", papel: "admin", escopo: "config:write", rota: () => import("@/app/api/v1/ai/style-adjustments/route"), corpo: { ajuste: "sem_travessao_longo", enabled: true }, escreve: true, auditoria: "ai.style_adjustment_changed" },
  { caminho: "/api/v1/ai/turn-traces", metodo: "GET", papel: "manager", escopo: "config:read", rota: () => import("@/app/api/v1/ai/turn-traces/route") },
  { caminho: "/api/v1/ai/usage", metodo: "GET", papel: "manager", escopo: "config:read", rota: () => import("@/app/api/v1/ai/usage/route") },
  { caminho: "/api/v1/ai/voz", metodo: "GET", papel: "manager", escopo: "config:read", rota: () => import("@/app/api/v1/ai/voz/route") },
  { caminho: "/api/v1/ai/voz", metodo: "PATCH", papel: "admin", escopo: "config:write", rota: () => import("@/app/api/v1/ai/voz/route"), corpo: { voice_id: "voz-nova" }, escreve: true, auditoria: "ai.voz_settings_updated" },
];

/** Métodos que FICAM DE FORA (só sessão): o token recebe 401 e o cliente admin não é criado. */
const SO_DE_SESSAO: Caso[] = [
  { caminho: "/api/v1/ai/pacing", metodo: "PUT", papel: "manager", escopo: "config:write", rota: () => import("@/app/api/v1/ai/pacing/route") },
  { caminho: "/api/v1/ai/voz/preview", metodo: "POST", papel: "manager", escopo: "config:write", rota: () => import("@/app/api/v1/ai/voz/preview/route") },
  { caminho: "/api/v1/ai/jev", metodo: "GET", papel: "manager", escopo: "config:read", rota: () => import("@/app/api/v1/ai/jev/route") },
  { caminho: "/api/v1/ai/jev", metodo: "PATCH", papel: "admin", escopo: "config:write", rota: () => import("@/app/api/v1/ai/jev/route") },
];

/** O caso da matriz para um método e caminho; falha alto se a matriz mudou. */
function achar(caminho: string, metodo: Metodo): Caso {
  const caso = CASOS.find((c) => c.caminho === caminho && c.metodo === metodo);
  if (!caso) throw new Error(`caso ausente na matriz: ${metodo} ${caminho}`);
  return caso;
}

let falso: ReturnType<typeof criarClienteAdminFalso>;

function tokenDe(org: string, token: string, role: Role, scopes: string[]): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: token, role },
    apiTokenId: token,
    scopes,
  } as never);
}

function requisicao(caso: Caso, token?: string): NextRequest {
  const url = `http://localhost${caso.caminho}${caso.query ? `?${caso.query}` : ""}`;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (caso.corpo !== undefined) {
    headers["content-type"] = "application/json";
    return new NextRequest(url, { method: caso.metodo, headers, body: JSON.stringify(caso.corpo) });
  }
  return new NextRequest(url, { method: caso.metodo, headers });
}

/** Banco falso com as duas organizações; `sobrescreve` troca só as tabelas do caso. */
function prepararFalso(sobrescreve?: Record<string, Linha[]>): void {
  falso = criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: { ...bancoComAsDuasOrganizacoes(), ...sobrescreve },
    rpc: { fn_uso_de_ia: () => ({ data: USO_VAZIO }) },
  });
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
}

async function chamar(caso: Caso, token?: string): Promise<Response> {
  if (caso.banco) prepararFalso(caso.banco);
  const modulo = (await caso.rota()) as unknown as Record<string, Manipulador | undefined>;
  const handler = modulo[caso.metodo];
  if (!handler) throw new Error(`${caso.metodo} não exportado em ${caso.caminho}`);
  return handler(requisicao(caso, token));
}

function outroEscopo(escopo: Escopo): Escopo {
  return escopo === "config:read" ? "config:write" : "config:read";
}

beforeEach(() => {
  vi.resetAllMocks();
  prepararFalso();
  // Ramo do token: se a rota tocar o cliente de sessão ou o usuário da sessão, o teste quebra.
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(loadAuthUser).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(getBudgetStatus).mockResolvedValue({} as never);
  vi.mocked(testarChaveDeMapas).mockResolvedValue({ ok: false, motivo: "sem_resultado" } as never);
  vi.mocked(encryptWebhookSecret).mockImplementation(
    (async (_admin: unknown, texto: string) => `cifra-${texto}`) as never,
  );
  vi.mocked(decryptWebhookSecret).mockImplementation(
    (async (_admin: unknown, cifrada: string) => (cifrada === "cifra-A" ? CHAVE_A : null)) as never,
  );
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: new Response(null, { status: 401 }),
  } as never);
});

describe.each(CASOS)("$metodo $caminho", (caso) => {
  it("token de A recebe 200 exato, não toca outra organização e, se grava, grava em A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", ESCOPOS_DE_CONFIG);
    const resposta = await chamar(caso, TOKEN_A);
    expect(resposta.status, await resposta.clone().text()).toBe(200);
    expect(validateBearerToken).toHaveBeenCalled();
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    if (!caso.semConsultaDireta) {
      expect(falso.cadeias.length + falso.rpcs.length, "a rota não consultou o banco: o teste passaria em vazio").toBeGreaterThan(0);
    }
    if (caso.escreve) {
      expect(cadeiasDeEscrita(falso.cadeias).length, "a rota não gravou nada").toBeGreaterThan(0);
    }
  });

  it.runIf(caso.auditoria !== undefined)("a escrita de A audita com ator de token, sem usuário", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", ESCOPOS_DE_CONFIG);
    await chamar(caso, TOKEN_A);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: caso.auditoria,
        actorUserId: null,
        actorApiTokenId: TOKEN_A,
        organizationId: ORG_A,
      }),
    );
  });

  it("token de B não lê nem grava fora de B e não devolve marca de A", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin", ESCOPOS_DE_CONFIG);
    const resposta = await chamar(caso, TOKEN_B);
    const texto = await resposta.text();
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
    expect(texto).not.toContain(MARCA_A);
    expect(texto).not.toContain(CHAVE_A);
  });

  it("token sem o escopo da operação é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", [outroEscopo(caso.escopo)]);
    const resposta = await chamar(caso, TOKEN_A);
    expect(resposta.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
  });

  it("token abaixo do papel (manager < admin do tokenRole) é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager", ESCOPOS_DE_CONFIG);
    const resposta = await chamar(caso, TOKEN_A);
    expect(resposta.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
  });

  it("acima do teto do token → 429 com Retry-After, sem cadeia de banco", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    tokenDe(ORG_A, TOKEN_A, "admin", ESCOPOS_DE_CONFIG);
    const resposta = await chamar(caso, TOKEN_A);
    expect(resposta.status).toBe(429);
    expect(resposta.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
  });

  it("sessão (sem Authorization) continua no requireRole com o papel da tabela", async () => {
    const resposta = await chamar(caso);
    expect(resposta.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith(caso.papel, expect.objectContaining({ resource: expect.any(String) }));
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

describe.each(SO_DE_SESSAO)("$metodo $caminho: fica só de sessão", (caso) => {
  it("token recebe 401 do requireRole e o cliente admin nunca é criado", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", ESCOPOS_DE_CONFIG);
    const resposta = await chamar(caso, TOKEN_A);
    expect(resposta.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("o que o banco falso não mede: cada filtro afirmado com a organização do token", () => {
  it("orçamento: a leitura pergunta o status da organização do token", async () => {
    const budget = achar("/api/v1/ai/budget", "GET");
    tokenDe(ORG_A, TOKEN_A, "admin", ESCOPOS_DE_CONFIG);
    await chamar(budget, TOKEN_A);
    expect(getBudgetStatus).toHaveBeenLastCalledWith(ORG_A);
    tokenDe(ORG_B, TOKEN_B, "admin", ESCOPOS_DE_CONFIG);
    await chamar(budget, TOKEN_B);
    expect(getBudgetStatus).toHaveBeenLastCalledWith(ORG_B);
  });

  it("uso de IA: a RPC recebe p_org = organização do token", async () => {
    const uso = achar("/api/v1/ai/usage", "GET");
    tokenDe(ORG_A, TOKEN_A, "admin", ESCOPOS_DE_CONFIG);
    expect((await chamar(uso, TOKEN_A)).status).toBe(200);
    const chamada = falso.rpcs.find((r) => r.nome === "fn_uso_de_ia");
    expect(chamada?.args.p_org).toBe(ORG_A);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
  });

  it("evolução: o funil do token de A é o de A, e o de B não aparece", async () => {
    const evolucao = achar("/api/v1/ai/evolution", "GET");
    tokenDe(ORG_A, TOKEN_A, "admin", ESCOPOS_DE_CONFIG);
    const textoA = await (await chamar(evolucao, TOKEN_A)).text();
    expect(textoA).toContain("Funil A");
    expect(textoA).not.toContain("Funil B");
    tokenDe(ORG_B, TOKEN_B, "admin", ESCOPOS_DE_CONFIG);
    const textoB = await (await chamar(evolucao, TOKEN_B)).text();
    expect(textoB).toContain("Funil B");
    expect(textoB).not.toContain("Funil A");
  });

  it("operator-metrics: agente de A pedido com token de B é 404, sem leitura de turno", async () => {
    const metricas = { ...achar("/api/v1/ai/operator-metrics", "GET"), query: `agent_id=${AGENTE_A}` };
    tokenDe(ORG_B, TOKEN_B, "admin", ESCOPOS_DE_CONFIG);
    const resposta = await chamar(metricas, TOKEN_B);
    expect(resposta.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
  });

  it("operator-metrics: agente de A pedido com token de A é 200", async () => {
    const metricas = { ...achar("/api/v1/ai/operator-metrics", "GET"), query: `agent_id=${AGENTE_A}` };
    tokenDe(ORG_A, TOKEN_A, "admin", ESCOPOS_DE_CONFIG);
    expect((await chamar(metricas, TOKEN_A)).status).toBe(200);
  });

  it("mapas/testar sem corpo: testa a chave GRAVADA de A, lida pela organização do token", async () => {
    const testar = achar("/api/v1/ai/mapas/testar", "POST");
    tokenDe(ORG_A, TOKEN_A, "admin", ESCOPOS_DE_CONFIG);
    expect((await chamar(testar, TOKEN_A)).status).toBe(200);
    expect(testarChaveDeMapas).toHaveBeenCalledWith(expect.anything(), ORG_A, CHAVE_A, expect.anything());
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("mapas/testar sem corpo com token de B: não acha chave de A, responde 422 e não testa nada", async () => {
    const testar = achar("/api/v1/ai/mapas/testar", "POST");
    tokenDe(ORG_B, TOKEN_B, "admin", ESCOPOS_DE_CONFIG);
    const resposta = await chamar(testar, TOKEN_B);
    expect(resposta.status).toBe(422);
    expect(testarChaveDeMapas).not.toHaveBeenCalled();
    expect(await resposta.text()).not.toContain(CHAVE_A);
  });

  it("mapas/testar com api_key no corpo: testa ESSA chave para A e não lê a gravada", async () => {
    const testar = { ...achar("/api/v1/ai/mapas/testar", "POST"), corpo: { api_key: CHAVE_NOVA } };
    tokenDe(ORG_A, TOKEN_A, "admin", ESCOPOS_DE_CONFIG);
    expect((await chamar(testar, TOKEN_A)).status).toBe(200);
    expect(testarChaveDeMapas).toHaveBeenCalledWith(expect.anything(), ORG_A, CHAVE_NOVA, expect.anything());
    expect(falso.cadeias.filter((c) => c.tabela === "map_provider_credentials")).toEqual([]);
  });

  it("mapas GET com token de B: a chave de A não aparece como configurada", async () => {
    const estado = achar("/api/v1/ai/mapas", "GET");
    tokenDe(ORG_B, TOKEN_B, "admin", ESCOPOS_DE_CONFIG);
    const corpo = (await (await chamar(estado, TOKEN_B)).json()) as { data: { configurada: boolean } };
    expect(corpo.data.configurada).toBe(false);
  });
});

describe("bloco de borda das portas (ai demais)", () => {
  const tem = (caminho: string) => PORTAS_DE_TOKEN.some((porta) => porta.test(caminho));

  it.each([
    "/api/v1/ai/automatico-ativo",
    "/api/v1/ai/budget",
    "/api/v1/ai/evolution",
    "/api/v1/ai/guardrail-layers",
    "/api/v1/ai/mapas",
    "/api/v1/ai/mapas/testar",
    "/api/v1/ai/operator-metrics",
    "/api/v1/ai/pacing",
    "/api/v1/ai/runs",
    "/api/v1/ai/style-adjustments",
    "/api/v1/ai/turn-traces",
    "/api/v1/ai/usage",
    "/api/v1/ai/voz",
  ])("%s tem porta", (caminho) => {
    expect(tem(caminho)).toBe(true);
  });

  it.each([
    "/api/v1/ai/jev",
    "/api/v1/ai/voz/preview",
    "/api/v1/ai/voz/x",
    "/api/v1/ai/mapas/x",
    "/api/v1/ai/usage/x",
    "/api/v1/ai/budget/x",
  ])("%s não ganhou porta (irmão ou sub-caminho)", (caminho) => {
    expect(tem(caminho)).toBe(false);
  });
});
