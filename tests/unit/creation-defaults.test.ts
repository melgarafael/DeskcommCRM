import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
const fallback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prospecting/agent-setup", () => ({
  resolveSetupModel: fallback,
  AgentSetupError: class extends Error {},
}));
import { resolveAgentCreationDefaults } from "@/lib/ai/agents/creation-defaults";
import { AgentSetupError } from "@/lib/prospecting/agent-setup";

describe("AI defaults for new agents", () => {
  it("uses a managed tool-capable model without a tenant credential or secret", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { model_id: "no-tools", supports_tools: false, is_default_for_provider: true },
        { model_id: "curated", supports_tools: true, is_default_for_provider: true },
      ],
    });
    const result = await resolveAgentCreationDefaults(
      { query } as unknown as pg.PoolClient,
      "org-one",
      ["openai"],
    );
    expect(result).toEqual({ provider: "openai", model: "curated", credential_id: null });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("deprecated_at is null"), [
      "openai",
    ]);
  });
  it("retains the org fallback when no managed catalog model is available", async () => {
    fallback.mockResolvedValueOnce({
      provider: "anthropic",
      model: "company-model",
      credential_id: "company-credential",
    });
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as pg.PoolClient;
    expect(await resolveAgentCreationDefaults(db, "org-two", ["openai"])).toEqual({
      provider: "anthropic",
      model: "company-model",
      credential_id: "company-credential",
    });
    expect(fallback).toHaveBeenLastCalledWith(db, "org-two");
  });
  it("distinguishes incomplete setup from an actual database failure", async () => {
    const db = {} as pg.PoolClient;
    fallback.mockRejectedValueOnce(new AgentSetupError("setup pending"));
    expect(await resolveAgentCreationDefaults(db, "org", [])).toBeNull();
    fallback.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(resolveAgentCreationDefaults(db, "org", [])).rejects.toThrow(
      "database unavailable",
    );
  });
});
