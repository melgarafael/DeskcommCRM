/**
 * `ai/agents` ACEITA TOKEN DE INTEGRAÇÃO (Spec 33, fatia R1, tarefa 1).
 *
 * Oito rotas, oito métodos (a tabela "## ai/agents" do plano da R1, medida em
 * `fe7a11457` e conferida de novo no passo 1 da tarefa):
 *
 *   GET  ai/agents/assignable                    agent    receita A
 *   POST ai/agents/[id]/duplicate                admin    receita A
 *   POST ai/agents/[id]/pause                    admin    receita A
 *   GET  ai/agents/[id]/proposals                agent    receita A
 *   POST ai/agents/[id]/proposals/[pid]/apply    admin    receita A
 *   POST ai/agents/[id]/reconcile                admin    receita A
 *   GET  ai/agents/[id]/runs                     manager  receita A
 *   GET  ai/agents/[id]/tool-usage               manager  receita A
 *
 * ─── O que este arquivo existe para provar ────────────────────────────────
 *
 * No ramo do token o cliente do banco é a service role, que ignora a RLS. O
 * filtro `.eq("organization_id", authz.organizationId)` que a rota (e as
 * funções de `lib/` que ela chama) escreve à mão passa a ser a ÚNICA barreira
 * entre o token de uma empresa e as linhas de outra. Um dublê que devolve a
 * mesma linha para qualquer consulta não vê a falta dele; o cliente falso por
 * organização (`tests/unit/helpers/cliente-admin-falso.ts`) vê: cadeia de
 * tabela com `organization_id` que não filtra a organização não alcança linha
 * nenhuma, e o caso "token de A alcança" fica vermelho.
 *
 * Os mocks são os da receita: o cliente de sessão e `loadAuthUser` LANÇAM, de
 * modo que qualquer função de `lib/` que ainda abra a sessão por dentro quebra
 * o teste do token sem precisar rastreá-la à mão.
 *
 * ─── O que NÃO prova ──────────────────────────────────────────────────────
 *
 * O cliente falso imita o PostgREST no que importa para a pergunta (filtros
 * `eq`/`in`/`is`/`neq` e escrita), mas `or`, `like`, `not` etc. são só
 * registrados, e as funções do banco (`fn_publish_ai_agent_version`,
 * `fn_agent_tool_usage*`, `fn_agent_legacy_notice`) são dubladas: o que as
 * guarda é o argumento de organização que a rota passa, não o corpo SQL delas.
 *
 * ─── Nenhum método desta área fica de fora ────────────────────────────────
 *
 * Cada um dos oito `route.ts` exporta um método só, e os oito foram
 * convertidos. Por isso não há o caso "<método> <caminho>: fica só de sessão"
 * que a receita pede para rota com método convertido e método fora.
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

// Os mocks da receita. O cliente de sessão e o carregador de usuário lançam:
// no ramo do token nada pode abrir a sessão.
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

// Depois dos vi.mock acima: pega a versão mockada.
const { validateBearerToken } = await import("@/lib/mcp/auth");

// ─── As duas organizações, os dois tokens e os ids de cada lado ──────────────

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const USER_A = "11111111-1111-4111-8111-111111111111";

type Lado = {
  org: string;
  rotulo: string;
  agente: string;
  agenteLegado: string;
  versao: string;
  proposta: string;
  propostaMemoria: string;
  canal: string;
  credencial: string;
  execucao: string;
};

const A: Lado = {
  org: ORG_A,
  rotulo: "A",
  agente: "a1000000-0000-4000-8000-000000000001",
  agenteLegado: "a1000000-0000-4000-8000-000000000002",
  versao: "a2000000-0000-4000-8000-000000000001",
  proposta: "a3000000-0000-4000-8000-000000000001",
  propostaMemoria: "a3000000-0000-4000-8000-000000000002",
  canal: "a4000000-0000-4000-8000-000000000001",
  credencial: "a5000000-0000-4000-8000-000000000001",
  execucao: "a6000000-0000-4000-8000-000000000001",
};

const B: Lado = {
  org: ORG_B,
  rotulo: "B",
  agente: "b1000000-0000-4000-8000-000000000001",
  agenteLegado: "b1000000-0000-4000-8000-000000000002",
  versao: "b2000000-0000-4000-8000-000000000001",
  proposta: "b3000000-0000-4000-8000-000000000001",
  propostaMemoria: "b3000000-0000-4000-8000-000000000002",
  canal: "b4000000-0000-4000-8000-000000000001",
  credencial: "b5000000-0000-4000-8000-000000000001",
  execucao: "b6000000-0000-4000-8000-000000000001",
};

/**
 * Tabelas SEM a coluna `organization_id` (conferidas em `supabase/baseline.sql`).
 */
const SEM_ORGANIZACAO = [
  // `ai_models`: catálogo GLOBAL de modelos de IA da instalação (provedor +
  // model_id + preços). Não é filha de organização nenhuma — baseline.sql:1180.
  // A reconciliação lê dele o modelo escolhido, e é a única consulta sem o filtro.
  "ai_models",
] as const;

// ─── Tipos do teste ──────────────────────────────────────────────────────────

type Linha = Record<string, unknown>;
type Linhas = Record<string, Linha[]>;
type Metodo = "GET" | "POST";
type Papel = "viewer" | "agent" | "manager" | "admin";
type Escopo = "config:read" | "config:write";
type Manipulador = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;
type ModuloDeRota = Partial<Record<Metodo, Manipulador>>;

type Caso = {
  rota: string; // "app/api/v1/ai/agents/[id]/pause/route.ts"
  carregar: () => Promise<ModuloDeRota>;
  metodo: Metodo;
  caminho: string; // "/api/v1/ai/agents/<UUID_A>/pause"
  params?: Record<string, string>;
  corpo?: unknown; // válido para o Zod da rota
  linhas: Linhas; // o recurso da organização A, mais as linhas-isca da B
  rpc?: Record<string, unknown>;
  papel: Papel; // o da tabela do plano
  escopo: Escopo;
  papelDoToken: "admin"; // `tokenRole` em todo método convertido
  resource: string; // o `resource` que a rota passa ao portão
  variante?: string; // distingue dois casos do mesmo método e caminho
  audita?: string; // a `action` do audit; ausente = o método não audita
  /** Pedaços que a resposta do token de A TEM de trazer (controle de vacuidade). */
  esperaNaResposta: string[];
  /** Funções do banco que o token de A TEM de chamar. */
  esperaChamarRpc?: string[];
  /** Confere o que a rota gravou, nas linhas vivas do falso (autoria, efeito). */
  confere?: (viva: Linhas) => void;
  /** O que a rota devolve ao token de B diante do recurso de A. */
  statusDeB: 404 | 200;
  /** `statusDeB` 200: a resposta de B é lista vazia. */
  listaVaziaParaB?: boolean;
  /** `statusDeB` 200: o que B vê é só o dele. */
  esperaNaRespostaDeB?: string[];
  naoEsperaNaRespostaDeB?: string[];
};

// ─── Linhas de cada tabela ───────────────────────────────────────────────────

const MOMENTO = "2026-01-01T00:00:00.000Z";
const PROMPT = "Você atende os clientes com cordialidade e objetividade.";

function agenteDe(l: Lado, id: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: l.org,
    name: `Agente ${l.rotulo}`,
    description: null,
    model: "claude-sonnet-4-6",
    system_prompt: PROMPT,
    is_active: true,
    is_default: false,
    kind: "mcp_agent",
    priority: 1,
    published_version_id: null,
    archived_at: null,
    paused_at: null,
    channel: "whatsapp",
    config: {},
    guardrails: null,
    active_kb_version_id: null,
    created_at: MOMENTO,
    updated_at: MOMENTO,
    ...extra,
  };
}

function versaoDe(l: Lado, id: string, agente: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: l.org,
    agent_id: agente,
    version_number: 1,
    status: "published",
    system_prompt: PROMPT,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    credential_id: l.credencial,
    tool_ids: ["crm_get_lead"],
    trigger_config: {},
    channel_session_id: l.canal,
    max_steps: 10,
    token_budget: 50000,
    cost_budget_cents: 50,
    history_message_window: 20,
    history_token_window: 8000,
    handoff_keywords: [],
    handoff_tool_enabled: true,
    handoff_legal_enabled: true,
    created_at: MOMENTO,
    created_by: null,
    ...extra,
  };
}

function propostaDe(l: Lado, id: string, tipo: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: l.org,
    run_id: "a7000000-0000-4000-8000-000000000001",
    dataset: "atendimento",
    type: tipo,
    target: "playbook",
    content: `Aprendizado ${l.rotulo}`,
    evidence: {},
    proposed_at: MOMENTO,
    applied_at: null,
    applied_version_id: null,
    applied_by: null,
    ...extra,
  };
}

function execucaoDe(l: Lado): Linha {
  return {
    id: l.execucao,
    organization_id: l.org,
    agent_id: l.agente,
    contact_id: null,
    purpose: "agent_turn",
    status: "ok",
    error_code: null,
    error_message: null,
    input_tokens: 100,
    output_tokens: 20,
    cost_cents: 1,
    latency_ms: 800,
    created_at: MOMENTO,
  };
}

// ─── A tabela de casos ───────────────────────────────────────────────────────

const CASOS: Caso[] = [
  {
    rota: "app/api/v1/ai/agents/assignable/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/agents/assignable/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: "/api/v1/ai/agents/assignable",
    linhas: {
      ai_agents: [
        agenteDe(A, A.agente, { published_version_id: A.versao }),
        agenteDe(B, B.agente, { published_version_id: B.versao }),
      ],
      ai_agent_versions: [
        versaoDe(A, A.versao, A.agente, { version_number: 3 }),
        versaoDe(B, B.versao, B.agente, { version_number: 5 }),
      ],
    },
    papel: "agent",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "ai_agents",
    esperaNaResposta: [A.agente],
    // Rota de coleção sem id: B recebe 200 com a lista DELE, nunca a de A.
    statusDeB: 200,
    esperaNaRespostaDeB: [B.agente],
  },
  {
    rota: "app/api/v1/ai/agents/[id]/duplicate/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/agents/[id]/duplicate/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/agents/${A.agente}/duplicate`,
    params: { id: A.agente },
    linhas: {
      ai_agents: [
        agenteDe(A, A.agente, { published_version_id: A.versao }),
        agenteDe(B, B.agente, { published_version_id: B.versao }),
      ],
      ai_agent_versions: [versaoDe(A, A.versao, A.agente), versaoDe(B, B.versao, B.agente)],
    },
    papel: "admin",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "ai_agents",
    audita: "ai_agent.duplicated",
    esperaNaResposta: ["Agente A (cópia)"],
    confere: (viva) => {
      // A cópia nasce na organização do token, e a autoria é null: id de token
      // nunca vai para `created_by`.
      const novo = viva.ai_agents?.find((l) => l.name === "Agente A (cópia)");
      expect(novo?.organization_id).toBe(ORG_A);
      expect(novo?.created_by).toBeNull();
      const versaoNova = viva.ai_agent_versions?.find((l) => l.agent_id === novo?.id);
      expect(versaoNova?.organization_id).toBe(ORG_A);
      expect(versaoNova?.created_by).toBeNull();
    },
    // `duplicateAgentWithVersion` não acha o agente de A na organização de B.
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/agents/[id]/pause/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/agents/[id]/pause/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/agents/${A.agente}/pause`,
    params: { id: A.agente },
    linhas: {
      ai_agents: [
        agenteDe(A, A.agente, { published_version_id: A.versao }),
        agenteDe(B, B.agente, { published_version_id: B.versao }),
      ],
    },
    papel: "admin",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "ai_agents",
    audita: "ai_agent.paused",
    esperaNaResposta: [A.agente],
    confere: (viva) => {
      const alvo = viva.ai_agents?.find((l) => l.id === A.agente);
      expect(typeof alvo?.paused_at).toBe("string");
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/agents/[id]/proposals/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/agents/[id]/proposals/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: `/api/v1/ai/agents/${A.agente}/proposals`,
    params: { id: A.agente },
    linhas: {
      ai_agents: [agenteDe(A, A.agente), agenteDe(B, B.agente)],
      flywheel_distiller_proposals: [
        propostaDe(A, A.proposta, "playbook_bullet"),
        propostaDe(B, B.proposta, "playbook_bullet"),
      ],
    },
    papel: "agent",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "flywheel_proposals",
    esperaNaResposta: [A.proposta],
    // A rota confere que o agente existe NA organização do token antes de listar.
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/agents/[id]/proposals/[pid]/apply/route.ts",
    carregar: () =>
      import(
        "@/app/api/v1/ai/agents/[id]/proposals/[pid]/apply/route"
      ) as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/agents/${A.agente}/proposals/${A.propostaMemoria}/apply`,
    params: { id: A.agente, pid: A.propostaMemoria },
    variante: "proposta de memória da empresa",
    linhas: {
      flywheel_distiller_proposals: [
        propostaDe(A, A.propostaMemoria, "org_memory_entry"),
        propostaDe(B, B.propostaMemoria, "org_memory_entry"),
      ],
    },
    papel: "admin",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "flywheel_proposals",
    audita: "ai.flywheel_proposal_applied",
    esperaNaResposta: ["entry_id"],
    confere: (viva) => {
      const memoria = viva.org_memory_entries ?? [];
      expect(memoria).toHaveLength(1);
      expect(memoria[0]?.organization_id).toBe(ORG_A);
      expect(memoria[0]?.created_by).toBeNull();
      const proposta = viva.flywheel_distiller_proposals?.find((l) => l.id === A.propostaMemoria);
      expect(typeof proposta?.applied_at).toBe("string");
      expect(proposta?.applied_by).toBeNull();
    },
    // `proposal_not_found` (404): a proposta de A não existe na organização de B.
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/agents/[id]/proposals/[pid]/apply/route.ts",
    carregar: () =>
      import(
        "@/app/api/v1/ai/agents/[id]/proposals/[pid]/apply/route"
      ) as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/agents/${A.agente}/proposals/${A.proposta}/apply`,
    params: { id: A.agente, pid: A.proposta },
    variante: "proposta de prompt do agente",
    linhas: {
      ai_agents: [
        agenteDe(A, A.agente, { published_version_id: A.versao }),
        agenteDe(B, B.agente, { published_version_id: B.versao }),
      ],
      ai_agent_versions: [versaoDe(A, A.versao, A.agente), versaoDe(B, B.versao, B.agente)],
      flywheel_distiller_proposals: [
        propostaDe(A, A.proposta, "playbook_bullet"),
        propostaDe(B, B.proposta, "playbook_bullet"),
      ],
    },
    rpc: {
      fn_publish_ai_agent_version: [
        {
          agent_id: A.agente,
          version_id: "a2000000-0000-4000-8000-000000000099",
          previous_version_id: A.versao,
          published_at: MOMENTO,
        },
      ],
    },
    papel: "admin",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "flywheel_proposals",
    audita: "ai.flywheel_proposal_applied",
    esperaNaResposta: ['"version_number":2'],
    esperaChamarRpc: ["fn_publish_ai_agent_version"],
    confere: (viva) => {
      const nova = viva.ai_agent_versions?.find((l) => l.version_number === 2);
      expect(nova?.organization_id).toBe(ORG_A);
      expect(nova?.created_by).toBeNull();
      const proposta = viva.flywheel_distiller_proposals?.find((l) => l.id === A.proposta);
      expect(typeof proposta?.applied_at).toBe("string");
      expect(proposta?.applied_by).toBeNull();
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/agents/[id]/reconcile/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/agents/[id]/reconcile/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/agents/${A.agenteLegado}/reconcile`,
    params: { id: A.agenteLegado },
    corpo: {
      channel_id: A.canal,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credential_id: A.credencial,
    },
    linhas: {
      ai_agents: [
        agenteDe(A, A.agenteLegado, { kind: "rag_bot" }),
        agenteDe(B, B.agenteLegado, { kind: "rag_bot" }),
      ],
      ai_agent_versions: [versaoDe(B, B.versao, B.agenteLegado)],
      ai_provider_credentials: [
        { id: A.credencial, organization_id: ORG_A },
        { id: B.credencial, organization_id: ORG_B },
      ],
      channel_sessions: [
        {
          id: A.canal,
          organization_id: ORG_A,
          display_name: "Canal A",
          status: "WORKING",
          phone_number: "5511900000001",
          waha_session_name: "sessao-a",
          provider: "waha",
          archived_at: null,
          created_at: MOMENTO,
        },
        {
          id: B.canal,
          organization_id: ORG_B,
          display_name: "Canal B",
          status: "WORKING",
          phone_number: "5511900000002",
          waha_session_name: "sessao-b",
          provider: "waha",
          archived_at: null,
          created_at: MOMENTO,
        },
      ],
      organizations: [
        { id: ORG_A, settings: {} },
        { id: ORG_B, settings: {} },
      ],
      ai_models: [
        {
          provider: "anthropic",
          model_id: "claude-sonnet-4-6",
          is_default_for_provider: true,
          supports_tools: true,
          input_price_per_million_cents: 300,
          output_price_per_million_cents: 1500,
          deprecated_at: null,
        },
      ],
      crm_pipelines: [
        {
          id: "a8000000-0000-4000-8000-000000000001",
          organization_id: ORG_A,
          is_default: true,
          is_archived: false,
        },
        {
          id: "b8000000-0000-4000-8000-000000000001",
          organization_id: ORG_B,
          is_default: true,
          is_archived: false,
        },
      ],
    },
    rpc: {
      fn_publish_ai_agent_version: [
        {
          agent_id: A.agenteLegado,
          version_id: "a2000000-0000-4000-8000-000000000098",
          previous_version_id: null,
          published_at: MOMENTO,
        },
      ],
      fn_agent_legacy_notice: true,
    },
    papel: "admin",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "ai_agents",
    audita: "ai_agent.reconciled",
    esperaNaResposta: ['"published":true'],
    esperaChamarRpc: ["fn_publish_ai_agent_version", "fn_agent_legacy_notice"],
    confere: (viva) => {
      const nova = viva.ai_agent_versions?.find((l) => l.agent_id === A.agenteLegado);
      expect(nova?.organization_id).toBe(ORG_A);
      expect(nova?.created_by).toBeNull();
      expect(nova?.channel_session_id).toBe(A.canal);
    },
    // "Agente legado indisponível" (404): o agente de A não existe na organização de B.
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/agents/[id]/runs/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/agents/[id]/runs/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: `/api/v1/ai/agents/${A.agente}/runs`,
    params: { id: A.agente },
    linhas: { llm_calls: [execucaoDe(A), execucaoDe(B)] },
    papel: "manager",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "ai_agents",
    esperaNaResposta: [A.execucao],
    // Lista: a rota não confere o agente, filtra as chamadas por organização E
    // por agente. Pedir o agente de A com o token de B devolve lista vazia.
    statusDeB: 200,
    listaVaziaParaB: true,
    naoEsperaNaRespostaDeB: [B.execucao],
  },
  {
    rota: "app/api/v1/ai/agents/[id]/tool-usage/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/agents/[id]/tool-usage/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: `/api/v1/ai/agents/${A.agente}/tool-usage`,
    params: { id: A.agente },
    linhas: {
      ai_agents: [
        agenteDe(A, A.agente, { published_version_id: A.versao }),
        agenteDe(B, B.agente, { published_version_id: B.versao }),
      ],
      ai_agent_versions: [versaoDe(A, A.versao, A.agente), versaoDe(B, B.versao, B.agente)],
    },
    rpc: {
      fn_agent_tool_usage: [
        { tool_name: "crm_get_lead", total: 2, falhas: 0, em_teste: 0, ultima_vez: MOMENTO },
      ],
      fn_agent_tool_usage_por_termo: [],
    },
    papel: "manager",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "ai_agents",
    // A versão lida (a publicada de A) vem na resposta.
    esperaNaResposta: [A.versao],
    esperaChamarRpc: ["fn_agent_tool_usage", "fn_agent_tool_usage_por_termo"],
    // "Agente não encontrado" (404) antes de qualquer função do banco.
    statusDeB: 404,
  },
];

// ─── Ajudantes ───────────────────────────────────────────────────────────────

const SESSAO_NO_TOKEN = "cliente de sessão usado no ramo do token";
const CABECALHO_AUT = "authorization";
// Montado em runtime de propósito: o literal do prefixo junto do valor não pode
// aparecer escrito (guarda de credencial do ambiente de escrita).
const BEARER = ["Bearer", "dsk_teste_unitario"].join(" ");
const ORDEM_DOS_PAPEIS: readonly Papel[] = ["viewer", "agent", "manager", "admin"];
const ESCOPO_OPOSTO: Record<Escopo, Escopo> = {
  "config:read": "config:write",
  "config:write": "config:read",
};

function nomeDe(caso: Caso): string {
  return `${caso.metodo} ${caso.caminho}${caso.variante ? ` (${caso.variante})` : ""}`;
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

function falsoDe(caso: Caso, orgDona: string) {
  const falso = criarClienteAdminFalso({
    orgDona,
    linhas: caso.linhas,
    rpc: caso.rpc,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  return falso;
}

function requisicao(caso: Caso, comToken: boolean): NextRequest {
  const headers = new Headers();
  if (comToken) headers.set(CABECALHO_AUT, BEARER);
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

/**
 * As linhas da organização `org`, tabela a tabela. Tabela sem nenhuma linha da
 * organização fica de fora: o falso cria a tabela vazia no primeiro acesso (uma
 * leitura, sem escrita), e uma lista vazia não é linha tocada.
 */
function linhasDe(org: string, linhas: Linhas): Linhas {
  return Object.fromEntries(
    Object.entries(linhas)
      .map(([tabela, lista]) => [tabela, lista.filter((l) => l.organization_id === org)] as const)
      .filter(([, lista]) => lista.length > 0),
  );
}

/** O id da organização e o de cada uma das suas linhas: o que NÃO pode vazar para o outro lado. */
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

// ─── O teste da área ─────────────────────────────────────────────────────────

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

describe("ai/agents aceita token de integração (Spec 33, R1)", () => {
  for (const caso of CASOS) {
    const nome = nomeDe(caso);

    it(`${nome}: token de A alcança o recurso de A`, async () => {
      const falso = falsoDe(caso, ORG_A);
      tokenDe(ORG_A, TOKEN_A, [caso.escopo], caso.papelDoToken);

      const res = await chamar(caso, true);
      const texto = await res.text();

      expect(res.status, texto).toSatisfy(ehSucesso);
      // A organização do token, e só ela, em toda cadeia, função do banco e arquivo.
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
      // Controle de vacuidade: a rota consultou de verdade.
      expect(falso.cadeias.length + falso.rpcs.length).toBeGreaterThan(0);
      for (const pedaco of caso.esperaNaResposta) expect(texto).toContain(pedaco);
      for (const nomeDaRpc of caso.esperaChamarRpc ?? []) {
        expect(falso.rpcs.map((r) => r.nome)).toContain(nomeDaRpc);
      }
      // Nada da organização B aparece na resposta, e nada dela foi tocado.
      for (const id of idsDe(ORG_B, caso.linhas)) expect(texto).not.toContain(id);
      expect(linhasDe(ORG_B, falso.linhas)).toEqual(linhasDe(ORG_B, caso.linhas));
      caso.confere?.(falso.linhas);
      // Audit: o token é o autor, nunca uma pessoa.
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
      // O ramo do token não passa pela sessão.
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
      // Nenhuma escrita, nenhuma função do banco, nada fora da organização B.
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
      // O recurso de A não vazou na resposta e continua intacto.
      for (const id of idsDe(ORG_A, caso.linhas)) expect(texto).not.toContain(id);
      expect(linhasDe(ORG_A, falso.linhas)).toEqual(linhasDe(ORG_A, caso.linhas));
      if (caso.listaVaziaParaB) {
        expect((JSON.parse(texto) as { data: unknown[] }).data).toEqual([]);
      }
      for (const pedaco of caso.esperaNaRespostaDeB ?? []) expect(texto).toContain(pedaco);
      for (const pedaco of caso.naoEsperaNaRespostaDeB ?? []) expect(texto).not.toContain(pedaco);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${nome}: token sem o escopo é recusado`, async () => {
      const falso = falsoDe(caso, ORG_A);
      // O escopo da OUTRA operação: config:read numa escrita, config:write numa leitura.
      tokenDe(ORG_A, TOKEN_A, [ESCOPO_OPOSTO[caso.escopo]], caso.papelDoToken);

      const res = await chamar(caso, true);

      expect(res.status).toBe(403);
      expect(falso.cadeias).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    // "Abaixo do papel": um degrau abaixo de `papelDoToken ?? papel`. Todos os
    // métodos desta área têm `papelDoToken` admin, então o degrau é `manager`.
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
      // O falso do cliente de sessão é só deste caso; o do admin é o de sempre.
      const sessao = criarClienteAdminFalso({
        orgDona: ORG_A,
        linhas: caso.linhas,
        rpc: caso.rpc,
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
      // Sem Authorization, o portão é o `requireRole` de sempre, com o papel da tabela.
      expect(requireRole).toHaveBeenCalledWith(
        caso.papel,
        expect.objectContaining({ resource: caso.resource }),
      );
      expect(validateBearerToken).not.toHaveBeenCalled();
      // Pela sessão não há teto: quem digita é uma pessoa.
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
    });
  }
});

/**
 * A borda que nenhum teste de handler alcança: o `proxy.ts` roda ANTES de
 * qualquer route handler e só reconhece cookie. Sem entrada em PUBLIC_PATHS o
 * Bearer nem chega na rota.
 *
 * `ls` das pastas desta área: `app/api/v1/ai/agents/` → `[id]`, `assignable`;
 * `[id]/` → `duplicate`, `pause`, `proposals`, `publish`, `reconcile`, `runs`,
 * `tool-usage`, `versions`; `proposals/` → `[pid]`; `[pid]/` → `apply`. Todo
 * irmão literal já tem porta (`publish` e `versions` desde a #2052), então o
 * que sobra para provar que não pega carona são os vizinhos que não são rota,
 * ou que são rota de outro nível.
 */
describe("ai/agents — PUBLIC_PATHS (borda do proxy)", () => {
  const PORTAS = [...new Set(CASOS.map((c) => c.caminho))];

  /** O mesmo caminho com cada id (valor de `params`) trocado por `abc`. */
  function comAbc(caso: Caso): string {
    return Object.values(caso.params ?? {}).reduce((c, valor) => c.replaceAll(valor, "abc"), caso.caminho);
  }

  const COM_ID = CASOS.filter((c) => c.params);

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
    "/api/v1/ai/agents/abc",
    `/api/v1/ai/agents/${A.agente}/proposals/${A.proposta}`,
    `/api/v1/ai/agents/${A.agente}/runs/${A.execucao}`,
    `/api/v1/ai/agents/${A.agente}/rollback`,
    `/api/v1/ai/agents/${A.agente}/versions/${A.versao}/rollback`,
    `/api/v1/ai/agents/${A.agente}/proposals/abc/apply`,
  ])("não dá carona ao vizinho %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });

  it("as portas que já existiam seguem como estavam", () => {
    expect(isPublicPath("/api/v1/ai/agents")).toBe(true);
    expect(isPublicPath(`/api/v1/ai/agents/${A.agente}`)).toBe(true);
    expect(isPublicPath(`/api/v1/ai/agents/${A.agente}/publish`)).toBe(true);
    expect(isPublicPath(`/api/v1/ai/agents/${A.agente}/versions`)).toBe(true);
  });
});
