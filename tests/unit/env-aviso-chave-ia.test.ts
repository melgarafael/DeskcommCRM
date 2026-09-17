import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O BOOT SÓ SABE O QUE ESTÁ NO AMBIENTE.
 *
 * A credencial que uma organização cadastra em IA › Credenciais mora no banco e
 * só é resolvida quando o turno conhece a organização. Logo, três variáveis
 * vazias não autorizam `lib/env.ts` a concluir que o agente ficará mudo.
 *
 * Este teste prende as duas metades da regra: sem chave no ambiente o aviso é
 * informativo e não anuncia o desfecho do worker; com uma chave no ambiente o
 * aviso específico continua silencioso.
 */
const PREFIXO = "[env] Nenhuma chave de IA";

function ambienteMinimo(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://teste.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-teste");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-teste");

  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");

  // Evita misturar neste teste o aviso irmão da OpenAI, que tem contrato próprio.
  vi.stubEnv("OPENAI_API_KEY", "openai-teste");
  // Evita ruído de outro aviso de boot sem relação com esta issue.
  vi.stubEnv("IMPERSONATE_COOKIE_SECRET", "x".repeat(32));
}

async function avisosDoBoot(): Promise<string[]> {
  const avisos: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args) => {
    avisos.push(args.join(" "));
  });

  await import("@/lib/env");
  return avisos;
}

beforeEach(() => {
  vi.resetModules();
  ambienteMinimo();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("aviso de chave de IA no boot", () => {
  it("sem chave no ambiente, diz apenas o que o boot sabe", async () => {
    const avisos = await avisosDoBoot();
    const aviso = avisos.find((texto) => texto.startsWith(PREFIXO));

    expect(aviso).toBeDefined();
    expect(aviso).toContain("no ambiente");
    expect(aviso).toContain("IA › Credenciais");
    expect(aviso).not.toContain("o agente vai pular toda resposta");
    expect(aviso).not.toContain("ai_gateway_key_missing");
  });

  it("com chave no ambiente, não emite o aviso de ausência", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-teste");

    const avisos = await avisosDoBoot();

    expect(avisos.some((texto) => texto.startsWith(PREFIXO))).toBe(false);
  });
});
