import { describe, it, expect } from "vitest";

import { deriveAgentStatus } from "./AgentStatusBadge";
import type { AgentRow } from "@/hooks/ai/useAgent";

const base = {
  id: "a", organization_id: "o", name: "Atendente IA", description: null,
  model: "anthropic/claude-sonnet-4-6", system_prompt: "oi", is_active: true,
  is_default: true, kind: "rag_bot", priority: 0, published_version_id: null,
  archived_at: null, config: {}, guardrails: {}, active_kb_version_id: null,
  created_at: "", updated_at: "",
} as unknown as AgentRow;

describe("deriveAgentStatus", () => {
  it("mcp_agent sem versão publicada é RASCUNHO — a config dele vive na versão", () => {
    // O defeito de origem: o agente do onboarding aparecia como "Publicado"
    // enquanto nenhum runtime o executava. `createDefaultAgent.ts` grava
    // `kind: "mcp_agent"`, e um mcp_agent sem ponteiro não é executável por
    // motor nenhum — prompt, tools, funis e guardrails moram em
    // `ai_agent_versions`. Este é o caso que aquele conserto protegia, e ele
    // continua protegido.
    expect(deriveAgentStatus({ ...base, kind: "mcp_agent", published_version_id: null } as AgentRow)).toBe("draft");
  });

  it("rag_bot legado ATIVO e sem versão é RASCUNHO — precisa de publicação para voltar a atender", () => {
    // Todos os caminhos de atendimento exigem `published_version_id`. O
    // `is_active` legado não torna mais uma configuração sem versão executável;
    // o badge deve orientar recuperação/publicação em vez de anunciar que o
    // agente está no ar.
    expect(deriveAgentStatus({ ...base, is_active: true, published_version_id: null })).toBe("draft");
  });

  it("rag_bot legado DESATIVADO e sem versão é RASCUNHO", () => {
    expect(deriveAgentStatus({ ...base, is_active: false, published_version_id: null })).toBe("draft");
  });

  it("com versão publicada e ativo é PUBLICADO", () => {
    expect(deriveAgentStatus({ ...base, published_version_id: "v1" } as AgentRow)).toBe("published");
  });

  it("com versão publicada é PUBLICADO mesmo com is_active false — em QUALQUER kind", () => {
    // `is_active` não decide nada quando há versão publicada: nem o
    // agent-engine (`loadPublishedAgentConfig`) nem o dispatcher leem a coluna.
    // O badge dizia "Pausado" para o rag_bot nessa situação — um agente que
    // está no ar — e não oferecia saída: "Despausar" fica disabled para
    // mcp_agent, `unpauseAgentAction` recusa com publish_required, e
    // `fn_publish_ai_agent_version` não toca `is_active`.
    expect(
      deriveAgentStatus({ ...base, published_version_id: "v1", is_active: false } as AgentRow),
    ).toBe("published");
    expect(
      deriveAgentStatus({
        ...base,
        kind: "mcp_agent",
        published_version_id: "v1",
        is_active: false,
      } as AgentRow),
    ).toBe("published");
  });

  it("arquivado vence tudo", () => {
    expect(deriveAgentStatus({ ...base, archived_at: "2026-01-01", published_version_id: "v1" } as AgentRow)).toBe("archived");
  });
});
