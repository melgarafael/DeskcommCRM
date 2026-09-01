import { describe, expect, it } from "vitest";

import { loadEnv } from "./env";

/**
 * Fix 563781e congelado: var VAZIA no env = ausente (o template gera `CHAVE=`
 * e o README promete BYOK com a chave vazia). Regressão aqui = worker crasha
 * no boot de todo self-host que seguir o README.
 */
const REQUIRED: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
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

/**
 * A metade que NADA guardava. Medido: remover `OPENAI_API_KEY` deste schema não
 * reprova nenhum teste E passa no `tsc` — o parâmetro de `llmEdgeConfigFromEnv`
 * declara a chave como opcional, então um env sem ela é um tipo válido. O
 * resultado seria o bug de origem voltando em silêncio: chave no `.env`, worker
 * subindo, agente OpenAI morrendo com "org sem credencial LLM utilizável".
 */
describe("loadEnv — a chave da OpenAI existe no contrato do worker", () => {
  it("OPENAI_API_KEY é reconhecida e chega ao env do worker", () => {
    const env = loadEnv({ ...REQUIRED, OPENAI_API_KEY: "sk-proj-abc" });
    expect(env.OPENAI_API_KEY).toBe("sk-proj-abc");
  });

  it("vazia continua sendo ausente — mesmo contrato BYOK das demais", () => {
    const env = loadEnv({ ...REQUIRED, OPENAI_API_KEY: "" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

/**
 * A TERCEIRA irmã — e a pior das três para ficar de fora, porque é a opção
 * **[1]** do menu do instalador (`self-host-kit/install.sh`), a que ele
 * apresenta como o caminho mais simples.
 *
 * `llmEdgeConfigFromEnv` (edge/llm/credentials.ts) lê `env.OPENROUTER_API_KEY`
 * e `resolveOrgLlmConfig` tem o ramo `provider === 'openrouter'` — mas o
 * parâmetro declara a chave como opcional, então um env sem ela typecheca, e
 * `loadEnv` devolve `parsed.data`: o Zod REMOVE o que o schema não declara.
 * A chave existia no `.env`, sumia no boot do worker, e todo turno morria com
 * `LlmNotConfiguredError` mandando cadastrar credencial pela tela.
 *
 * Nem o `tsc` nem os testes pegavam — foi assim que a irmã da OpenAI foi
 * consertada e esta ficou. O teste abaixo é o que impede a quarta vez.
 */
describe("loadEnv — a chave da OpenRouter existe no contrato do worker", () => {
  it("OPENROUTER_API_KEY é reconhecida e chega ao env do worker", () => {
    const env = loadEnv({ ...REQUIRED, OPENROUTER_API_KEY: "sk-or-v1-abc" });
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-v1-abc");
  });

  it("vazia continua sendo ausente — mesmo contrato BYOK das demais", () => {
    const env = loadEnv({ ...REQUIRED, OPENROUTER_API_KEY: "" });
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  /**
   * O teste acima ainda passaria se `loadEnv` devolvesse o `source` cru em vez
   * do objeto parseado. Este prova que o strip do Zod está VIVO — ou seja, que
   * o primeiro caso mede a declaração no schema, e não a ausência de strip.
   */
  it("var fora do schema continua sendo removida (o strip está vivo)", () => {
    const env = loadEnv({ ...REQUIRED, VAR_QUE_NAO_EXISTE_NO_SCHEMA: "x" });
    expect("VAR_QUE_NAO_EXISTE_NO_SCHEMA" in env).toBe(false);
  });
});
