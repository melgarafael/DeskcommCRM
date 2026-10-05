import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  support: vi.fn(async () => null),
  preview: vi.fn(),
  audit: vi.fn(async () => undefined),
  admin: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/agent-engine/agent/sandbox", () => ({ testAgentVersion: mocks.preview }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: () => ({}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

import { POST } from "@/app/api/v1/ai/agents/[id]/versions/[vid]/test/route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/** Dublê fechado: qualquer escrita fora de ai_agent_runs lança erro. */
function bancoDaRota(orgDaVersao: string) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ dados: Record<string, unknown>; filtros: Record<string, unknown> }> = [];
  const leituras: Array<Record<string, unknown>> = [];
  const admin = {
    from(table: string) {
      if (table === "ai_agent_versions") {
        const filtros: Record<string, unknown> = {};
        const consulta = {
          select: () => consulta,
          eq(coluna: string, valor: unknown) { filtros[coluna] = valor; return consulta; },
          async maybeSingle() {
            leituras.push({ ...filtros });
            const achou = filtros.id === VERSION && filtros.agent_id === AGENT && filtros.organization_id === orgDaVersao;
            return { data: achou ? { id: VERSION, agent_id: AGENT, organization_id: orgDaVersao, channel_session_id: null } : null, error: null };
          },
        };
        return consulta;
      }
      if (table !== "ai_agent_runs") throw new Error(`Escrita ou leitura inesperada: ${table}`);
      return {
        insert(dados: Record<string, unknown>) {
          inserts.push(dados);
          return { select: () => ({ single: async () => ({ data: { id: RUN }, error: null }) }) };
        },
        update(dados: Record<string, unknown>) {
          const filtros: Record<string, unknown> = {};
          const consulta = {
            eq(coluna: string, valor: unknown) { filtros[coluna] = valor; return consulta; },
            then(resolve: (v: { error: null }) => void) {
              updates.push({ dados, filtros: { ...filtros } });
              resolve({ error: null });
            },
          };
          return consulta;
        },
      };
    },
  };
  return { admin, inserts, updates, leituras };
}

function requisicao() {
  return new NextRequest("http://localhost/api/v1/ai/agents/test", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sample_message: "Mensagem de teste" }),
  });
}
const ctx = { params: Promise.resolve({ id: AGENT, vid: VERSION }) };

describe("POST de teste do agente: isolamento e efeitos explícitos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      ok: true, user: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", idioma: "pt-BR" },
      org: { orgId: ORG, role: "admin" },
    });
    mocks.preview.mockResolvedValue({ candidates: [{ body: "Olá!" }], proposals: [], trace: [] });
  });

  it("recusa versão de outra organização antes de criar run ou chamar modelo", async () => {
    const db = bancoDaRota(OUTRA_ORG);
    mocks.admin.mockReturnValue(db.admin);
    const resposta = await POST(requisicao(), ctx);
    expect(resposta.status).toBe(404);
    expect(db.leituras).toEqual([{ id: VERSION, organization_id: ORG, agent_id: AGENT }]);
    expect(db.inserts).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("grava somente run dry-run sem contato ou mensagem e passa a org ao motor", async () => {
    const db = bancoDaRota(ORG);
    mocks.admin.mockReturnValue(db.admin);
    const resposta = await POST(requisicao(), ctx);
    expect(resposta.status).toBe(200);
    expect(db.leituras).toEqual([{ id: VERSION, organization_id: ORG, agent_id: AGENT }]);
    expect(db.inserts).toEqual([expect.objectContaining({
      organization_id: ORG, agent_id: AGENT, agent_version_id: VERSION,
      is_dry_run: true, conversation_id: null, contact_id: null,
      inbound_message_id: null, outbound_message_id: null, status: "running",
    })]);
    expect(db.updates).toEqual([{ dados: expect.objectContaining({ status: "completed" }), filtros: { organization_id: ORG, id: RUN } }]);
    expect(mocks.preview).toHaveBeenCalledOnce();
    expect(mocks.preview).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      organizationId: ORG, agentId: AGENT, versionId: VERSION, runId: RUN,
      sampleMessage: "Mensagem de teste", channelId: null,
    }));
  });
});
