/**
 * O editor legado de `rag_bot` só grava o rascunho — sem publish, o runtime
 * (que lê `ai_agents.published_version_id` → `ai_agent_versions`) nunca via a
 * mudança. Este teste cobre só o mapeamento de erro do wrapper: a função SQL
 * em si é exercitada em `tests/invariants` (test:db), não aqui.
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { publishRagBotVersion } from "./publish-rag-bot";

function adminComRpc(resposta: { data: unknown; error: { message: string } | null }) {
  return { rpc: vi.fn().mockResolvedValue(resposta) } as unknown as SupabaseClient;
}

describe("publishRagBotVersion", () => {
  it("mapeia sucesso pra RagBotPublishOk", async () => {
    const admin = adminComRpc({
      data: [
        {
          agent_id: "agent-1",
          version_id: "version-2",
          previous_version_id: "version-1",
          published_at: "2026-08-22T20:00:00Z",
        },
      ],
      error: null,
    });

    const result = await publishRagBotVersion(admin, {
      orgId: "org-1",
      agentId: "agent-1",
      createdBy: "user-1",
    });

    expect(result).toEqual({
      ok: true,
      agent_id: "agent-1",
      version_id: "version-2",
      previous_version_id: "version-1",
      published_at: "2026-08-22T20:00:00Z",
    });
  });

  it("mapeia erro conhecido (P0001) pro código estável, sem virar internal_error", async () => {
    const admin = adminComRpc({ data: null, error: { message: "agent_kind_invalid" } });

    const result = await publishRagBotVersion(admin, {
      orgId: "org-1",
      agentId: "agent-mcp",
      createdBy: null,
    });

    expect(result).toEqual({
      ok: false,
      code: "agent_kind_invalid",
      message: "agent_kind_invalid",
    });
  });

  it("mapeia erro NÃO catalogado pra internal_error, sem vazar a mensagem crua como código", async () => {
    const admin = adminComRpc({
      data: null,
      error: { message: "relation ai_agent_versions does not exist" },
    });

    const result = await publishRagBotVersion(admin, {
      orgId: "org-1",
      agentId: "agent-1",
      createdBy: null,
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("internal_error");
  });

  it("trata resposta sem linha (RPC ok mas array vazio) como internal_error, não como sucesso vazio", async () => {
    const admin = adminComRpc({ data: [], error: null });

    const result = await publishRagBotVersion(admin, {
      orgId: "org-1",
      agentId: "agent-1",
      createdBy: null,
    });

    expect(result).toEqual({ ok: false, code: "internal_error", message: "no_row_returned" });
  });
});
