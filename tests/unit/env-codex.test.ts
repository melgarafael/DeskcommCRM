import { describe, expect, it } from "vitest";

import { loadEnv } from "@/lib/agent-engine/env";

const MINIMO: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  SUPABASE_DB_URL: "postgresql://u:p@localhost:5432/db",
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

describe("env Codex", () => {
  it("ausente = undefined (não derruba boot)", () => {
    const env = loadEnv(MINIMO);
    expect(env.OPENAI_CODEX_CLIENT_ID).toBeUndefined();
  });

  it("presente chega ao worker (a quarta irmã não some no boot)", () => {
    const env = loadEnv({ ...MINIMO, OPENAI_CODEX_CLIENT_ID: "client-123" } as never);
    expect(env.OPENAI_CODEX_CLIENT_ID).toBe("client-123");
  });

  it("vazia = ausente (padrão dos env files)", () => {
    const env = loadEnv({ ...MINIMO, OPENAI_CODEX_CLIENT_ID: "" } as never);
    expect(env.OPENAI_CODEX_CLIENT_ID).toBeUndefined();
  });
});
