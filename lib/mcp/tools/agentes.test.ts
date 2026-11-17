/**
 * As ferramentas MCP de editar assistentes, com o banco falsificado e as regras
 * de `lib/ai/agents/edicao.ts` / `teste-da-versao.ts` espionadas: o que se
 * prova aqui é a tradução — de onde parte o rascunho, que nada além do prompt
 * muda, que cada assistente tem o seu rascunho, que publicar exige número
 * explícito, que a organização sai do contexto e que tudo pede admin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpContext } from "../types";

const h = vi.hoisted(() => ({
  agentes: [] as Array<Record<string, unknown>>,
  versoes: [] as Array<Record<string, unknown>>,
  filtrosDeOrg: [] as Array<{ tabela: string; org: unknown }>,
  salvos: [] as Array<{ agentId: string; payload: Record<string, unknown> }>,
  publicados: [] as Array<{ agentId: string; versionId: string }>,
  testados: [] as Array<{ versionId: string; mensagem: string }>,
}));

vi.mock("@/lib/ai/agents/edicao", () => {
  return {
    salvarRascunhoDaVersao: vi.fn(async (_admin: unknown, a: { agentId: string; payload: Record<string, unknown> }) => {
      h.salvos.push({ agentId: a.agentId, payload: a.payload });
      return { ok: true, data: { version_id: `rasc-${a.agentId}`, version_number: 99, criada: true, agente: {} } };
    }),
    publicarVersao: vi.fn(async (_admin: unknown, a: { agentId: string; versionId: string }) => {
      h.publicados.push({ agentId: a.agentId, versionId: a.versionId });
      return { ok: true, data: { version_id: a.versionId, previous_version_id: "v-pub", published_at: "2026-11-16T20:00:00Z" } };
    }),
    reverterParaVersao: vi.fn(async () => ({
      ok: true,
      data: { new_version_id: "v-new", new_version_number: 30, previous_version_id: "v-pub" },
    })),
  };
});

vi.mock("@/lib/ai/agents/teste-da-versao", () => ({
  testarVersaoDoAgente: vi.fn(async (_admin: unknown, a: { versionId: string; pedido: { sample_message: string } }) => {
    h.testados.push({ versionId: a.versionId, mensagem: a.pedido.sample_message });
    return { ok: true, data: { status: "ok", final_text: "Olá! Posso ajudar.", ferramentas: [], tool_calls: [], guardrails: { ok: true }, run_id: "run-1" } };
  }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const A1 = "a1a1a1a1-0000-4000-8000-000000000001";
const A2 = "a2a2a2a2-0000-4000-8000-000000000002";

function versao(id: string, agentId: string, numero: number, status: string, prompt: string): Record<string, unknown> {
  return {
    id,
    agent_id: agentId,
    organization_id: ORG,
    version_number: numero,
    status,
    model: "claude-sonnet-5-5",
    provider: "anthropic",
    channel_session_id: null,
    voz_enabled: false,
    voz_quando: "nunca",
    created_at: "2026-11-10T00:00:00Z",
    published_at: null,
    system_prompt: prompt,
    credential_id: null,
    tool_ids: ["crm_search_contacts"],
    trigger_config: null,
    max_steps: 8,
    token_budget: 20000,
    cost_budget_cents: 50,
    history_message_window: 20,
    history_token_window: 8000,
    handoff_keywords: ["humano"],
    handoff_tool_enabled: true,
    handoff_legal_enabled: true,
    image_vision_enabled: true,
    proposal_ai_draft_enabled: false,
    cases_enabled: false,
    operator_enabled: false,
    operator_model: null,
    operator_tool_ids: [],
    pipeline_ids: [],
    knowledge_source_ids: [],
    skill_names: null,
    split_messages: true,
    split_max_chars: 600,
    inbound_debounce_ms: null,
    reply_min_interval_ms: null,
    followup: null,
  };
}

function ctxFalso(): McpContext {
  const from = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let inFiltro: { k: string; ids: unknown[] } | null = null;
    const linhas = () => {
      const base = tabela === "ai_agents" ? h.agentes : tabela === "ai_agent_versions" ? h.versoes : [];
      return base.filter(
        (l) =>
          Object.entries(filtros).every(([k, v]) => l[k] === v) &&
          (inFiltro === null || inFiltro.ids.includes(l[inFiltro.k])),
      );
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      eq: (k: string, v: unknown) => {
        if (k === "organization_id") h.filtrosDeOrg.push({ tabela, org: v });
        filtros[k] = v;
        return chain;
      },
      in: (k: string, ids: unknown[]) => {
        inFiltro = { k, ids };
        return chain;
      },
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => ok({ data: linhas(), error: null }),
    };
    return chain;
  };
  return {
    organizationId: ORG,
    role: "admin",
    actor: { type: "api_token", id: "tok-1", role: "admin" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: { from } as unknown as McpContext["supabase"],
  } as McpContext;
}

beforeEach(() => {
  h.filtrosDeOrg = [];
  h.salvos = [];
  h.publicados = [];
  h.testados = [];
  h.agentes = [
    { id: A1, organization_id: ORG, name: "Atendente IA", kind: "inbox_agent", archived_at: null, paused_at: null, published_version_id: "v1-pub" },
    { id: A2, organization_id: ORG, name: "Atendente IA – Instagram", kind: "inbox_agent", archived_at: null, paused_at: null, published_version_id: "v2-pub" },
  ];
  h.versoes = [
    versao("v1-pub", A1, 25, "published", "Você é o atendente. Responda em português. Nunca invente preço."),
    versao("v1-rasc", A1, 26, "draft", "RASCUNHO EM ANDAMENTO. Responda em português. Nunca invente preço."),
    versao("v2-pub", A2, 12, "published", "Você é o atendente do Instagram. Responda em português. Seja breve."),
  ];
});

describe("todas as ferramentas de editar assistente pedem admin", () => {
  it("papel admin e o escopo certo (leitura: mcp:read; escrita: mcp:write)", async () => {
    const m = await import("./agentes");
    const ferramentas = [
      m.crmListAiAgents,
      m.crmGetAiAgentVersion,
      m.crmGetAiAgentTurn,
      m.crmSaveAiAgentDraft,
      m.crmTestAiAgentVersion,
      m.crmPublishAiAgentVersion,
      m.crmRollbackAiAgent,
    ];
    for (const f of ferramentas) {
      expect(f.requiresRole, f.name).toBe("admin");
      expect(f.requiresScope, f.name).toBe(f.category === "read" ? "mcp:read" : "mcp:write");
    }
  });
});

describe("crm_save_ai_agent_draft", () => {
  it("parte do rascunho vigente quando existe, e só o prompt muda", async () => {
    const { crmSaveAiAgentDraft } = await import("./agentes");
    const r = (await crmSaveAiAgentDraft.handler(
      { agent_ids: [A1], substituicoes: [{ procurar: "Responda em português.", substituir_por: "Responda no idioma do cliente." }] },
      ctxFalso(),
    )) as { resultados: Array<Record<string, unknown>> };
    expect(r.resultados[0]).toMatchObject({ ok: true, partiu_de: { versao: 26, era: "rascunho" } });
    const payload = h.salvos[0]!.payload;
    expect(payload.system_prompt).toBe("RASCUNHO EM ANDAMENTO. Responda no idioma do cliente. Nunca invente preço.");
    // Tudo o mais é cópia da versão de partida.
    expect(payload).toMatchObject({ model: "claude-sonnet-5-5", tool_ids: ["crm_search_contacts"], handoff_keywords: ["humano"], split_max_chars: 600 });
    expect(payload).not.toHaveProperty("status");
  });

  it("vários assistentes: cada um com o seu rascunho; o que falha não derruba o outro", async () => {
    const { crmSaveAiAgentDraft } = await import("./agentes");
    const r = (await crmSaveAiAgentDraft.handler(
      { agent_ids: [A1, A2], substituicoes: [{ procurar: "Nunca invente preço.", substituir_por: "Nunca invente preço nem prazo." }] },
      ctxFalso(),
    )) as { resultados: Array<Record<string, unknown>> };
    expect(r.resultados.find((x) => x.agent_id === A1)).toMatchObject({ ok: true });
    // O do Instagram não tem o trecho: recusado SEM gravar.
    expect(r.resultados.find((x) => x.agent_id === A2)).toMatchObject({ ok: false, erro: "trecho_nao_encontrado" });
    expect(h.salvos.map((s) => s.agentId)).toEqual([A1]);
  });

  it("sem rascunho, parte da publicada", async () => {
    const { crmSaveAiAgentDraft } = await import("./agentes");
    const r = (await crmSaveAiAgentDraft.handler({ agent_ids: [A2], anexar_ao_final: "Use no máximo duas frases." }, ctxFalso())) as {
      resultados: Array<Record<string, unknown>>;
    };
    expect(r.resultados[0]).toMatchObject({ ok: true, partiu_de: { versao: 12, era: "publicada" } });
    expect(h.salvos[0]!.payload.system_prompt).toMatch(/Seja breve\.\n\nUse no máximo duas frases\.$/);
  });

  it("só configuração: o texto fica igual e a voz liga no rascunho", async () => {
    const { crmSaveAiAgentDraft } = await import("./agentes");
    const r = (await crmSaveAiAgentDraft.handler(
      { agent_ids: [A2], configuracoes: { voz_ligada: true, voz_quando: "espelhar" } },
      ctxFalso(),
    )) as { resultados: Array<Record<string, unknown>> };
    expect(r.resultados[0]).toMatchObject({ ok: true, configuracoes_alteradas: ["voz_ligada", "voz_quando"] });
    expect(h.salvos[0]!.payload).toMatchObject({
      voz_enabled: true,
      system_prompt: "Você é o atendente do Instagram. Responda em português. Seja breve.",
    });
  });

  it("pedido sem texto nem configuração é recusado antes de ler o banco", async () => {
    const { crmSaveAiAgentDraft } = await import("./agentes");
    const r = (await crmSaveAiAgentDraft.handler({ agent_ids: [A1] }, ctxFalso())) as Record<string, unknown>;
    expect(r.erro).toBe("pedido_vazio");
    expect(h.salvos).toHaveLength(0);
  });

  it("nada salvo em nenhum: a chamada inteira é recusa (o audit não registra sucesso)", async () => {
    const { crmSaveAiAgentDraft } = await import("./agentes");
    const r = (await crmSaveAiAgentDraft.handler(
      { agent_ids: [A2], substituicoes: [{ procurar: "texto que não existe", substituir_por: "x" }] },
      ctxFalso(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("trecho_nao_encontrado");
    expect(h.salvos).toHaveLength(0);
  });

  it("assistente de outra organização não é encontrado — a organização vem do contexto", async () => {
    h.agentes[1]!.organization_id = "22222222-2222-4222-8222-222222222222";
    const { crmSaveAiAgentDraft } = await import("./agentes");
    const r = (await crmSaveAiAgentDraft.handler({ agent_ids: [A2], anexar_ao_final: "Regra nova." }, ctxFalso())) as Record<string, unknown>;
    expect(r.erro).toBe("assistente_nao_encontrado");
    expect(h.salvos).toHaveLength(0);
    expect(h.filtrosDeOrg.every((f) => f.org === ORG)).toBe(true);
  });
});

describe("crm_test_ai_agent_version", () => {
  it("testa o RASCUNHO por padrão e devolve a resposta simulada", async () => {
    const { crmTestAiAgentVersion } = await import("./agentes");
    const r = (await crmTestAiAgentVersion.handler(
      { agent_id: A1, versao: "rascunho", mensagem: "Quanto custa?" },
      ctxFalso(),
    )) as Record<string, unknown>;
    expect(h.testados).toEqual([{ versionId: "v1-rasc", mensagem: "Quanto custa?" }]);
    expect(r).toMatchObject({ versao: 26, resposta: "Olá! Posso ajudar." });
  });

  it("sem rascunho, recusa e aponta o caminho — não testa a publicada às escondidas", async () => {
    const { crmTestAiAgentVersion } = await import("./agentes");
    const r = (await crmTestAiAgentVersion.handler({ agent_id: A2, versao: "rascunho", mensagem: "Oi" }, ctxFalso())) as Record<string, unknown>;
    expect(r.erro).toBe("versao_nao_encontrada");
    expect(h.testados).toHaveLength(0);
  });
});

describe("crm_publish_ai_agent_version e crm_rollback_ai_agent", () => {
  it("publica o número pedido e devolve o anterior", async () => {
    const { crmPublishAiAgentVersion } = await import("./agentes");
    h.versoes.push({ ...versao("v-pub", A1, 25, "superseded", "x".repeat(20)) });
    const r = (await crmPublishAiAgentVersion.handler({ agent_id: A1, versao: 26 }, ctxFalso())) as Record<string, unknown>;
    expect(h.publicados).toEqual([{ agentId: A1, versionId: "v1-rasc" }]);
    expect(r).toMatchObject({ publicada: 26, anterior: 25 });
  });

  it("recusa republicar a que já está valendo", async () => {
    const { crmPublishAiAgentVersion } = await import("./agentes");
    const r = (await crmPublishAiAgentVersion.handler({ agent_id: A1, versao: 25 }, ctxFalso())) as Record<string, unknown>;
    expect(r.erro).toBe("ja_publicada");
    expect(h.publicados).toHaveLength(0);
  });

  it("reverter traduz número em versão e devolve o número novo", async () => {
    const { crmRollbackAiAgent } = await import("./agentes");
    h.versoes.push({ ...versao("v-new", A1, 30, "published", "x".repeat(20)) });
    const r = (await crmRollbackAiAgent.handler({ agent_id: A1, para_versao: 25 }, ctxFalso())) as Record<string, unknown>;
    expect(r).toMatchObject({ copiada_de: 25, nova_versao_publicada: 30 });
  });
});
