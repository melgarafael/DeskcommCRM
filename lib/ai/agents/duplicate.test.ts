/**
 * O defeito: duplicar um mcp_agent pela lista devolvia um agente em branco —
 * a cópia rasa levava só a linha de `ai_agents`, e tudo que define o agente
 * (prompt, ferramentas, credencial, canal, handoff, budgets, follow-up) mora em
 * `ai_agent_versions`.
 */
import { describe, it, expect } from "vitest";

import { duplicateAgentWithVersion } from "./duplicate";

const ORG = "org-1";
const ACTOR = "user-1";

const AGENTE_MCP = {
  id: "agent-1",
  organization_id: ORG,
  name: "Suporte",
  description: "desc",
  model: "claude-sonnet-4-6",
  system_prompt: "prompt do agente",
  kind: "mcp_agent",
  priority: 10,
  config: {},
  guardrails: null,
  active_kb_version_id: null,
};

const VERSAO_PUBLICADA = {
  id: "version-1",
  organization_id: ORG,
  agent_id: "agent-1",
  version_number: 7,
  system_prompt: "prompt da versao",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  credential_id: "cred-1",
  tool_ids: ["crm_get_lead", "crm_move_lead_stage", "crm_request_human_handoff"],
  trigger_config: { events: ["message"] },
  channel_session_id: "chan-1",
  max_steps: 12,
  token_budget: 60000,
  cost_budget_cents: 80,
  history_message_window: 30,
  history_token_window: 10000,
  handoff_keywords: ["falar com humano", "atendente"],
  handoff_tool_enabled: true,
  cases_enabled: true,
  split_messages: true,
  split_max_chars: 240,
  followup: { enabled: true, flow_pointer_ids: ["pointer-1"], callback_enabled: false },
  status: "published",
  published_at: "2026-07-31T00:00:00Z",
  superseded_at: null,
  created_at: "2026-07-01T00:00:00Z",
  created_by: "someone",
};

/** Fake mínimo do supabase-js: guarda os inserts para inspeção. */
function makeDb(opts: { agent: unknown; draft?: unknown; published?: unknown }) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

  function builder(table: string) {
    const state: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        state[col] = val;
        return api;
      },
      order: () => api,
      limit: () => api,
      update: () => api,
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        const id = table === "ai_agents" ? "novo-agente" : "nova-versao";
        return {
          select: () => ({ single: async () => ({ data: { ...row, id }, error: null }) }),
        };
      },
      maybeSingle: async () => {
        if (table === "ai_agents") return { data: opts.agent, error: null };
        if (state.status === "draft") return { data: opts.draft ?? null, error: null };
        if (state.status === "published") return { data: opts.published ?? null, error: null };
        return { data: null, error: null };
      },
    };
    return api;
  }

  return { db: { from: (t: string) => builder(t) } as never, inserts };
}

describe("duplicateAgentWithVersion", () => {
  it("mcp_agent: copia a versão inteira, não só a casca", async () => {
    const { db, inserts } = makeDb({ agent: AGENTE_MCP, published: VERSAO_PUBLICADA });

    const res = await duplicateAgentWithVersion(db, {
      orgId: ORG,
      agentId: "agent-1",
      actorUserId: ACTOR,
      requireVersion: false,
    });

    expect(res.ok).toBe(true);
    const versao = inserts.find((i) => i.table === "ai_agent_versions");
    expect(versao, "a versão precisa ser inserida — sem ela a cópia é uma casca").toBeDefined();

    // O que o usuário perdia na cópia rasa:
    expect(versao!.row.tool_ids).toEqual(VERSAO_PUBLICADA.tool_ids);
    expect(versao!.row.handoff_keywords).toEqual(VERSAO_PUBLICADA.handoff_keywords);
    expect(versao!.row.cases_enabled).toBe(true);
    // Flags por-agente que a tela edita: o teste de drift vigia o SELECT, mas
    // quem escreve a linha nova é `versionPayloadFrom`. Coluna presente no SELECT
    // e ausente do INSERT faz a cópia nascer com o default — o toggle "some".
    expect(versao!.row.split_messages).toBe(true);
    expect(versao!.row.split_max_chars).toBe(240);
    expect(versao!.row.followup).toEqual(VERSAO_PUBLICADA.followup);
    expect((versao!.row.followup as { callback_enabled: boolean }).callback_enabled).toBe(false);
    expect(versao!.row.credential_id).toBe("cred-1");
    expect(versao!.row.channel_session_id).toBe("chan-1");
    expect(versao!.row.system_prompt).toBe("prompt da versao");
  });

  it("a cópia nasce como draft v1 e fora do ar", async () => {
    const { db, inserts } = makeDb({ agent: AGENTE_MCP, published: VERSAO_PUBLICADA });
    await duplicateAgentWithVersion(db, {
      orgId: ORG,
      agentId: "agent-1",
      actorUserId: ACTOR,
      requireVersion: false,
    });

    const versao = inserts.find((i) => i.table === "ai_agent_versions")!;
    expect(versao.row.status).toBe("draft");
    expect(versao.row.version_number).toBe(1);
    // published_at/superseded_at da origem não podem vazar para a cópia
    expect(versao.row.published_at).toBeUndefined();
    expect(versao.row.superseded_at).toBeUndefined();

    const agente = inserts.find((i) => i.table === "ai_agents")!;
    expect(agente.row.published_version_id).toBeUndefined();
    expect(agente.row.is_default).toBe(false);
    expect(agente.row.name).toBe("Suporte (cópia)");
  });

  it("prefere a draft mais recente à published", async () => {
    const draft = { ...VERSAO_PUBLICADA, id: "version-2", status: "draft", system_prompt: "rascunho novo" };
    const { db, inserts } = makeDb({ agent: AGENTE_MCP, draft, published: VERSAO_PUBLICADA });

    await duplicateAgentWithVersion(db, {
      orgId: ORG,
      agentId: "agent-1",
      actorUserId: ACTOR,
      requireVersion: false,
    });

    const versao = inserts.find((i) => i.table === "ai_agent_versions")!;
    expect(versao.row.system_prompt).toBe("rascunho novo");
  });

  it("rag_bot legado sem versão nasce mcp_agent + v1 draft, não casca", async () => {
    const ragBot = { ...AGENTE_MCP, kind: "rag_bot" };
    const { db, inserts } = makeDb({ agent: ragBot });

    const res = await duplicateAgentWithVersion(db, {
      orgId: ORG,
      agentId: "agent-1",
      actorUserId: ACTOR,
      requireVersion: false,
    });

    expect(res.ok).toBe(true);

    // Antes (#1357): `kind: "rag_bot"` e NENHUMA linha em `ai_agent_versions` —
    // um clone que os dois runtimes resolvem por `published_version_id` não
    // enxergam. Duplicar clonava um mudo.
    const agente = inserts.find((i) => i.table === "ai_agents")!;
    expect(agente.row.kind).toBe("mcp_agent");

    const versao = inserts.find((i) => i.table === "ai_agent_versions");
    expect(versao, "sem a v1 a cópia é a casca que este módulo existe para não produzir").toBeDefined();
    expect(versao!.row.status).toBe("draft");
    expect(versao!.row.version_number).toBe(1);
    // A ponte do formato legado: `model` vira provider/modelo e os dois nulos
    // que o corpo legado nunca teve.
    expect(versao!.row.provider).toBe("anthropic");
    expect(versao!.row.model).toBe("claude-sonnet-4-6");
    expect(versao!.row.credential_id).toBeNull();
    expect(versao!.row.channel_session_id).toBeNull();
    expect(versao!.row.system_prompt).toBe("prompt do agente");
    // Não é cópia de versão nenhuma — a origem não tinha.
    if (!res.ok) throw new Error(`duplicacao falhou: ${res.message ?? res.error}`);
    expect(res.sourceVersionId).toBeNull();
  });

  it("rag_bot legado com prompt que a v1 recusa: recusa sem gravar, não lança", async () => {
    // Prompt abaixo do mínimo da versão (10) só existe escrito direto no banco;
    // `mcpAgentDraftRecords` usa `parse`, e sem a guarda a ZodError escapava.
    const ragBot = { ...AGENTE_MCP, kind: "rag_bot", system_prompt: "curto" };
    const { db, inserts } = makeDb({ agent: ragBot });

    const res = await duplicateAgentWithVersion(db, {
      orgId: ORG,
      agentId: "agent-1",
      actorUserId: ACTOR,
      requireVersion: false,
    });

    expect(res).toMatchObject({ ok: false, error: "agent_insert_failed" });
    expect(inserts).toHaveLength(0);
  });

  it("rota da API: mcp_agent sem versão é conflito, não casca", async () => {
    const { db } = makeDb({ agent: AGENTE_MCP });

    const res = await duplicateAgentWithVersion(db, {
      orgId: ORG,
      agentId: "agent-1",
      actorUserId: ACTOR,
      requireVersion: true,
    });

    expect(res).toEqual({ ok: false, error: "no_version_to_duplicate" });
  });
});
