// @vitest-environment node
/**
 * Runtime do "Testar agente" (issue #71) e contrato do ensaio em /dry-run.
 *
 * O preview usa o mesmo core e as mesmas dependências de um turno normal. Este
 * teste fixa o contrato de falha desse caminho: o run guarda um checkpoint
 * aceito pelo CHECK (`failed`/`completed`) e a pessoa recebe orientação
 * sanitizada. O sucesso usa stub — não chama provedor externo.
 *
 * Estratégia: INSERT do run primeiro; seed do playbook platform depois.
 * Falha no seed fecha o run — não deixa `running` nem cria run fantasma.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import {
  ensurePlatformPlaybook,
  PlaybookPlatformMissingError,
} from "@/lib/agent-engine/agent/playbook-ensure";
import { testAgentVersion } from "@/lib/agent-engine/agent/sandbox";
import { newPreviewResult } from "@/lib/agent-engine/agent/preview";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { SEGMENTO_DE_ENSAIO, urlEnsaioDoAgente } from "@/lib/ai/agents/rota-de-ensaio";
import { STATUSES_DO_RUN } from "@/lib/ai/agents/ensaio-falha";

type PostEnsaio = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string; vid: string }> },
) => Promise<Response>;

const logs = vi.hoisted(() => [] as { level: string; msg: string; fields?: unknown }[]);

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/agent/sandbox", () => ({
  testAgentVersion: vi.fn(),
}));
vi.mock("@/lib/agent-engine/agent/playbook-ensure", async (importOriginal) => {
  const actual = await importOriginal();
  if (typeof actual !== "object" || actual === null) {
    throw new Error("playbook-ensure: modulo inesperado");
  }
  return { ...actual, ensurePlatformPlaybook: vi.fn() };
});
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/agent-engine/obs/logger", () => ({
  createLogger: () => ({
    info: (msg: string, fields?: unknown) => logs.push({ level: "info", msg, fields }),
    warn: (msg: string, fields?: unknown) => logs.push({ level: "warn", msg, fields }),
    error: (msg: string, fields?: unknown) => logs.push({ level: "error", msg, fields }),
  }),
  withFields: (log: unknown) => log,
}));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const RAIZ = process.cwd();
const ROTA = join(RAIZ, "app/api/v1/ai/agents/[id]/versions/[vid]/dry-run/route.ts");
const WORKER = join(RAIZ, "workers/agent-worker/main.ts");

function stubAdmin(
  atualizacoes: Record<string, unknown>[],
  inserts: Record<string, unknown>[],
  tabelas: string[],
  falhaNoUpdate = false,
) {
  return {
    from: (table: string) => {
      tabelas.push(table);
      if (table === "ai_agent_versions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: VERSION,
                      agent_id: AGENT,
                      organization_id: ORG,
                      system_prompt: "oi",
                      provider: "anthropic",
                      model: "claude-haiku-4-5",
                      channel_session_id: null,
                      max_steps: 3,
                      token_budget: 1000,
                      cost_budget_cents: 100,
                      tool_ids: [],
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {
        insert: (payload: Record<string, unknown>) => {
          inserts.push(payload);
          return {
            select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
          };
        },
        update: (payload: Record<string, unknown>) => {
          atualizacoes.push(payload);
          const done = Promise.resolve({
            error: falhaNoUpdate ? { message: "simulated" } : null,
          });
          const chain = {
            eq: () => chain,
            then: done.then.bind(done) as typeof done.then,
          };
          return chain;
        },
      };
    },
  };
}

const resultadoStub = {
  ...newPreviewResult(),
  candidates: [{ body: "resposta stub", citations: [], trace: [] }],
  checkpoint_omitted: true,
  checkpoint_omitted_reason: "isolated_run",
  llm_purposes: ["agent_preview"],
};

describe("rota de ensaio do agente", () => {
  it("vive em dry-run, não numa pasta chamada test", () => {
    expect(SEGMENTO_DE_ENSAIO).toBe("dry-run");
    expect(existsSync(ROTA)).toBe(true);
    expect(
      existsSync(join(RAIZ, "app/api/v1/ai/agents/[id]/versions/[vid]/test/route.ts")),
    ).toBe(false);
    expect(urlEnsaioDoAgente(AGENT, VERSION)).toBe(
      `/api/v1/ai/agents/${AGENT}/versions/${VERSION}/dry-run`,
    );
  });

  it("quando o Next gerou os tipos, dry-run entra e test sai", () => {
    const tipos = join(RAIZ, ".next/dev/types/routes.d.ts");
    if (!existsSync(tipos)) return;
    const texto = readFileSync(tipos, "utf8");
    expect(texto).toContain("/api/v1/ai/agents/[id]/versions/[vid]/dry-run");
    expect(texto).not.toContain("/api/v1/ai/agents/[id]/versions/[vid]/test");
  });

  it("sandbox do ensaio marca isolated: true e a rota não publica nem envia", () => {
    const sandbox = readFileSync(join(RAIZ, "lib/agent-engine/agent/sandbox.ts"), "utf8");
    expect(sandbox).toMatch(/isolated:\s*true/);
    expect(readFileSync(ROTA, "utf8")).not.toMatch(/from ["']@\/lib\/channels\/whatsapp/);
  });

  it("worker e ensaio compartilham ensurePlatformPlaybook; catch não grava status ilegal", () => {
    const rota = readFileSync(ROTA, "utf8");
    const worker = readFileSync(WORKER, "utf8");
    expect(rota).toContain("ensurePlatformPlaybook");
    expect(worker).toContain("ensurePlatformPlaybook");
    expect(worker).not.toMatch(/await seedPlatformPlaybook\(/);
    expect(rota).not.toMatch(/status:\s*"error"/);
    expect(rota).toContain('status: "failed"');
    expect(rota).toContain('status: "completed"');
  });
});

describe("POST .../versions/:vid/dry-run — core compartilhado", () => {
  const atualizacoes: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const tabelas: string[] = [];
  const requestPool = {
    query: vi.fn(async () => {
      throw new Error("o handler de ensaio não consulta o pool quando o core está mockado");
    }),
  };
  const turnDeps = {};
  const fetchSpy = vi.fn();

  function pedidoDeEnsaio(body: unknown): NextRequest {
    return new NextRequest(`http://localhost${urlEnsaioDoAgente(AGENT, VERSION)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function carregarPost(): Promise<PostEnsaio> {
    // @vite-ignore — `[id]`/`[vid]` não podem virar glob; o App Router rejeitava a pasta `test`.
    const mod = await import(
      /* @vite-ignore */
      "../../app/api/v1/ai/agents/[id]/versions/[vid]/dry-run/route"
    );
    return mod.POST;
  }

  beforeEach(() => {
    atualizacoes.length = 0;
    inserts.length = 0;
    tabelas.length = 0;
    logs.length = 0;
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(testAgentVersion).mockReset();
    vi.mocked(ensurePlatformPlaybook).mockReset();
    vi.mocked(ensurePlatformPlaybook).mockResolvedValue("kept");
    vi.mocked(audit).mockClear();
    process.env.INTERNAL_AGENT_RUN_STUB = "true";
    const user: AuthUser = {
      id: USER,
      email: "a@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
    };
    vi.mocked(requireRole).mockImplementation(async (min: Role) =>
      ROLE_RANK["admin"] >= ROLE_RANK[min]
        ? { ok: true, user, org: { orgId: ORG, name: "Org", role: "admin" } }
        : ({ ok: false, response: null } as never),
    );
    vi.mocked(createAdminClient).mockReturnValue(
      stubAdmin(atualizacoes, inserts, tabelas) as never,
    );
    vi.mocked(getRequestPool).mockReturnValue(requestPool as never);
    vi.mocked(requestTurnDeps).mockReturnValue(turnDeps as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("banco sem playbook: seed idempotente, depois o stub segue; segunda chamada kept", async () => {
    const ordem: string[] = [];
    vi.mocked(ensurePlatformPlaybook)
      .mockImplementationOnce(async () => {
        ordem.push("seed");
        return "seeded";
      })
      .mockImplementationOnce(async () => {
        ordem.push("seed");
        return "kept";
      });
    vi.mocked(testAgentVersion).mockImplementation(async () => {
      ordem.push("core");
      return resultadoStub;
    });
    const POST = await carregarPost();
    const a = await POST(pedidoDeEnsaio({ sample_message: "oi" }), {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });
    const b = await POST(pedidoDeEnsaio({ sample_message: "oi" }), {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(ordem).toEqual(["seed", "core", "seed", "core"]);
    expect(ensurePlatformPlaybook).toHaveBeenCalledTimes(2);
    expect(ensurePlatformPlaybook).toHaveBeenNthCalledWith(
      1,
      requestPool,
      expect.anything(),
      { origem: "ensaio" },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("materiais vazios continuam aceitos no stub", async () => {
    vi.mocked(testAgentVersion).mockResolvedValueOnce(resultadoStub);
    const POST = await carregarPost();
    const res = await POST(pedidoDeEnsaio({ sample_message: "oi" }), {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });
    expect(res.status).toBe(200);
    expect(testAgentVersion).toHaveBeenCalledWith(
      requestPool,
      turnDeps,
      expect.objectContaining({ sampleMessage: "oi", channelId: null }),
    );
  });

  it("falha deliberada no seed deixa run failed, nunca running, sem llm_calls", async () => {
    vi.mocked(ensurePlatformPlaybook).mockRejectedValueOnce(new PlaybookPlatformMissingError());
    const POST = await carregarPost();
    const res = await POST(pedidoDeEnsaio({ sample_message: "oi" }), {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.status).toBe("running");
    expect(testAgentVersion).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(tabelas).not.toContain("llm_calls");
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(body.error).toMatchObject({
      code: "playbook_platform_missing",
      message: "Não foi possível preparar o playbook obrigatório do ensaio.",
    });
    expect(body.error?.message).not.toMatch(/modelo|credencial|materiais/i);
    expect(JSON.stringify(body)).not.toMatch(/sk-|ANTHROPIC|stack|prompt/i);
    expect(atualizacoes).toHaveLength(1);
    expect(STATUSES_DO_RUN).toContain(atualizacoes[0]?.status);
    expect(atualizacoes[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error_code: "playbook_platform_missing",
        error_message: "Não foi possível preparar o playbook obrigatório do ensaio.",
      }),
    );
    expect(atualizacoes[0]?.completed_at).toEqual(expect.any(String));
    expect(atualizacoes[0]?.status).not.toBe("running");
    expect(atualizacoes[0]?.status).not.toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falha do core vira failed com código genérico, sem vazar chave nem stack", async () => {
    vi.mocked(testAgentVersion).mockRejectedValueOnce(
      new Error("AI_GATEWAY_API_KEY ausente sk-ant-abc\n    at sandbox.ts:1"),
    );
    const POST = await carregarPost();
    const res = await POST(pedidoDeEnsaio({ sample_message: "oi" }), {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };

    expect(ensurePlatformPlaybook).toHaveBeenCalledTimes(1);
    expect(testAgentVersion).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(422);
    expect(body.error).toMatchObject({
      code: "preview_failed",
      message: "Não foi possível executar o teste.",
    });
    expect(body.error?.message).not.toContain("AI_GATEWAY_API_KEY");
    expect(body.error?.message).not.toMatch(/modelo|credencial|materiais/i);
    expect(JSON.stringify(body)).not.toMatch(/sk-|ANTHROPIC|sandbox\.ts|prompt/i);
    expect(JSON.stringify(logs)).not.toMatch(/sk-ant|AI_GATEWAY_API_KEY|sandbox\.ts/);
    expect(JSON.stringify(atualizacoes)).not.toMatch(/sk-ant|AI_GATEWAY|sandbox\.ts/);
    expect(atualizacoes).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error_code: "preview_failed",
        error_message: "Não foi possível executar o teste.",
      }),
    );
    expect(tabelas).not.toContain("llm_calls");
    expect(STATUSES_DO_RUN).toContain("failed");
  });

  it("se o checkpoint falhar, o handler ainda devolve JSON e registra erro sanitizado", async () => {
    vi.mocked(ensurePlatformPlaybook).mockRejectedValueOnce(new PlaybookPlatformMissingError());
    vi.mocked(createAdminClient).mockReturnValue(
      stubAdmin(atualizacoes, inserts, tabelas, true) as never,
    );
    const POST = await carregarPost();
    const res = await POST(pedidoDeEnsaio({ sample_message: "oi" }), {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(422);
    expect(body.error?.code).toBe("playbook_platform_missing");
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "ensaio: checkpoint nao gravado",
        fields: { code: "playbook_platform_missing" },
      }),
    );
    expect(JSON.stringify(logs)).not.toMatch(/sk-|stack|prompt/i);
  });

  it("modo stub devolve JSON, um dry-run, um audit, canal nulo, sem publicar, status completed no banco", async () => {
    vi.mocked(testAgentVersion).mockResolvedValueOnce(resultadoStub);
    const POST = await carregarPost();
    const req = pedidoDeEnsaio({ sample_message: "oi" });

    const res = await POST(req, { params: Promise.resolve({ id: AGENT, vid: VERSION }) });
    const body = (await res.json()) as {
      data?: {
        run_id?: string;
        status?: string;
        stub?: boolean;
        final_text?: string;
        llm_purposes?: string[];
        checkpoint_generated?: boolean;
        checkpoint_notice?: string | null;
        steps_count?: number;
        tools_offered?: string[];
        tools_called?: string[];
        tokens_in?: number;
        tokens_out?: number;
        cost_cents?: number;
        latency_ms?: number;
        llm_latency_ms?: number;
      };
      error?: unknown;
    };

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(body.error).toBeUndefined();
    expect(body.data).toMatchObject({
      run_id: "run-1",
      status: "ok",
      stub: true,
      final_text: "resposta stub",
      generated_response: "resposta stub",
      delivery_status: "allowed",
      checkpoint_generated: false,
      checkpoint_omitted_reason: "isolated_run",
      steps_count: 0,
      tools_offered: [],
      tools_called: [],
      llm_purposes: ["agent_preview"],
      tokens_in: 0,
      tokens_out: 0,
      cost_cents: 0,
      llm_latency_ms: 0,
    });
    expect(body.data).toHaveProperty("latency_ms");
    expect(body.data).toHaveProperty("checkpoint_notice");
    expect(String(body.data?.checkpoint_notice ?? "")).toMatch(/isolad/i);
    expect(body.data?.llm_purposes).not.toContain("checkpoint");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      is_dry_run: true,
      channel_session_id: null,
      agent_id: AGENT,
      agent_version_id: VERSION,
    });
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]).toEqual(
      expect.objectContaining({
        status: "completed",
      }),
    );
    expect(STATUSES_DO_RUN).toContain(atualizacoes[0]?.status);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_agent.tested",
        resourceId: VERSION,
        metadata: expect.objectContaining({ run_id: "run-1", dry_run: true }),
      }),
    );
    expect(tabelas).not.toContain("ai_agents");
    expect(tabelas).not.toContain("llm_calls");
    expect(requireRole).toHaveBeenCalledWith(
      "admin",
      expect.objectContaining({ resource: "ai_agents" }),
    );
    expect(testAgentVersion).toHaveBeenCalledTimes(1);
    expect(ensurePlatformPlaybook).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toMatch(/sk-|ANTHROPIC_API_KEY/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("copia tokens e custo do core para o run e devolve entrega bloqueada com a resposta", async () => {
    const resultado = newPreviewResult();
    resultado.candidates.push({
      body: "Olá, posso ajudar com o pedido.",
      citations: [],
      trace: [],
    });
    resultado.delivery_status = "blocked";
    resultado.delivery_impediments.push({
      classe: "entrega",
      code: "outside_window",
      gate: "pacing",
      message: "Fora da janela de envio 7h–22h",
    });
    resultado.tokens_in = 15707;
    resultado.tokens_out = 613;
    resultado.cost_cents = 1.8772;
    resultado.latency_ms = 4120;
    vi.mocked(testAgentVersion).mockResolvedValueOnce(resultado);
    const POST = await carregarPost();
    const res = await POST(pedidoDeEnsaio({ sample_message: "oi" }), {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });
    const body = (await res.json()) as {
      data?: {
        generated_response?: string;
        delivery_status?: string;
        delivery_impediments?: Array<{ message: string }>;
        tokens_in?: number;
        tokens_out?: number;
        cost_cents?: number;
        notice?: string;
      };
    };
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      generated_response: "Olá, posso ajudar com o pedido.",
      delivery_status: "blocked",
      notice: "Resposta gerada, mas não seria enviada agora.",
      tokens_in: 15707,
      tokens_out: 613,
      cost_cents: 1.8772,
    });
    expect(body.data?.delivery_impediments?.[0]?.message).toBe("Fora da janela de envio 7h–22h");
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        tokens_in: 15707,
        tokens_out: 613,
        cost_cents: 1.8772,
        steps_count: 0,
        tool_calls: { offered: [], called: [] },
      }),
    );
    expect(typeof atualizacoes[0]?.latency_ms).toBe("number");
    expect(atualizacoes[0]?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(tabelas.filter((t) => t === "llm_calls")).toEqual([]);
    expect(tabelas.filter((t) => t === "ai_agent_runs")).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
