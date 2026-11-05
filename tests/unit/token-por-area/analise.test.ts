// @vitest-environment node
/**
 * TOKEN DE INTEGRAÇÃO POR ÁREA — ANÁLISE (Spec 33, fatia R3: os GET de métricas
 * e relatórios que ainda eram só de sessão).
 *
 * Rotas: `metrics/atrito` GET, `metrics/channels` GET, `metrics/funil` GET,
 * `metrics/metas` GET e `reports/activities` GET.
 *
 * No ramo do token, `resolveAuthDual` entrega `createAdminClient()`: a service
 * role, que contorna a RLS. O que protege a organização ali é o filtro
 * `.eq("organization_id", authz.organizationId)` (e o `p_org` das RPCs) que cada
 * rota escreve à mão. Métricas SOMAM a organização inteira: um filtro esquecido
 * não devolve 404, devolve um número maior com cara de certo. Por isso o
 * cenário tem linhas das DUAS organizações e a leitura de cada token é conferida
 * (A não pode virar A+B).
 *
 * Papel do token: `manager` em atrito, channels, funil, metas e activities (o
 * token lê a organização inteira, e na sessão um agent só vê o que é dele). A
 * sessão mantém o papel de hoje (agent; viewer em activities).
 *
 * A moeda da organização (funil, metas) não vem de `resolveAuthDual`: a rota lê
 * `organizations.currency` com o cliente de serviço e `.eq("id", organizationId)`.
 * O cenário põe uma moeda diferente em cada organização (BRL × USD) e os
 * negócios sem moeda própria caem na da organização do token.
 *
 * Testes por rota (tabela `CASOS`), mais o bloco de borda do proxy:
 *   1. token de A alcança o recurso de A (nenhuma linha de B);
 *   2. token de B, sem linhas de B no cenário, não vê nada de A;
 *   3. com as linhas das duas organizações, o token de B lê só as dele;
 *   4. token sem o escopo é recusado (403);
 *   5. token com papel um degrau abaixo é recusado (403);
 *   6. acima do teto do token → 429 com Retry-After, sem tocar o dado;
 *   7. a sessão continua pelo mesmo portão de antes.
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
import { ABANDONO_HORAS_DEFAULT } from "@/lib/metrics/atrito";
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

/** Nenhuma tabela lida por estas rotas deixa de ter `organization_id` (`organizations` usa `id`). */
const SEM_ORGANIZACAO = [] as const;

type Papel = "viewer" | "agent" | "manager" | "admin";
type Tabelas = Record<string, Record<string, unknown>[]>;
type Falso = ReturnType<typeof criarClienteAdminFalso>;
type Linha = Record<string, unknown>;

type Caso = {
  rota: string;
  caminho: string;
  executar: (req: NextRequest) => Promise<Response>;
  linhas: Tabelas;
  /** RPC → payload por organização (a função dublada devolve o da `p_org`). */
  rpc: Record<string, Record<string, unknown>>;
  /** o papel da sessão (o piso de hoje) */
  papelDaSessao: Papel;
  /** o papel exigido do TOKEN (`tokenRole` da rota, ou o da sessão) */
  papelDoToken: Papel;
  recurso: string;
  /** marcas que só a organização A pode ver na resposta (e que ela DEVE trazer) */
  soDeA: string[];
  soDeB: string[];
  /** marcas de A que não podem aparecer na resposta de B (sem exigir presença em A) */
  extrasDeA: string[];
  extrasDeB: string[];
  /** o que a resposta declara, para conferir que não somou a outra organização */
  leitura: (data: unknown) => unknown;
  valorA: unknown;
  valorB: unknown;
  valorVazio: unknown;
};

// ───────────────────────────── cenário ─────────────────────────────

const JANELA = "from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z";
const JANELA_DOS_DADOS = "2026-09-15T12:00:00.000Z";

type Dados = Record<string, unknown> | null;
const dados = (d: unknown): Dados => d as Dados;
const objeto = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;

// atrito -----------------------------------------------------------------

function atritoCru(demandas: number, turnosP50: number | null = null): Record<string, unknown> {
  return {
    cliente: {
      turnos_p50: turnosP50,
      turnos_p90: null,
      insistencia_media: null,
      insistencia_max: null,
      pedidos_de_humano: 0,
      descadastros: 0,
      abandonos: 0,
      conversas_com_fala_nossa: 0,
      reperguntas: 0,
      perguntas_com_resposta: 0,
      esperas_caladas: 0,
      esperas_medidas: 0,
      espera_resposta_p90_s: null,
      repeticao_pos_passagem: 0,
      passagens_medidas: 0,
    },
    empresa: {
      intervencoes_por_demanda: null,
      espera_humana_p50_s: null,
      espera_humana_p90_s: null,
      retrabalho: 0,
      vetos: 0,
      execucoes_medidas: 0,
      envios_por_ia: 0,
      envios_por_automacao: 0,
      envios_por_integracao: 0,
      envios_humano_no_sistema: 0,
      envios_humano_fora: 0,
      demandas_sem_proximo_passo: 0,
    },
    eficiencia: { ganhos: 0, perdidos: 0 },
    escopo: {
      demandas,
      de: "2026-09-01T00:00:00.000Z",
      ate: "2026-10-01T00:00:00.000Z",
      abandono_horas: ABANDONO_HORAS_DEFAULT,
      repeticao_min: 0.7,
      espera_horas: 4,
      demandas_com_caso: 0,
      demandas_abertas: 0,
      denominador: "demandas",
    },
  };
}

const LINHAS_DO_ATRITO: Tabelas = {
  organizations: [
    { id: ORG_A, settings: { atrito: { abandono_horas: 48 } } },
    { id: ORG_B, settings: { atrito: { abandono_horas: 96 } } },
  ],
};

// channels ---------------------------------------------------------------

function canal(nome: string, conversas: number): Linha {
  return {
    channel_session_id: `sessao-${nome}`,
    channel_name: nome,
    channel: "whatsapp",
    is_archived: false,
    conversations_handled: conversas,
    avg_first_response_seconds: 120,
    sem_resposta: 0,
  };
}

// funil ------------------------------------------------------------------

function negocio(id: string, org: string, origem: string, valor: number): Linha {
  return {
    id,
    organization_id: org,
    pipeline_id: org === ORG_A ? "f-a" : "f-b",
    stage_id: org === ORG_A ? "e-a" : "e-b",
    status: "won",
    source: origem,
    value_cents: valor,
    // sem moeda própria: vale a da organização (BRL em A, USD em B)
    currency: null,
    created_at: "2026-09-10T12:00:00.000Z",
    closed_at: JANELA_DOS_DADOS,
    recurring_value_cents: null,
    recurring_period: null,
  };
}

const MOEDAS: Tabelas = {
  organizations: [
    { id: ORG_A, currency: "BRL" },
    { id: ORG_B, currency: "USD" },
  ],
};

const LINHAS_DO_FUNIL: Tabelas = {
  ...MOEDAS,
  crm_lead_activities: [],
  crm_pipelines: [
    { id: "f-a", organization_id: ORG_A, name: "Funil-de-A", position: 1 },
    { id: "f-b", organization_id: ORG_B, name: "Funil-de-B", position: 1 },
  ],
  crm_stages: [
    { id: "e-a", organization_id: ORG_A, name: "Etapa-de-A", pipeline_id: "f-a", position: 1 },
    { id: "e-b", organization_id: ORG_B, name: "Etapa-de-B", pipeline_id: "f-b", position: 1 },
  ],
  crm_leads: [
    negocio("n1", ORG_A, "origem-de-A", 1000),
    negocio("n2", ORG_A, "origem-de-A", 1000),
    negocio("n3", ORG_B, "origem-de-B", 500),
    negocio("n4", ORG_B, "origem-de-B", 500),
    negocio("n5", ORG_B, "origem-de-B", 500),
  ],
};

// metas ------------------------------------------------------------------

const LINHAS_DAS_METAS: Tabelas = {
  ...MOEDAS,
  crm_pipelines: [
    { id: "f-a", organization_id: ORG_A, name: "Funil-de-A" },
    { id: "f-b", organization_id: ORG_B, name: "Funil-de-B" },
  ],
  crm_metas: [
    { id: "meta-de-A", organization_id: ORG_A, periodo: "2026-09-01", indicador: "vendas_ganhas", pipeline_id: null, alvo: 10 },
    { id: "meta-de-B", organization_id: ORG_B, periodo: "2026-09-01", indicador: "vendas_ganhas", pipeline_id: null, alvo: 20 },
  ],
  crm_leads: [
    negocio("m1", ORG_A, "origem-de-A", 1000),
    negocio("m2", ORG_A, "origem-de-A", 1000),
    negocio("m3", ORG_B, "origem-de-B", 500),
    negocio("m4", ORG_B, "origem-de-B", 500),
    negocio("m5", ORG_B, "origem-de-B", 500),
  ],
};

// activities -------------------------------------------------------------

function relatorioCru(total: number): Record<string, unknown> {
  return { total, by_actor: [], by_type: [], daily: [], items: [], items_truncated: false };
}

const LINHAS_DAS_ATIVIDADES: Tabelas = {
  crm_pipelines: [
    { id: "f-a", organization_id: ORG_A, is_default: true, vocabulary: null },
    { id: "f-b", organization_id: ORG_B, is_default: true, vocabulary: null },
  ],
};

const CASOS: Caso[] = [
  {
    rota: "app/api/v1/metrics/atrito/route.ts",
    caminho: `/api/v1/metrics/atrito?${JANELA}`,
    executar: async (req) => (await import("@/app/api/v1/metrics/atrito/route")).GET(req),
    linhas: LINHAS_DO_ATRITO,
    rpc: { fn_atrito_metrics: { [ORG_A]: atritoCru(2), [ORG_B]: atritoCru(5) } },
    papelDaSessao: "agent",
    papelDoToken: "manager",
    recurso: "metrics",
    soDeA: [],
    soDeB: [],
    extrasDeA: [],
    extrasDeB: [],
    // demandas medidas pela RPC + a régua lida da linha da organização do token
    leitura: (d) => [objeto(dados(d)?.escopo).demandas, objeto(dados(d)?.regua).abandono_horas],
    valorA: [2, 48],
    valorB: [5, 96],
    valorVazio: [0, ABANDONO_HORAS_DEFAULT],
  },
  {
    rota: "app/api/v1/metrics/channels/route.ts",
    caminho: `/api/v1/metrics/channels?${JANELA}`,
    executar: async (req) => (await import("@/app/api/v1/metrics/channels/route")).GET(req),
    linhas: {},
    rpc: {
      fn_channel_metrics: {
        [ORG_A]: { channels: [canal("Canal-de-A", 2)] },
        [ORG_B]: { channels: [canal("Canal-de-B", 7)] },
      },
    },
    papelDaSessao: "agent",
    papelDoToken: "manager",
    recurso: "metrics",
    soDeA: ["Canal-de-A"],
    soDeB: ["Canal-de-B"],
    extrasDeA: [],
    extrasDeB: [],
    leitura: (d) =>
      (dados(d)?.channels as Array<{ conversations_handled: number }>).map((c) => c.conversations_handled),
    valorA: [2],
    valorB: [7],
    valorVazio: [],
  },
  {
    rota: "app/api/v1/metrics/funil/route.ts",
    caminho: `/api/v1/metrics/funil?${JANELA}`,
    executar: async (req) => (await import("@/app/api/v1/metrics/funil/route")).GET(req),
    linhas: LINHAS_DO_FUNIL,
    rpc: {
      fn_atrito_metrics: {
        [ORG_A]: { cliente: { turnos_p50: 3, turnos_p90: 4, descadastros: 1 } },
        [ORG_B]: { cliente: { turnos_p50: 8, turnos_p90: 9, descadastros: 2 } },
      },
    },
    papelDaSessao: "agent",
    papelDoToken: "manager",
    recurso: "metrics",
    soDeA: [],
    soDeB: [],
    extrasDeA: ["Funil-de-A", "Etapa-de-A", "origem-de-A"],
    extrasDeB: ["Funil-de-B", "Etapa-de-B", "origem-de-B"],
    // negócios ganhos e vendido na janela, a moeda DA ORGANIZAÇÃO do token e a
    // contra-métrica (vinda da RPC da mesma organização)
    leitura: (d) => {
      const valores = objeto(dados(d)?.valores_do_periodo);
      const turnos = objeto(objeto(dados(d)?.contra_metrica).turnos);
      return {
        moeda: valores.moeda,
        negocios: objeto(valores.unico).negocios,
        centavos: objeto(valores.unico).centavos,
        turnos_p50: turnos.p50 ?? null,
      };
    },
    valorA: { moeda: "BRL", negocios: 2, centavos: 2000, turnos_p50: 3 },
    valorB: { moeda: "USD", negocios: 3, centavos: 1500, turnos_p50: 8 },
    valorVazio: { moeda: null, negocios: 0, centavos: 0, turnos_p50: null },
  },
  {
    rota: "app/api/v1/metrics/metas/route.ts",
    caminho: `/api/v1/metrics/metas?${JANELA}`,
    executar: async (req) => (await import("@/app/api/v1/metrics/metas/route")).GET(req),
    linhas: LINHAS_DAS_METAS,
    rpc: {},
    papelDaSessao: "agent",
    // o realizado sai de `crm_leads`, que a RLS recorta por atendente na sessão;
    // o token lê a organização inteira, então exige manager (token agent → 403)
    papelDoToken: "manager",
    recurso: "metrics",
    soDeA: ["meta-de-A"],
    soDeB: ["meta-de-B"],
    extrasDeA: [],
    extrasDeB: [],
    leitura: (d) => {
      const metas = (dados(d)?.metas ?? []) as Array<{ realizado: number; alvo: number }>;
      return {
        realizado: metas.map((m) => m.realizado),
        alvo: metas.map((m) => m.alvo),
        moeda: objeto(dados(d)?.valores_do_periodo).moeda,
      };
    },
    valorA: { realizado: [2], alvo: [10], moeda: "BRL" },
    valorB: { realizado: [3], alvo: [20], moeda: "USD" },
    valorVazio: { realizado: [], alvo: [], moeda: null },
  },
  {
    rota: "app/api/v1/reports/activities/route.ts",
    caminho: "/api/v1/reports/activities?days=7&tz=UTC",
    executar: async (req) => (await import("@/app/api/v1/reports/activities/route")).GET(req),
    linhas: LINHAS_DAS_ATIVIDADES,
    rpc: { fn_activity_report: { [ORG_A]: relatorioCru(4), [ORG_B]: relatorioCru(9) } },
    papelDaSessao: "viewer",
    papelDoToken: "manager",
    recurso: "reports",
    soDeA: [],
    soDeB: [],
    extrasDeA: [],
    extrasDeB: [],
    leitura: (d) => dados(d)?.total,
    valorA: 4,
    valorB: 9,
    valorVazio: 0,
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
    Object.entries(c.rpc).map(([nome, porOrg]) => [
      nome,
      (args: Record<string, unknown>) => ({
        data: orgs.includes(String(args.p_org)) ? (porOrg[String(args.p_org)] ?? null) : null,
      }),
    ]),
  );
}

function falsoDe(org: string, linhas: Tabelas, c: Caso, orgs: string[]): Falso {
  return criarClienteAdminFalso({
    orgDona: org,
    linhas,
    rpc: rpcDe(c, orgs),
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
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
  return new NextRequest(`http://localhost${c.caminho}`, { method: "GET", headers });
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
  const rotulo = `GET ${c.caminho.split("?")[0]}`;
  const nomesDeRpc = Object.keys(c.rpc);

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
    // Leitura não grava nada.
    expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
  }

  describe(`token por área — ${rotulo}`, () => {
    it(`${rotulo}: token de A alcança o recurso de A`, async () => {
      const f = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: ["mcp:read"], role: c.papelDoToken });

      const res = await c.executar(requisicao(c, comToken("A")));
      const { texto, data } = await ler(res);

      expect(res.status).toBe(200);
      for (const marca of c.soDeA) expect(texto).toContain(marca);
      for (const marca of [...c.soDeB, ...c.extrasDeB]) expect(texto).not.toContain(marca);
      expect(c.leitura(data)).toEqual(c.valorA);

      confereDentroDe(f, ORG_A);
      expect(linhasMudadas(c.linhas, f.linhas)).toEqual([]);
      expect(requireRole).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${rotulo}: token de B não alcança o recurso de A`, async () => {
      // As linhas de B saem do cenário: o recurso de A existe, e B não tem nada.
      const entrada = semLinhasDe(ORG_B, c.linhas);
      const f = falsoDe(ORG_B, entrada, c, [ORG_A]);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: ["mcp:read"], role: c.papelDoToken });

      const res = await c.executar(requisicao(c, comToken("B")));
      const { texto, data } = await ler(res);

      // Agregado de organização sem dado não é recurso inexistente: 200 vazio.
      expect(res.status).toBe(200);
      for (const marca of [...c.soDeA, ...c.extrasDeA]) expect(texto).not.toContain(marca);
      expect(c.leitura(data)).toEqual(c.valorVazio);

      confereDentroDe(f, ORG_B);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${rotulo}: com as linhas das duas organizações, o token de B lê só as dele`, async () => {
      const f = falsoDe(ORG_B, c.linhas, c, [ORG_A, ORG_B]);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: ["mcp:read"], role: c.papelDoToken });

      const res = await c.executar(requisicao(c, comToken("B")));
      const { texto, data } = await ler(res);

      expect(res.status).toBe(200);
      for (const marca of c.soDeB) expect(texto).toContain(marca);
      for (const marca of [...c.soDeA, ...c.extrasDeA]) expect(texto).not.toContain(marca);
      expect(c.leitura(data)).toEqual(c.valorB);

      confereDentroDe(f, ORG_B);
      expect(linhasMudadas(c.linhas, f.linhas)).toEqual([]);
    });

    it(`${rotulo}: token sem o escopo da operação é recusado`, async () => {
      const f = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      // O escopo da OUTRA operação: `mcp:write` não dá leitura.
      emitirTokens({ scopes: ["mcp:write"], role: c.papelDoToken });

      const res = await c.executar(requisicao(c, comToken("A")));

      expect(res.status).toBe(403);
      nadaTocado(f);
      expect(audit).not.toHaveBeenCalled();
    });

    const abaixo = umDegrauAbaixo(c.papelDoToken);
    if (abaixo) {
      it(`${rotulo}: token abaixo do papel é recusado`, async () => {
        const f = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
        vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
        emitirTokens({ scopes: ["mcp:read"], role: abaixo });

        const res = await c.executar(requisicao(c, comToken("A")));

        expect(res.status).toBe(403);
        nadaTocado(f);
      });
    }

    it(`${rotulo}: acima do teto do token → 429`, async () => {
      const f = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: ["mcp:read"], role: c.papelDoToken });
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

      const res = await c.executar(requisicao(c, comToken("A")));

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${c.recurso}:tok:${TOKEN_A}`);
      // O teto vem antes de tocar o banco.
      nadaTocado(f);
    });

    it(`${rotulo}: sem Authorization continua pela sessão`, async () => {
      // O portão é o de sempre, com o papel da sessão.
      const instalacao = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
      const sessao = falsoDe(ORG_A, c.linhas, c, [ORG_A, ORG_B]);
      vi.mocked(createAdminClient).mockReturnValue(instalacao.cliente as never);
      vi.mocked(createClient).mockResolvedValue(sessao.cliente as never);
      vi.mocked(requireRole).mockResolvedValue({
        ok: true,
        user: { id: USUARIO, idioma: "pt-BR" },
        org: { orgId: ORG_A, name: "Org", role: c.papelDaSessao, currency: "BRL" },
      } as never);

      const res = await c.executar(requisicao(c, {}));
      const { texto, data } = await ler(res);

      expect(res.status).toBe(200);
      expect(requireRole).toHaveBeenCalledWith(c.papelDaSessao, expect.objectContaining({ resource: c.recurso }));
      for (const marca of c.soDeA) expect(texto).toContain(marca);
      for (const marca of [...c.soDeB, ...c.extrasDeB]) expect(texto).not.toContain(marca);
      expect(c.leitura(data)).toEqual(c.valorA);
      expect(validateBearerToken).not.toHaveBeenCalled();
      // A sessão não tem teto: o contador nem é tocado.
      expect(checkRateLimit).not.toHaveBeenCalled();
      // A leitura de dado passou pelo cliente da SESSÃO (RLS), dentro de A.
      expect(sessao.cadeias.length + sessao.rpcs.length).toBeGreaterThan(0);
      expect(cadeiasForaDaOrganizacao(sessao.cadeias, ORG_A)).toEqual([]);
      expect(rpcsForaDaOrganizacao(sessao.rpcs, ORG_A)).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });
  });
}

// ───────────────────────────── a borda do proxy ─────────────────────────────

/**
 * O `proxy.ts` roda ANTES de qualquer route handler e só reconhece cookie. Sem
 * a porta em `PUBLIC_PATHS` o Bearer nem chega à rota. A porta é estreita:
 * `$` no fim e nenhum irmão literal de carona. Nenhuma das cinco rotas tem
 * segmento dinâmico.
 */
describe("PUBLIC_PATHS — as portas de análise (borda do proxy)", () => {
  const PORTAS = [
    "/api/v1/metrics/atrito",
    "/api/v1/metrics/channels",
    "/api/v1/metrics/funil",
    "/api/v1/metrics/metas",
    "/api/v1/reports/activities",
  ];

  it.each(PORTAS)("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    // sub-path de cada porta
    ...PORTAS.map((p) => `${p}/x`),
    ...PORTAS.map((p) => `${p}/00000000-0000-4000-8000-000000000000`),
    // irmãos literais que NÃO são rota convertida
    "/api/v1/metrics/nao-existe",
    "/api/v1/reports/nao-existe",
    "/api/v1/reports/tags/x",
    "/api/v1/audit/export",
    // os pais
    "/api/v1/metrics",
    "/api/v1/reports",
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });

  it("as cinco portas estão nos modelos de leitura", () => {
    const caminhos = MODELOS_DE_PORTA.map(caminhoDoModelo);
    for (const modelo of PORTAS) expect(caminhos).toContain(modelo);
  });
});
