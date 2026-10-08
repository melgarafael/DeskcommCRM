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
// A tabela de nonces queimados, em memória: a chave primária do banco vira um
// Set, e a segunda inserção do mesmo nonce devolve o `23505` do Postgres.
const noncesQueimados = vi.hoisted(() => new Set<string>());
const falhaDoBanco = vi.hoisted(() => ({ codigo: null as string | null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      insert: async (linha: { nonce: string }) => {
        if (tabela !== "calendar_oauth_nonces") throw new Error(`tabela inesperada: ${tabela}`);
        if (falhaDoBanco.codigo) return { error: { code: falhaDoBanco.codigo } };
        if (noncesQueimados.has(linha.nonce)) return { error: { code: "23505" } };
        noncesQueimados.add(linha.nonce);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Map<string, string>() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const jwtVerify = vi.hoisted(() =>
  vi.fn(async (_token: string, _jwks: unknown, _opcoes: unknown): Promise<{ payload: Record<string, unknown> }> => ({
    payload: { nonce: "nonce-test", sub: "siwc-subject" },
  })),
);
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify,
}));
vi.mock("@/lib/ai/credenciais/host-siwc", () => ({
  lerOuCriarHostIdSiwc: vi.fn(async () => "urn:uuid:host-test"),
}));

const guardar = vi.hoisted(() => vi.fn(async (_p: unknown) => ({ ok: true as const, id: "cred-1" })));
vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  guardarLoginCodex: guardar,
  desconectarLoginCodex: vi.fn(async () => true),
  lerLoginCodex: vi.fn(async () => null),
}));

const trocar = vi.hoisted(() =>
  vi.fn(async (_e: { code: string; codeVerifier: string; clientId: string }) => ({
    access_token: "at",
    refresh_token: "rt",
    id_token: "signed-id-token",
    scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
    expires_at: null,
  })),
);
vi.mock("@/lib/ai/pontos/pkce-da-assinatura", async (importOriginal) => ({
  ...(await importOriginal<typeof PkceDaAssinatura>()),
  trocarCodigoPorTokens: trocar,
}));

import { conectarLoginCodex } from "@/app/actions/settings/conectarLoginCodex";
import { audit } from "@/lib/audit";
import { lerLoginCodex } from "@/lib/ai/credenciais/login-codex";
import { emitirEstado } from "@/lib/agenda/google/estado";
import { CLIENTE_DINAMICO_SIWC, lerRetornoColado } from "@/lib/ai/pontos/pkce-da-assinatura";

const VERIFIER = "v".repeat(60);

function estadoPara(organizationId: string, userId: string, segredo = SEGREDO): string {
  return emitirEstado({ organizationId, userId, authSessionId: CLIENTE_DINAMICO_SIWC }, { segredo, agora: new Date(), nonce: "nonce-test" });
}

function retorno(code: string, state: string): string {
  return `http://127.0.0.1:1455/auth/callback?code=${encodeURIComponent(code)}&client_id=dynamic-client-test&scope=openid&state=${encodeURIComponent(state)}`;
}

beforeEach(() => {
  noncesQueimados.clear();
  falhaDoBanco.codigo = null;
  trocar.mockClear();
  guardar.mockClear();
  vi.mocked(audit).mockClear();
  jwtVerify.mockClear();
  vi.mocked(lerLoginCodex).mockResolvedValue(null);
});

describe("lerRetornoColado", () => {
  it("tira code e state do endereço inteiro, e da parte depois do ?", () => {
    expect(lerRetornoColado(" " + retorno("c-1", "s-1") + " ")).toEqual({ code: "c-1", state: "s-1", clientId: "dynamic-client-test" });
    expect(lerRetornoColado("code=c-2&state=s-2")).toEqual({ code: "c-2", state: "s-2" });
  });

  it("código solto, ou endereço sem state, não é retorno", () => {
    expect(lerRetornoColado("ac_soltinho")).toBeNull();
    expect(lerRetornoColado("http://127.0.0.1:1455/auth/callback?code=c-3")).toBeNull();
  });
});

describe("conectarLoginCodex confere o state antes de trocar o código", () => {
  it("o retorno do link DESTA pessoa, NESTA empresa, troca só o code (não o endereço)", async () => {
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: true });
    expect(trocar).toHaveBeenCalledTimes(1);
    expect(trocar.mock.calls[0]![0]).toMatchObject({ code: "code-bom", codeVerifier: VERIFIER, clientId: "dynamic-client-test" });
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

/**
 * OS RAMOS NOVOS DE SEGURANÇA DO SIGN IN WITH CHATGPT (#2456, doc 112 opção A).
 *
 * O `state` acima prova QUEM abriu o link. Estes casos provam o que o retorno
 * traz: que a identidade foi assinada pela OpenAI PARA ESTE cliente (issuer e
 * audience), que é a resposta DESTA tentativa (nonce do state), que o plano
 * foi autorizado (escopos), que o client_id é o registrado, e que a conta
 * ligada à empresa não é trocada em silêncio por outra.
 *
 * Em todos os recusados, nada é gravado. Sabotagens que confirmam (uma por
 * vez): tirar `audience` do `jwtVerify`; tirar a comparação do nonce; tirar
 * qualquer um dos dois `includes` de escopo; tirar a comparação de
 * `retorno.clientId`; tirar a guarda de `conta_diferente` — cada uma deixa
 * vermelho o caso de mesmo nome.
 */
function estadoComCliente(authSessionId: string): string {
  return emitirEstado(
    { organizationId: ORG, userId: PESSOA, authSessionId },
    { segredo: SEGREDO, agora: new Date(), nonce: "nonce-test" },
  );
}

function retornoComCliente(state: string, clientId?: string): string {
  const cliente = clientId ? `&client_id=${encodeURIComponent(clientId)}` : "";
  return `http://127.0.0.1:1455/auth/callback?code=code-bom${cliente}&state=${encodeURIComponent(state)}`;
}

const tokensBons = {
  access_token: "at-segredo-de-acesso",
  refresh_token: "rt-segredo-de-renovacao",
  id_token: "signed-id-token",
  scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
  expires_at: null,
};

describe("conectarLoginCodex confere a identidade, o plano e o cliente devolvidos", () => {
  it("a assinatura do id_token é conferida contra o emissor da OpenAI e ESTE client_id", async () => {
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: true });
    expect(jwtVerify).toHaveBeenCalledTimes(1);
    const [token, , opcoes] = jwtVerify.mock.calls[0]!;
    expect(token).toBe("signed-id-token");
    expect(opcoes).toMatchObject({ issuer: "https://auth.openai.com", audience: "dynamic-client-test" });
  });

  it("id_token com assinatura inválida é recusado e nada é gravado", async () => {
    jwtVerify.mockRejectedValueOnce(new Error("signature verification failed"));
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "identidade_invalida" });
    expect(guardar).not.toHaveBeenCalled();
  });

  it("nonce do id_token diferente do nonce do state é recusado (resposta de outra tentativa)", async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: { nonce: "nonce-de-outra-tentativa", sub: "siwc-subject" },
    });
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "identidade_invalida" });
    expect(guardar).not.toHaveBeenCalled();
  });

  it("id_token sem `sub` é recusado — sem ele não há como saber de quem é a conta", async () => {
    jwtVerify.mockResolvedValueOnce({
      payload: { nonce: "nonce-test" },
    });
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "identidade_invalida" });
    expect(guardar).not.toHaveBeenCalled();
  });

  it.each([
    ["sem o escopo do plano (chatgpt.tokens.use.direct)", { scopes: ["resource.invoke"] }],
    ["sem o escopo de invocação (resource.invoke)", { scopes: ["chatgpt.tokens.use.direct"] }],
    ["sem id_token", { id_token: undefined }],
  ])("troca %s é recusada como plano não autorizado", async (_nome, troca) => {
    trocar.mockResolvedValueOnce({ ...tokensBons, ...troca } as typeof tokensBons);
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "plano_nao_autorizado" });
    expect(guardar).not.toHaveBeenCalled();
  });

  it("client_id do retorno diferente do registrado no state é recusado, sem chamar a OpenAI", async () => {
    const r = await conectarLoginCodex({
      codigo: retornoComCliente(estadoComCliente("cliente-registrado"), "cliente-de-outra-conta"),
      codeVerifier: VERIFIER,
    });
    expect(r).toEqual({ ok: false, error: "registro_incompleto" });
    expect(trocar).not.toHaveBeenCalled();
  });

  it("primeiro registro sem o client_id emitido no retorno é recusado, sem chamar a OpenAI", async () => {
    const r = await conectarLoginCodex({
      codigo: retornoComCliente(estadoComCliente(CLIENTE_DINAMICO_SIWC)),
      codeVerifier: VERIFIER,
    });
    expect(r).toEqual({ ok: false, error: "registro_incompleto" });
    expect(trocar).not.toHaveBeenCalled();
  });

  it("reautorização usa o client_id registrado no state, não o que o retorno trouxer", async () => {
    const r = await conectarLoginCodex({
      codigo: retornoComCliente(estadoComCliente("cliente-registrado")),
      codeVerifier: VERIFIER,
    });
    expect(r).toEqual({ ok: true });
    expect(trocar.mock.calls[0]![0]).toMatchObject({ clientId: "cliente-registrado" });
    expect(jwtVerify.mock.calls[0]![2]).toMatchObject({ audience: "cliente-registrado" });
  });

  it("conta ChatGPT diferente da que a empresa já tem ligada é recusada, e a ligada fica", async () => {
    vi.mocked(lerLoginCodex).mockResolvedValueOnce({
      ...tokensBons,
      client_id: "dynamic-client-test",
      subject: "conta-ja-ligada",
    });
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "conta_diferente" });
    expect(guardar).not.toHaveBeenCalled();
  });

  it("consentimento recusado na OpenAI não chega à troca", async () => {
    const r = await conectarLoginCodex({
      codigo: `http://127.0.0.1:1455/auth/callback?error=access_denied&state=${encodeURIComponent(estadoPara(ORG, PESSOA))}`,
      codeVerifier: VERIFIER,
    });
    expect(r).toEqual({ ok: false, error: "consentimento_recusado" });
    expect(trocar).not.toHaveBeenCalled();
  });
});

/**
 * O RETORNO VALE UMA VEZ SÓ (#2456, terceira passada).
 *
 * O `state` assinado vale 10 minutos, e sem queimar o nonce o mesmo retorno
 * era aceito de novo dentro desse prazo. Sabotagem que confirma: tirar o
 * `insert` em `calendar_oauth_nonces` (ou ignorar o erro dele) deixa os dois
 * casos abaixo vermelhos, porque a segunda troca passa a ser chamada.
 */
describe("conectarLoginCodex queima o nonce do state antes da troca", () => {
  it("o MESMO retorno colado de novo é recusado, sem chamar a OpenAI uma segunda vez", async () => {
    const colado = retorno("code-bom", estadoPara(ORG, PESSOA));
    expect(await conectarLoginCodex({ codigo: colado, codeVerifier: VERIFIER })).toEqual({ ok: true });
    expect(trocar).toHaveBeenCalledTimes(1);

    const segunda = await conectarLoginCodex({ codigo: colado, codeVerifier: VERIFIER });
    expect(segunda).toEqual({ ok: false, error: "estado_invalido" });
    expect(trocar).toHaveBeenCalledTimes(1);
    expect(guardar).toHaveBeenCalledTimes(1);
  });

  it("o nonce é queimado mesmo quando a troca falha: a segunda tentativa com o mesmo state recusa", async () => {
    trocar.mockRejectedValueOnce(new Error("invalid_grant"));
    const colado = retorno("code-bom", estadoPara(ORG, PESSOA));
    expect(await conectarLoginCodex({ codigo: colado, codeVerifier: VERIFIER })).toEqual({ ok: false, error: "troca_recusada" });
    expect(await conectarLoginCodex({ codigo: colado, codeVerifier: VERIFIER })).toEqual({ ok: false, error: "estado_invalido" });
    expect(trocar).toHaveBeenCalledTimes(1);
  });

  it("sem conseguir gravar o nonce, recusa (falha fechada) e não troca", async () => {
    falhaDoBanco.codigo = "08006";
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "banco" });
    expect(trocar).not.toHaveBeenCalled();
  });
});

describe("os tokens não saem da action", () => {
  it("o sucesso não devolve token, e a auditoria não leva token nenhum", async () => {
    trocar.mockResolvedValueOnce(tokensBons);
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: true });
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    const rastro = JSON.stringify(vi.mocked(audit).mock.calls);
    for (const segredo of ["at-segredo-de-acesso", "rt-segredo-de-renovacao", "signed-id-token", "code-bom", VERIFIER]) {
      expect(rastro).not.toContain(segredo);
    }
  });

  it("a falha da troca devolve só o código do erro, nunca a mensagem do provedor", async () => {
    trocar.mockRejectedValueOnce(new Error("invalid_grant rt-segredo-de-renovacao"));
    const r = await conectarLoginCodex({ codigo: retorno("code-bom", estadoPara(ORG, PESSOA)), codeVerifier: VERIFIER });
    expect(r).toEqual({ ok: false, error: "troca_recusada" });
    expect(JSON.stringify(r)).not.toContain("segredo");
  });
});

