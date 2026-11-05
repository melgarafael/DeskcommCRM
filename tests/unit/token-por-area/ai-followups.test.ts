// @vitest-environment node
/**
 * `ai/followup-flows` e `ai/followups` ACEITAM TOKEN DE INTEGRAÇÃO (Spec 33, fatia R1, tarefa 3).
 *
 * Tabelas da R1 medida em `fe7a11457` e conferida de novo no passo 1:
 *
 *   ai/followup-flows (8 métodos, receita A):
 *   - POST [id]/disable        manager
 *   - POST [id]/duplicate      manager
 *   - GET  [id]/export         viewer
 *   - GET  [id]                viewer
 *   - PATCH [id]               manager
 *   - DELETE [id]              manager
 *   - POST import              manager
 *   - GET modelos-aprovados    viewer
 *
 *   ai/followups (7 métodos, receita A):
 *   - POST enrollments/[id]/cancel   manager
 *   - POST enrollments/[id]/pause    manager
 *   - GET  enrollments/[id]          viewer
 *   - POST enrollments/[id]/snooze   manager
 *   - GET  enrollments               viewer
 *   - POST promises/[id]/cancel      manager
 *   - GET  queue                     viewer
 *
 * Ficam de fora (não há porta, não há teste de token): publish, rollback,
 * resume, skip, POST enrollments (inscrever contato agenda envio — D6).
 *
 * O teste usa receita A (`requireRole` → `resolveAuthDual`), como `ai-agents.test.ts`.
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
const USER_A = "11111111-1111-4111-4111-8111-111111111111";

type Lado = {
  org: string;
  rotulo: string;
  pointer: string;
  pointerB: string;
  versao: string;
  versaoB: string;
  enrollment: string;
  enrollmentB: string;
  contato: string;
  contatoB: string;
  lead: string;
  leadB: string;
  cron: string;
  cronB: string;
  agenda: string;
  agendaB: string;
  pipeline: string;
  pipelineB: string;
  stage: string;
  stageB: string;
  modelo: string;
  modeloB: string;
  meta: string;
  metaB: string;
};

const A: Lado = {
  org: ORG_A,
  rotulo: "A",
  pointer: "a1000000-0000-4000-8000-000000000001",
  pointerB: "a1000000-0000-4000-8000-000000000002",
  versao: "a2000000-0000-4000-8000-000000000001",
  versaoB: "a2000000-0000-4000-8000-000000000002",
  enrollment: "a3000000-0000-4000-8000-000000000001",
  enrollmentB: "a3000000-0000-4000-8000-000000000002",
  contato: "a4000000-0000-4000-8000-000000000001",
  contatoB: "a4000000-0000-4000-8000-000000000002",
  lead: "a5000000-0000-4000-8000-000000000001",
  leadB: "a5000000-0000-4000-8000-000000000002",
  cron: "a6000000-0000-4000-8000-000000000001",
  cronB: "a6000000-0000-4000-8000-000000000002",
  agenda: "a7000000-0000-4000-8000-000000000001",
  agendaB: "a7000000-0000-4000-8000-000000000002",
  pipeline: "a8000000-0000-4000-8000-000000000001",
  pipelineB: "a8000000-0000-4000-8000-000000000002",
  stage: "a9000000-0000-4000-8000-000000000001",
  stageB: "a9000000-0000-4000-8000-000000000002",
  modelo: "aa000000-0000-4000-8000-000000000001",
  modeloB: "aa000000-0000-4000-8000-000000000002",
  meta: "ab000000-0000-4000-8000-000000000001",
  metaB: "ab000000-0000-4000-8000-000000000002",
};

const B: Lado = {
  org: ORG_B,
  rotulo: "B",
  pointer: "b1000000-0000-4000-8000-000000000001",
  pointerB: "b1000000-0000-4000-8000-000000000002",
  versao: "b2000000-0000-4000-8000-000000000001",
  versaoB: "b2000000-0000-4000-8000-000000000002",
  enrollment: "b3000000-0000-4000-8000-000000000001",
  enrollmentB: "b3000000-0000-4000-8000-000000000002",
  contato: "b4000000-0000-4000-8000-000000000001",
  contatoB: "b4000000-0000-4000-8000-000000000002",
  lead: "b5000000-0000-4000-8000-000000000001",
  leadB: "b5000000-0000-4000-8000-000000000002",
  cron: "b6000000-0000-4000-8000-000000000001",
  cronB: "b6000000-0000-4000-8000-000000000002",
  agenda: "b7000000-0000-4000-8000-000000000001",
  agendaB: "b7000000-0000-4000-8000-000000000002",
  pipeline: "b8000000-0000-4000-8000-000000000001",
  pipelineB: "b8000000-0000-4000-8000-000000000002",
  stage: "b9000000-0000-4000-8000-000000000001",
  stageB: "b9000000-0000-4000-8000-000000000002",
  modelo: "ba000000-0000-4000-8000-000000000001",
  modeloB: "ba000000-0000-4000-8000-000000000002",
  meta: "bb000000-0000-4000-8000-000000000001",
  metaB: "bb000000-0000-4000-8000-000000000002",
};

/**
 * Tabelas SEM a coluna `organization_id` (conferidas em `supabase/baseline.sql`).
 * Todas as tabelas usadas nesta área têm organization_id; esta lista fica vazia
 * por precaução (a receita exige declarar todas as que não têm).
 */
const SEM_ORGANIZACAO: readonly string[] = [];

// ─── Tipos do teste ──────────────────────────────────────────────────────────

type Linha = Record<string, unknown>;
type Linhas = Record<string, Linha[]>;
type Metodo = "GET" | "POST" | "PATCH" | "DELETE";
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
  rpc?: Record<string, unknown>;
  papel: Papel;
  escopo: Escopo;
  papelDoToken: "admin";
  resource: string;
  variante?: string;
  audita?: string;
  esperaNaResposta: string[];
  esperaChamarRpc?: string[];
  confere?: (viva: Linhas) => void;
  statusDeB: 404 | 200 | 201;
  /**
   * Rota que CRIA: o token de B grava na PRÓPRIA organização (201). A prova não
   * muda — toda escrita e toda auditoria saem com a organização de B, e nada de A
   * aparece —, só deixa de exigir "nenhuma escrita".
   */
  criaNaPropriaOrganizacao?: boolean;
  listaVaziaParaB?: boolean;
  esperaNaRespostaDeB?: string[];
  naoEsperaNaRespostaDeB?: string[];
};

const MOMENTO = "2026-01-01T00:00:00.000Z";

function ponteiroDe(l: Lado, id: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: l.org,
    name: `Fluxo ${l.rotulo}`,
    status: "draft",
    active_version_id: l.versao,
    draft_graph: { nodes: [], edges: [] },
    handoff_policy: "pause",
    trigger_config: { kind: "manual" },
    surface: "followup",
    created_at: MOMENTO,
    updated_at: MOMENTO,
    ...extra,
  };
}

function versaoFluxoDe(l: Lado, id: string, pointer: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: l.org,
    pointer_id: pointer,
    graph: { nodes: [], edges: [] },
    created_at: MOMENTO,
    ...extra,
  };
}

function enrollmentDe(l: Lado, id: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: l.org,
    pointer_id: l.pointer,
    version_id: l.versao,
    contact_id: l.contato,
    current_node_id: "n1",
    status: "active",
    next_eval_at: MOMENTO,
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    steps_taken: 0,
    started_at: MOMENTO,
    completed_at: null,
    updated_at: MOMENTO,
    ...extra,
  };
}

function contatoDe(l: Lado, id: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: l.org,
    name: `Contato ${l.rotulo}`,
    phone_number: "+5511900000001",
    ...extra,
  };
}

function cronDe(l: Lado, id: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: l.org,
    contact_id: l.contato,
    kind: "at",
    job_kind: "followup_turn",
    next_run_at: MOMENTO,
    enabled: true,
    // Linha viva: sem cancelamento. Sem estes campos, `situacaoDoRetorno` lê
    // `undefined !== null` como cancelado e a promessa já nasce "encerrada".
    cancelled_at: null,
    cancel_reason: null,
    last_error: null,
    attempts: 0,
    max_attempts: 5,
    payload: {},
    created_at: MOMENTO,
    updated_at: MOMENTO,
    ...extra,
  };
}

function modeloDe(l: Lado, id: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: l.org,
    name: `Modelo ${l.rotulo}`,
    language: "pt_BR",
    status: "APPROVED",
    parameter_format: null,
    components: [],
    ...extra,
  };
}

function metaDe(l: Lado, id: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: l.org,
    name: `Meta ${l.rotulo}`,
    language: "pt_BR",
    status: "APPROVED",
    parameter_format: null,
    components: [],
    ...extra,
  };
}

/** Grafo mínimo que passa no schema de fluxo (gatilho + fim): o que a exportação aceita. */
const GRAFO_EXPORTAVEL = {
  nodes: [
    { id: "t1", type: "trigger", label: "t1", position: { x: 0, y: 0 }, config: {} },
    { id: "e1", type: "end", label: "e1", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
  ],
  edges: [{ id: "edge1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
};

/** Snooze precisa ser FUTURO (e até 90 dias): a data é relativa ao relógio da execução. */
const DEPOIS_EM_DOIS_DIAS = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

// ─── A tabela de casos ───────────────────────────────────────────────────────

const CASOS: Caso[] = [
  {
    rota: "app/api/v1/ai/followup-flows/[id]/disable/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followup-flows/[id]/disable/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/followup-flows/${A.pointer}/disable`,
    params: { id: A.pointer },
    linhas: {
      followup_flow_pointers: [
        ponteiroDe(A, A.pointer),
        ponteiroDe(B, B.pointer),
      ],
    },
    papel: "manager",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "followup_flows",
    audita: "followup_flow.disabled",
    esperaNaResposta: ["disabled"],
    confere: (viva) => {
      const alvo = viva.followup_flow_pointers?.find((l) => l.id === A.pointer);
      expect(alvo?.status).toBe("disabled");
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followup-flows/[id]/duplicate/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followup-flows/[id]/duplicate/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/followup-flows/${A.pointer}/duplicate`,
    params: { id: A.pointer },
    linhas: {
      followup_flow_pointers: [
        ponteiroDe(A, A.pointer),
        ponteiroDe(B, B.pointer),
      ],
    },
    papel: "manager",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "followup_flows",
    audita: "followup_flow.duplicated",
    esperaNaResposta: ["Fluxo A (cópia)"],
    confere: (viva) => {
      const copia = viva.followup_flow_pointers?.find((l) => l.name === "Fluxo A (cópia)");
      expect(copia?.organization_id).toBe(ORG_A);
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followup-flows/[id]/export/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followup-flows/[id]/export/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: `/api/v1/ai/followup-flows/${A.pointer}/export`,
    params: { id: A.pointer },
    linhas: {
      // Exportar exige um grafo que passe no schema (gatilho e fim): o rascunho
      // vazio da fixture padrão é recusado com 422 `flow_empty`.
      followup_flow_pointers: [
        ponteiroDe(A, A.pointer, { draft_graph: GRAFO_EXPORTAVEL }),
        ponteiroDe(B, B.pointer, { draft_graph: GRAFO_EXPORTAVEL }),
      ],
    },
    papel: "viewer",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "followup_flows",
    // O arquivo leva o NOME do fluxo, não o id do ponteiro (portabilidade.ts).
    esperaNaResposta: ["Fluxo A"],
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followup-flows/[id]/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followup-flows/[id]/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: `/api/v1/ai/followup-flows/${A.pointer}`,
    params: { id: A.pointer },
    linhas: {
      followup_flow_pointers: [
        ponteiroDe(A, A.pointer, { active_version_id: A.versao }),
        ponteiroDe(B, B.pointer),
      ],
      followup_flow_versions: [versaoFluxoDe(A, A.versao, A.pointer)],
    },
    papel: "viewer",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "followup_flows",
    esperaNaResposta: [A.pointer],
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followup-flows/[id]/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followup-flows/[id]/route") as unknown as Promise<ModuloDeRota>,
    metodo: "PATCH",
    caminho: `/api/v1/ai/followup-flows/${A.pointer}`,
    params: { id: A.pointer },
    corpo: { name: "Fluxo A renomeado" },
    linhas: {
      followup_flow_pointers: [
        ponteiroDe(A, A.pointer),
        ponteiroDe(B, B.pointer),
      ],
    },
    papel: "manager",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "followup_flows",
    audita: "followup_flow.updated",
    esperaNaResposta: ["Fluxo A renomeado"],
    confere: (viva) => {
      const alvo = viva.followup_flow_pointers?.find((l) => l.id === A.pointer);
      expect(alvo?.name).toBe("Fluxo A renomeado");
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followup-flows/[id]/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followup-flows/[id]/route") as unknown as Promise<ModuloDeRota>,
    metodo: "DELETE",
    caminho: `/api/v1/ai/followup-flows/${A.pointer}`,
    params: { id: A.pointer },
    linhas: {
      followup_flow_pointers: [
        ponteiroDe(A, A.pointer),
        ponteiroDe(B, B.pointer),
      ],
      followup_flow_versions: [versaoFluxoDe(A, A.versao, A.pointer)],
      followup_enrollments: [enrollmentDe(A, A.enrollment)],
    },
    papel: "manager",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "followup_flows",
    audita: "followup_flow.deleted",
    esperaNaResposta: [A.pointer],
    confere: (viva) => {
      const resto = viva.followup_flow_pointers?.filter((l) => l.id === A.pointer);
      expect(resto).toHaveLength(0);
      const versao = viva.followup_flow_versions?.filter((l) => l.id === A.versao);
      expect(versao).toHaveLength(0);
      const enr = viva.followup_enrollments?.filter((l) => l.id === A.enrollment);
      expect(enr).toHaveLength(0);
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followup-flows/import/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followup-flows/import/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: "/api/v1/ai/followup-flows/import",
    corpo: {
      file: {
        format: "followup_flow",
        version: 1,
        flow: {
          name: "Fluxo importado A",
          surface: "followup",
          handoff_policy: "pause",
          trigger_config: { kind: "manual" },
          graph: {
            nodes: [
              { id: "t1", type: "trigger", label: "t1", position: { x: 0, y: 0 }, config: {} },
              { id: "e1", type: "end", label: "e1", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
            ],
            edges: [{ id: "edge1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
          },
        },
      },
    },
    linhas: {
      followup_flow_pointers: [ponteiroDe(A, A.pointer)],
    },
    papel: "manager",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "followup_flows",
    audita: "followup_flow.imported",
    esperaNaResposta: ["Fluxo importado A"],
    confere: (viva) => {
      const criado = viva.followup_flow_pointers?.find((l) => l.name === "Fluxo importado A");
      expect(criado?.organization_id).toBe(ORG_A);
    },
    // Importar é CRIAR (201, como a rota responde). O token de B importa na
    // própria organização: o arquivo não traz organização, e o fluxo nasce em B.
    statusDeB: 201,
    criaNaPropriaOrganizacao: true,
  },
  {
    rota: "app/api/v1/ai/followup-flows/modelos-aprovados/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followup-flows/modelos-aprovados/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: "/api/v1/ai/followup-flows/modelos-aprovados",
    linhas: {
      meta_templates: [
        metaDe(A, A.meta, { name: "Modelo Meta A" }),
        metaDe(B, B.meta, { name: "Modelo Meta B" }),
      ],
    },
    papel: "viewer",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "followup_flows",
    esperaNaResposta: ["Modelo Meta A"],
    // B tem o SEU modelo aprovado: a lista dele não é vazia, e ela só traz o dele.
    statusDeB: 200,
    esperaNaRespostaDeB: ["Modelo Meta B"],
    naoEsperaNaRespostaDeB: ["Modelo Meta A"],
  },
  {
    rota: "app/api/v1/ai/followups/enrollments/[id]/cancel/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followups/enrollments/[id]/cancel/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/followups/enrollments/${A.enrollment}/cancel`,
    params: { id: A.enrollment },
    linhas: {
      followup_enrollments: [
        enrollmentDe(A, A.enrollment),
        enrollmentDe(B, B.enrollment),
      ],
    },
    papel: "manager",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "followup_enrollments",
    audita: "followup_enrollment.cancelled",
    esperaNaResposta: ["cancelled"],
    confere: (viva) => {
      const alvo = viva.followup_enrollments?.find((l) => l.id === A.enrollment);
      expect(alvo?.status).toBe("cancelled");
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followups/enrollments/[id]/pause/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followups/enrollments/[id]/pause/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/followups/enrollments/${A.enrollment}/pause`,
    params: { id: A.enrollment },
    linhas: {
      followup_enrollments: [
        enrollmentDe(A, A.enrollment),
        enrollmentDe(B, B.enrollment),
      ],
    },
    papel: "manager",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "followup_enrollments",
    audita: "followup_enrollment.paused",
    esperaNaResposta: [A.enrollment],
    confere: (viva) => {
      const alvo = viva.followup_enrollments?.find((l) => l.id === A.enrollment);
      expect(alvo?.status).toBe("paused_manual");
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followups/enrollments/[id]/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followups/enrollments/[id]/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: `/api/v1/ai/followups/enrollments/${A.enrollment}`,
    params: { id: A.enrollment },
    linhas: {
      followup_enrollments: [
        enrollmentDe(A, A.enrollment),
        enrollmentDe(B, B.enrollment),
      ],
      contacts: [contatoDe(A, A.contato)],
    },
    papel: "viewer",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "followup_enrollments",
    esperaNaResposta: [A.enrollment],
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followups/enrollments/[id]/snooze/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followups/enrollments/[id]/snooze/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/followups/enrollments/${A.enrollment}/snooze`,
    params: { id: A.enrollment },
    corpo: { next_eval_at: DEPOIS_EM_DOIS_DIAS },
    linhas: {
      followup_enrollments: [
        enrollmentDe(A, A.enrollment),
        enrollmentDe(B, B.enrollment),
      ],
    },
    papel: "manager",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "followup_enrollments",
    audita: "followup_enrollment.snoozed",
    esperaNaResposta: [A.enrollment],
    confere: (viva) => {
      const alvo = viva.followup_enrollments?.find((l) => l.id === A.enrollment);
      expect(alvo?.next_eval_at).toBe(DEPOIS_EM_DOIS_DIAS);
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followups/enrollments/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followups/enrollments/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: "/api/v1/ai/followups/enrollments",
    linhas: {
      followup_enrollments: [
        enrollmentDe(A, A.enrollment),
        enrollmentDe(B, B.enrollment),
      ],
    },
    papel: "viewer",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "followup_enrollments",
    esperaNaResposta: [A.enrollment],
    // Rota de coleção sem id: B recebe 200 com a lista DELE, nunca a de A.
    statusDeB: 200,
    esperaNaRespostaDeB: [B.enrollment],
    naoEsperaNaRespostaDeB: [A.enrollment],
  },
  {
    rota: "app/api/v1/ai/followups/promises/[id]/cancel/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followups/promises/[id]/cancel/route") as unknown as Promise<ModuloDeRota>,
    metodo: "POST",
    caminho: `/api/v1/ai/followups/promises/${A.cron}/cancel`,
    params: { id: A.cron },
    linhas: {
      cron_jobs: [
        cronDe(A, A.cron),
        cronDe(B, B.cron),
      ],
      contacts: [contatoDe(A, A.contato)],
    },
    papel: "manager",
    escopo: "config:write",
    papelDoToken: "admin",
    resource: "followup_promises",
    audita: "followup.cancelled",
    esperaNaResposta: ["cancelado"],
    confere: (viva) => {
      const alvo = viva.cron_jobs?.find((l) => l.id === A.cron);
      expect(alvo?.enabled).toBe(false);
    },
    statusDeB: 404,
  },
  {
    rota: "app/api/v1/ai/followups/queue/route.ts",
    carregar: () =>
      import("@/app/api/v1/ai/followups/queue/route") as unknown as Promise<ModuloDeRota>,
    metodo: "GET",
    caminho: "/api/v1/ai/followups/queue",
    linhas: {
      followup_enrollments: [
        enrollmentDe(A, A.enrollment),
        enrollmentDe(B, B.enrollment),
      ],
      cron_jobs: [cronDe(A, A.cron), cronDe(B, B.cron)],
      contacts: [contatoDe(A, A.contato), contatoDe(B, B.contato)],
      followup_flow_pointers: [ponteiroDe(A, A.pointer)],
    },
    papel: "viewer",
    escopo: "config:read",
    papelDoToken: "admin",
    resource: "followup_queue",
    esperaNaResposta: [A.enrollment],
    statusDeB: 200,
    listaVaziaParaB: false,
    esperaNaRespostaDeB: [B.enrollment],
  },
];

// ─── Ajudantes ───────────────────────────────────────────────────────────────

const SESSAO_NO_TOKEN = "cliente de sessão usado no ramo do token";
const CABECALHO_AUT = "authorization";
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

describe("ai/followup-flows e ai/followups aceitam token de integração (Spec 33, R1)", () => {
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
      for (const nomeDaRpc of caso.esperaChamarRpc ?? []) {
        expect(falso.rpcs.map((r) => r.nome)).toContain(nomeDaRpc);
      }
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
      // Quem cria, cria na organização de B: a escrita é permitida, mas só nela.
      if (!caso.criaNaPropriaOrganizacao) expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
      for (const id of idsDe(ORG_A, caso.linhas)) expect(texto).not.toContain(id);
      expect(linhasDe(ORG_A, falso.linhas)).toEqual(linhasDe(ORG_A, caso.linhas));
      if (caso.listaVaziaParaB) {
        expect((JSON.parse(texto) as { data: unknown[] }).data).toEqual([]);
      }
      for (const pedaco of caso.esperaNaRespostaDeB ?? []) expect(texto).toContain(pedaco);
      for (const pedaco of caso.naoEsperaNaRespostaDeB ?? []) expect(texto).not.toContain(pedaco);
      if (caso.criaNaPropriaOrganizacao) {
        expect(audit).toHaveBeenCalled();
        for (const [entrada] of vi.mocked(audit).mock.calls) {
          expect(entrada).toMatchObject({ organizationId: ORG_B, actorApiTokenId: TOKEN_B });
        }
      } else {
        expect(audit).not.toHaveBeenCalled();
      }
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
    });
  }
});

// ─── PUBLIC_PATHS (borda do proxy) ──────────────────────────────────────────

describe("ai/followup-flows e ai/followups — PUBLIC_PATHS (borda do proxy)", () => {
  const PORTAS = [...new Set(CASOS.map((c) => c.caminho))];

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
    "/api/v1/ai/followup-flows/abc/disable",
    "/api/v1/ai/followup-flows/abc/duplicate",
    "/api/v1/ai/followup-flows/abc/export",
    `/api/v1/ai/followup-flows/${A.pointer}/publish`,
    `/api/v1/ai/followup-flows/${A.pointer}/rollback`,
    // `from-model` NÃO entra aqui: é porta pública de propósito (ver o último caso).
    "/api/v1/ai/followup-flows/xpto",
    "/api/v1/ai/followups/enrollments/abc/resume",
    "/api/v1/ai/followups/enrollments/abc/skip",
    "/api/v1/ai/followups/enrollments/xpto",
  ])("não dá carona ao vizinho %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });

  it("as portas que já existiam seguem como estavam", () => {
    expect(isPublicPath("/api/v1/ai/followup-flows")).toBe(true);
    expect(isPublicPath("/api/v1/ai/followup-flows/from-model")).toBe(true);
  });
});
