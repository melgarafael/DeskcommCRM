import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as PkceDaAssinatura from "@/lib/ai/pontos/pkce-da-assinatura";

/**
 * O `state` DO LOGIN POR ASSINATURA É CONFERIDO ANTES DA TROCA (#1672, triagem).
 *
 * A tela de Credenciais emite um `state` assinado (`emitirEstado`: HMAC com
 * `INTERNAL_SECRET`, empresa + pessoa, 10 min). A action só troca o `code` do
 * endereço colado quando o `state` desse endereço é um que ESTA instalação
 * emitiu, para ESTA pessoa, NESTA empresa. O ataque que isto fecha é o login
 * CSRF: um admin induzido a colar o retorno de login de OUTRA conta ligaria à
 * empresa uma conta ChatGPT alheia — e o agente passaria a falar por ela.
 *
 * Sabotagem que confirma a guarda: tirar a comparação de empresa/pessoa (ou a
 * verificação inteira) deixa os casos "outra pessoa", "outra empresa" e
 * "outra instalação" vermelhos, porque a troca passa a ser chamada.
 */

const { SEGREDO, ORG, PESSOA } = vi.hoisted(() => ({
  SEGREDO: "segredo-de-teste-com-mais-de-16-caracteres",
  ORG: "org-da-sessao",
  PESSOA: "pessoa-da-sessao",
}));

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: SEGREDO } }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: PESSOA, support: null })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, role: "admin" })),
}));
vi.mock("@/lib/auth/pode-administrar-empresa", () => ({ podeAdministrarEmpresa: () => true }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("next/headers", () => ({ headers: async () => new Map<string, string>() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const guardar = vi.hoisted(() => vi.fn(async (_p: unknown) => ({ ok: true as const, id: "cred-1" })));
vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  guardarLoginCodex: guardar,
  desconectarLoginCodex: vi.fn(async () => true),
}));

const trocar = vi.hoisted(() =>
  vi.fn(async (_e: { code: string; codeVerifier: string }) => ({
    access_token: "at",
    refresh_token: "rt",
    expires_at: null,
  })),
);
vi.mock("@/lib/ai/pontos/pkce-da-assinatura", async (importOriginal) => ({
  ...(await importOriginal<typeof PkceDaAssinatura>()),
  trocarCodigoPorTokens: trocar,
}));

import { conectarLoginCodex } from "@/app/actions/settings/conectarLoginCodex";
import { emitirEstado } from "@/lib/agenda/google/estado";
import { lerRetornoColado } from "@/lib/ai/pontos/pkce-da-assinatura";

const VERIFIER = "v".repeat(60);

function estadoPara(organizationId: string, userId: string, segredo = SEGREDO): string {
  return emitirEstado({ organizationId, userId }, { segredo, agora: new Date() });
}

function retorno(code: string, state: string): string {
  return `http://localhost:1455/auth/callback?code=${encodeURIComponent(code)}&scope=openid&state=${encodeURIComponent(state)}`;
}

beforeEach(() => {
  trocar.mockClear();
  guardar.mockClear();
});

describe("lerRetornoColado", () => {
  it("tira code e state do endereço inteiro, e da parte depois do ?", () => {
    expect(lerRetornoColado(" " + retorno("c-1", "s-1") + " ")).toEqual({ code: "c-1", state: "s-1" });
    expect(lerRetornoColado("code=c-2&state=s-2")).toEqual({ code: "c-2", state: "s-2" });
  });

  it("código solto, ou endereço sem state, não é retorno", () => {
    expect(lerRetornoColado("ac_soltinho")).toBeNull();
    expect(lerRetornoColado("http://localhost:1455/auth/callback?code=c-3")).toBeNull();
  });
});

describe("conectarLoginCodex confere o state antes de trocar o código", () => {
  it("o retorno do link DESTA pessoa, NESTA empresa, troca só o code (não o endereço)", async () => {
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: true });
    expect(trocar).toHaveBeenCalledTimes(1);
    expect(trocar.mock.calls[0]![0]).toMatchObject({ code: "code-bom", codeVerifier: VERIFIER });
    expect(guardar).toHaveBeenCalledTimes(1);
  });

  it("retorno de OUTRA pessoa da mesma empresa é recusado, sem chamar a OpenAI", async () => {
    const r = await conectarLoginCodex({ codigo: retorno("code-alheio", estadoPara(ORG, "outra-pessoa")), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "estado_invalido" });
    expect(trocar).not.toHaveBeenCalled();
  });

  it("retorno emitido para OUTRA empresa é recusado", async () => {
    const r = await conectarLoginCodex({ codigo: retorno("code-alheio", estadoPara("outra-org", PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "estado_invalido" });
    expect(trocar).not.toHaveBeenCalled();
  });

  it("retorno de OUTRA instalação (outro segredo) é recusado", async () => {
    const alheio = estadoPara(ORG, PESSOA, "segredo-de-outra-instalacao-qualquer");
    const r = await conectarLoginCodex({ codigo: retorno("code-alheio", alheio), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "estado_invalido" });
    expect(trocar).not.toHaveBeenCalled();
  });

  it("código solto, sem o endereço, não chega à OpenAI", async () => {
    const r = await conectarLoginCodex({ codigo: "ac_soltinho", codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "retorno_sem_estado" });
    expect(trocar).not.toHaveBeenCalled();
  });
});
