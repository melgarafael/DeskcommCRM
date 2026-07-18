import { describe, expect, it } from "vitest";

import { loadEnv } from "./env";

/**
 * Fix 563781e congelado: var VAZIA no env = ausente (o template gera `CHAVE=`
 * e o README promete BYOK com a chave vazia). Regressão aqui = worker crasha
 * no boot de todo self-host que seguir o README.
 */
const REQUIRED = {
  SUPABASE_DB_URL: "postgresql://u:p@localhost:5432/db",
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

describe("loadEnv — vazio é ausente (contrato BYOK do README)", () => {
  it("ANTHROPIC_API_KEY= (vazia) é tratada como ausente — worker sobe", () => {
    const env = loadEnv({ ...REQUIRED, ANTHROPIC_API_KEY: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("opcional ausente = ok; default aplica em knob vazio", () => {
    const env = loadEnv({ ...REQUIRED, AGENT_MAX_STEPS: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AGENT_MAX_STEPS).toBe(8); // default, não NaN de coerce('')
    expect(env.AGENT_DISPATCH_CONSUMER).toBe("engine");
  });

  it("obrigatória VAZIA = erro claro nomeando a var (fail-fast preservado)", () => {
    expect(() => loadEnv({ ...REQUIRED, SUPABASE_DB_URL: "" })).toThrowError(
      /SUPABASE_DB_URL/,
    );
  });

  it("obrigatória ausente = mesmo erro claro", () => {
    const { SUPABASE_DB_URL: _omit, ...rest } = REQUIRED;
    expect(() => loadEnv(rest)).toThrowError(/SUPABASE_DB_URL/);
  });
});
